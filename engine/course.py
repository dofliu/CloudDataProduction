"""課程情境管理:教師手動套用「第 N 週情境」(docs/課程規劃_18週.md)。

每週情境定義在 scenarios/course_weeks.yaml。套用時:
  1. 依 faults 設定當週異常(clear=全部修復 / keep=沿用 / dict=注入指定異常)。
  2. 依 order_density 設定 MES 稼動率(影響待機/退化/OEE)。
  3. 記錄「資料窗起點」(sim_t + wall_t),供作業自動比對界定「這週的資料」。

只呼叫既有引擎介面(device.inject_fault / device.reset / world.mes.set_utilization),
不自存設備狀態(鐵則:狀態只在引擎)。屬教師面,API 需 auth。
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Dict, List, Optional

import yaml

# order_density → MES 稼動率(班內實際運轉比例)
DENSITY = {"light": 0.55, "normal": 0.80, "high": 0.98}


class CourseManager:
    def __init__(self, world, path: str = "scenarios/course_weeks.yaml"):
        self.world = world
        self.name: str = "課程"
        self.default_tolerance: float = 0.10
        self.weeks: Dict[int, dict] = {}
        self.current_week: Optional[int] = None
        self.window_start_sim: Optional[float] = None
        self.window_start_wall: Optional[float] = None
        self._load(path)

    def _load(self, path: str) -> None:
        try:
            data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        except Exception as exc:
            print(f"[course] 讀不到週情境檔({path}),課程情境停用:{exc}")
            data = {}
        course = data.get("course", {}) or {}
        self.name = course.get("name", self.name)
        self.default_tolerance = float(course.get("default_tolerance", 0.10))
        for w in course.get("weeks", []) or []:
            try:
                self.weeks[int(w["week"])] = w
            except (KeyError, ValueError, TypeError):
                continue

    # ── 受管(MES producer)設備 ────────────────────────────
    def _producers(self):
        return [d for d in self.world.devices.values() if getattr(d, "mes_enabled", False)]

    # ── 套用某週情境 ────────────────────────────────────────
    def apply_week(self, n: int) -> dict:
        spec = self.weeks.get(int(n))
        if spec is None:
            raise KeyError(f"未定義第 {n} 週情境")
        producers = self._producers()
        faults = spec.get("faults", "keep")

        applied_faults: List[dict] = []
        if faults != "keep":
            for d in producers:            # 乾淨基線:清掉上週注入與故障、修復退化
                d.reset()
        if isinstance(faults, dict):
            applied_faults = self._apply_fault_spec(faults, producers)

        dens = spec.get("order_density")
        if dens is not None:
            self.world.mes.set_utilization(DENSITY.get(str(dens), 1.0))

        self.current_week = int(n)
        self.window_start_sim = float(self.world.clock.now())
        self.window_start_wall = time.time()
        return {
            "applied_week": self.current_week,
            "title": spec.get("title"),
            "faults": "clear" if faults == "clear" else ("keep" if faults == "keep" else "injected"),
            "injected": applied_faults,
            "order_density": dens,
            "utilization": self.world.mes.utilization,
            "window_start_sim_t": self.window_start_sim,
        }

    def _apply_fault_spec(self, spec: dict, producers: list) -> List[dict]:
        scope = str(spec.get("scope", "random"))
        count = int(spec.get("count", 1))
        kind = str(spec.get("kind", "equipment"))
        ftype = str(spec.get("type", "gradual"))
        sev = float(spec.get("severity", 0.8))

        # 目標設備:all_companies=每間公司挑 count 台;random=全園區前 count 台(依 id 排序,可重現)
        targets = []
        if scope == "all_companies":
            by_c: Dict[str, list] = {}
            for d in producers:
                by_c.setdefault(d.company_id, []).append(d)
            for _cid, ds in by_c.items():
                ds_sorted = sorted(ds, key=lambda d: d.id)
                targets.extend(ds_sorted[:count])
        else:
            targets = sorted(producers, key=lambda d: d.id)[:count]

        out = []
        for d in targets:
            if kind == "sensor":
                tag = next((t.name for t in d.tags if t.datatype == "float32"), None)
                if tag is None:
                    continue
                ft = ftype if ftype.startswith("sensor_") else "sensor_drift"
                d.inject_fault(ft, tag, severity=sev)
                out.append({"device": d.id, "kind": "sensor", "type": ft, "target": tag, "severity": sev})
            else:
                comp = next((c.name for c in d.components.values() if c.causes_device_fault), None)
                if comp is None:
                    continue
                d.inject_fault(ftype, comp, severity=sev)
                out.append({"device": d.id, "kind": "equipment", "type": ftype, "target": comp, "severity": sev})
        return out

    # ── 視圖 ────────────────────────────────────────────────
    def status(self) -> dict:
        spec = self.weeks.get(self.current_week) if self.current_week is not None else None
        return {
            "name": self.name,
            "current_week": self.current_week,
            "title": spec.get("title") if spec else None,
            "window_start_sim_t": self.window_start_sim,
            "window_start_wall": self.window_start_wall,
            "utilization": getattr(self.world.mes, "utilization", 1.0),
            "default_tolerance": self.default_tolerance,
        }

    def list_weeks(self) -> List[dict]:
        return [
            {"week": w, "title": self.weeks[w].get("title"),
             "faults": ("clear" if self.weeks[w].get("faults") == "clear"
                        else "keep" if self.weeks[w].get("faults") == "keep" else "injected"),
             "order_density": self.weeks[w].get("order_density")}
            for w in sorted(self.weeks)
        ]
