"""課堂即時練習(比回家作業輕、課堂上做)。

流程:教師一鍵「佈題」→ 平台對某台設備套用指定狀況(健康 / 感測器故障 / 設備退化)→
學生用手機觀察 → 回答問題 → 即時批改、計入平時成績。

題目分兩層(scenarios/classroom_exercises.yaml):
  tier=simple  看/選就能答;tier=complex 要算或分析。
批改重用 api/submissions.py 的誠實 grader(對 ground-truth 容差計分),不重造:
  grade.kind=static     → 學生答案需等於 answer
           =target      → 正解 = 本次佈題實際套到的設備 id
           =submission  → 委派 submissions.grade(type=stats/oee/correlation/...),
                          device 自動填佈題設備、資料窗用「佈題以來」、答案填進 value_field。

鐵則:狀態只在引擎 —— 佈題只呼叫 device.reset / device.inject_fault / mes.set_utilization,
本類只存「目前佈了哪題」與「學生作答紀錄(平時成績)」,不自存設備狀態。
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Dict, List, Optional

import yaml

from engine.course import DENSITY

# 公開題目時會露出的欄位(隱藏 grade / answer / explain,避免洩正解)
_PUBLIC_Q_FIELDS = ("id", "tier", "prompt", "type", "choices", "unit", "hint")


class ClassroomManager:
    def __init__(self, world, submissions, path: str = "scenarios/classroom_exercises.yaml", persist=None):
        self.world = world
        self.submissions = submissions        # 重用其 grade()
        self.persist = persist
        self.name = "課堂即時練習"
        self.order: List[str] = []
        self.exercises: Dict[str, dict] = {}
        self.active: Optional[dict] = None
        self.answers: List[dict] = []
        self._seq = 0
        self._load(path)
        if persist is not None:
            saved = persist.load("classroom") or {}
            self.answers = saved.get("answers", []) or []
            self._seq = int(saved.get("seq", 0))
            self.active = saved.get("active")   # 佈題狀態重啟後沿用(設備狀態本就在引擎)

    def _load(self, path: str) -> None:
        try:
            data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        except Exception as exc:
            print(f"[classroom] 讀不到練習庫({path}),課堂練習停用:{exc}")
            data = {}
        room = data.get("classroom", {}) or {}
        self.name = room.get("name", self.name)
        for ex in room.get("exercises", []) or []:
            eid = ex.get("id")
            if not eid:
                continue
            self.order.append(eid)
            self.exercises[eid] = ex

    def _save(self) -> None:
        if self.persist is not None:
            self.persist.save("classroom", {"answers": self.answers, "seq": self._seq, "active": self.active})

    # ── 佈題(教師) ────────────────────────────────────────
    def _pick_target(self, setup: dict):
        t = setup.get("target", "auto")
        if t and t != "auto":
            return self.world.devices.get(t)
        producers = sorted((d for d in self.world.devices.values() if getattr(d, "mes_enabled", False)),
                           key=lambda d: d.id)
        if not producers:
            producers = sorted(self.world.devices.values(), key=lambda d: d.id)
        if not producers:
            return None
        running = [d for d in producers if getattr(d, "state", None) == "running"]
        return (running or producers)[0]

    def _apply(self, dev, setup: dict) -> dict:
        """對設備套用情境。乾淨基線(reset)後注入指定狀況。回傳實際套了什麼(供教師看)。"""
        dev.reset()
        cond = str(setup.get("condition", "healthy"))
        applied: dict = {"condition": cond}
        if cond == "equipment":
            comp = next((c.name for c in dev.components.values() if getattr(c, "causes_device_fault", False)), None)
            if comp:
                ftype = str(setup.get("fault_type", "gradual"))
                dev.inject_fault(ftype, comp, severity=float(setup.get("severity", 1.0)))
                applied.update(fault_type=ftype, target=comp)
        elif cond == "sensor":
            tag = setup.get("tag") or next((t.name for t in dev.tags if t.datatype == "float32"), None)
            ft = str(setup.get("fault_type", "sensor_drift"))
            if not ft.startswith("sensor_"):
                ft = "sensor_" + ft
            if tag:
                dev.inject_fault(ft, tag, severity=float(setup.get("severity", 0.9)))
                applied.update(fault_type=ft, target=tag)
        dens = setup.get("order_density")
        if dens is not None and getattr(self.world, "mes", None) is not None:
            self.world.mes.set_utilization(DENSITY.get(str(dens), 1.0))
            applied["order_density"] = dens
        return applied

    def launch(self, exercise_id: str) -> dict:
        spec = self.exercises.get(exercise_id)
        if spec is None:
            raise KeyError(f"未定義練習:{exercise_id}")
        dev = self._pick_target(spec.get("setup", {}) or {})
        if dev is None:
            raise ValueError("找不到可用的設備可佈題")
        applied = self._apply(dev, spec.get("setup", {}) or {})
        self.active = {
            "exercise": exercise_id,
            "title": spec.get("title"),
            "target": dev.id,
            "launched_sim_t": float(self.world.clock.now()),
            "launched_wall": time.time(),
            "applied": applied,
        }
        self._save()
        return dict(self.active)

    def stop(self, reset: bool = True) -> dict:
        tgt = self.active.get("target") if self.active else None
        self.active = None
        self._save()
        did_reset = False
        if reset and tgt:
            dev = self.world.devices.get(tgt)
            if dev is not None:
                dev.reset()
                did_reset = True
        return {"stopped": True, "target": tgt, "reset": did_reset}

    # ── 作答(學生,匿名以座號/學號) ──────────────────────
    async def answer(self, exercise_id: str, question_id: str, student: str, value) -> dict:
        student = str(student or "").strip()
        if not student:
            raise ValueError("缺少座號/學號")
        if not self.active or self.active.get("exercise") != exercise_id:
            raise ValueError("此練習目前未在進行中(請教師先佈題)")
        spec = self.exercises.get(exercise_id)
        q = next((x for x in (spec.get("questions") or []) if x.get("id") == question_id), None)
        if q is None:
            raise KeyError(f"無此題:{question_id}")
        target = self.active.get("target")

        grade = q.get("grade", {}) or {}
        kind = str(grade.get("kind", "static"))
        raw = value
        if q.get("type") == "numeric":
            try:
                value = float(value)
            except (TypeError, ValueError):
                raise ValueError("這題要填數字")

        if kind == "static":
            correct = str(raw).strip() == str(grade.get("answer")).strip()
            score = 100.0 if correct else 0.0
            feedback = "✓ 答對了" if correct else f"✗ 再想想(提示:{q.get('hint', '')})"
        elif kind == "target":
            correct = str(raw).strip() == str(target)
            score = 100.0 if correct else 0.0
            feedback = "✓ 就是這台" if correct else "✗ 不是這台,用多訊號趨勢再找找"
        elif kind == "submission":
            payload = {k: v for k, v in grade.items() if k not in ("kind", "value_field")}
            payload["device"] = grade.get("device", target)
            payload["student"] = student
            payload.setdefault("from", self.active.get("launched_wall"))
            payload[grade.get("value_field", "value")] = value
            res = await self.submissions.grade(payload)
            score = float(res.get("score", 0.0))
            correct = bool(res.get("passed"))
            feedback = res.get("feedback", "")
        else:
            raise ValueError(f"未知的批改方式:{kind}")

        self._seq += 1
        rec = {
            "id": f"CA-{self._seq:05d}",
            "exercise": exercise_id,
            "question": question_id,
            "student": student,
            "answer": raw,
            "score": round(score, 1),
            "passed": bool(score >= 60),
            "correct": bool(correct),
            "sim_t": round(self.world.clock.now(), 1),
            "answered_wall": time.time(),
        }
        self.answers.append(rec)
        self.answers = self.answers[-5000:]
        self._save()
        return {
            "correct": rec["correct"], "passed": rec["passed"], "score": rec["score"],
            "feedback": feedback, "explain": q.get("explain"),
        }

    # ── 視圖 ────────────────────────────────────────────────
    def _public_q(self, q: dict) -> dict:
        return {k: q[k] for k in _PUBLIC_Q_FIELDS if k in q}

    def list_exercises(self) -> List[dict]:
        """教師瀏覽用:清單 + 情境摘要(不含正解)。"""
        return [{
            "id": eid,
            "title": self.exercises[eid].get("title"),
            "difficulty": self.exercises[eid].get("difficulty"),
            "brief": self.exercises[eid].get("brief"),
            "questions": len(self.exercises[eid].get("questions") or []),
            "setup": self.exercises[eid].get("setup", {}),
        } for eid in self.order]

    def get_exercise(self, exercise_id: str) -> dict:
        spec = self.exercises.get(exercise_id)
        if spec is None:
            raise KeyError(f"未定義練習:{exercise_id}")
        return {
            "id": exercise_id, "title": spec.get("title"), "difficulty": spec.get("difficulty"),
            "brief": spec.get("brief"), "questions": [self._public_q(q) for q in spec.get("questions") or []],
        }

    def active_view(self) -> dict:
        """學生手機輪詢:目前佈了哪題(公開題面,不含正解)。"""
        if not self.active:
            return {"active": None}
        spec = self.exercises.get(self.active["exercise"]) or {}
        return {"active": {
            "exercise": self.active["exercise"], "title": self.active.get("title"),
            "brief": spec.get("brief"), "difficulty": spec.get("difficulty"),
            "target": self.active.get("target"), "launched_wall": self.active.get("launched_wall"),
            "questions": [self._public_q(q) for q in spec.get("questions") or []],
        }}

    def board(self, exercise_id: Optional[str] = None) -> dict:
        """教師即時看板:當前佈題(或指定練習)每題的答對率 / 分佈。"""
        exercise_id = exercise_id or (self.active or {}).get("exercise")
        spec = self.exercises.get(exercise_id) if exercise_id else None
        if not spec:
            return {"exercise": exercise_id, "title": None, "questions": []}
        rows = []
        for q in spec.get("questions") or []:
            best: Dict[str, dict] = {}
            for a in self.answers:
                if a["exercise"] == exercise_id and a["question"] == q["id"]:
                    cur = best.get(a["student"])
                    if cur is None or a["score"] > cur["score"]:
                        best[a["student"]] = a
            n = len(best)
            correct = sum(1 for a in best.values() if a["correct"])
            dist: Dict[str, int] = {}
            if q.get("type") == "choice":
                for a in best.values():
                    dist[str(a["answer"])] = dist.get(str(a["answer"]), 0) + 1
            rows.append({
                "question": q["id"], "prompt": q["prompt"], "tier": q.get("tier"),
                "students": n, "correct": correct,
                "rate": round(correct / n, 2) if n else None,
                "avg": round(sum(a["score"] for a in best.values()) / n, 1) if n else None,
                "dist": dist,
            })
        return {"exercise": exercise_id, "title": spec.get("title"), "questions": rows}

    def gradebook(self) -> List[dict]:
        """平時成績:每位學生每題取最佳分,彙整平均。"""
        best: Dict[tuple, float] = {}
        for a in self.answers:
            key = (a["student"], a["exercise"], a["question"])
            best[key] = max(best.get(key, -1.0), float(a["score"]))
        per: Dict[str, dict] = {}
        for (stu, _ex, _q), sc in best.items():
            p = per.setdefault(stu, {"student": stu, "answered": 0, "sum": 0.0})
            p["answered"] += 1
            p["sum"] += sc
        rows = [{
            "student": p["student"], "answered": p["answered"],
            "avg": round(p["sum"] / p["answered"], 1) if p["answered"] else 0.0,
        } for p in per.values()]
        rows.sort(key=lambda r: r["avg"], reverse=True)
        return rows
