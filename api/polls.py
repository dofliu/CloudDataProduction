"""全班投票 —— 投完平台真的照多數決去動引擎(scenarios/classroom_polls.yaml)。

跟課堂即時練習(api/classroom.py)的差別很重要:

  - 練習**有正解**,平台批改,教的是「你算得對不對」。
  - 投票**沒有正解**,是取捨。教的是「你願意付哪個代價」。

而且投完之後平台**真的照多數決執行**:保養就真的停機、拉稼動就真的磨得更快。
下一節課回來看 OEE 與故障紀錄,那就是全班一起做的決定造成的。這是把課堂決策接到
真實引擎的唯一入口 —— 一般教室 + 學生只有手機的情境下,這是最省力的參與感來源。

「維持現況」那一票一定要有選項,不然投票是假的(只剩一條路,那叫佈題不叫投票)。

鐵則一:本類只存票與執行紀錄;要改設備狀態一律呼叫既有的引擎介面
(device.maintain / device.set_coil / mes.set_utilization),不自己動 health。
"""
from __future__ import annotations

import time
from pathlib import Path
from typing import Dict, List, Optional

import yaml

from engine.course import DENSITY
from engine.repair import action_for_component

MAX_HISTORY = 200


class PollManager:
    def __init__(self, world, classroom=None, path: str = "scenarios/classroom_polls.yaml",
                 persist=None):
        self.world = world
        self.classroom = classroom          # 取「目前佈題的設備」當投票對象(device: auto)
        self.persist = persist
        self.polls: Dict[str, dict] = {}
        self.order: List[str] = []
        self.active: Optional[dict] = None  # {poll, device, opened_wall, deadline_wall, votes:{student:option}}
        self.history: List[dict] = []
        self._load(path)
        if persist is not None:
            saved = persist.load("polls") or {}
            self.active = saved.get("active")
            self.history = saved.get("history", []) or []

    def _load(self, path: str) -> None:
        try:
            data = yaml.safe_load(Path(path).read_text(encoding="utf-8")) or {}
        except Exception as exc:
            print(f"[polls] 讀不到投票題庫({path}),全班投票停用:{exc}")
            data = {}
        for p in data.get("polls", []) or []:
            pid = p.get("id")
            if pid:
                self.order.append(pid)
                self.polls[pid] = p

    def _save(self) -> None:
        if self.persist is not None:
            self.persist.save("polls", {"active": self.active, "history": self.history[-MAX_HISTORY:]})

    def clear(self) -> int:
        n = len(self.history)
        self.active, self.history = None, []
        self._save()
        return n

    # ── 挑投票對象 ─────────────────────────────────────────
    def _pick_device(self, spec: dict, override: Optional[str] = None):
        if override:
            return self.world.devices.get(override)
        target = spec.get("device", "auto")
        if target and target != "auto":
            return self.world.devices.get(target)
        # auto:優先用課堂練習當下佈題的那台(全班正在看它),否則挑第一台會生產的
        if self.classroom is not None and self.classroom.active:
            dev = self.world.devices.get(self.classroom.active.get("target"))
            if dev is not None:
                return dev
        producers = sorted((d for d in self.world.devices.values()
                            if getattr(d, "mes_enabled", False)), key=lambda d: d.id)
        pool = producers or sorted(self.world.devices.values(), key=lambda d: d.id)
        return pool[0] if pool else None

    # ── 開票 / 投票 / 收票 ──────────────────────────────────
    def open(self, poll_id: str, duration_s: Optional[float] = 120.0,
             device: Optional[str] = None) -> dict:
        spec = self.polls.get(poll_id)
        if spec is None:
            return {"ok": False, "error": f"無此投票:{poll_id}"}
        dev = self._pick_device(spec, device)
        needs_device = any((o.get("effect") or {}).get("kind") in ("maintenance", "run_enable")
                           for o in spec.get("options", []))
        if needs_device and dev is None:
            return {"ok": False, "error": "找不到可投票的設備"}
        now = time.time()
        self.active = {
            "poll": poll_id,
            "device": dev.id if dev is not None else None,
            "opened_wall": now,
            "deadline_wall": (now + float(duration_s)) if duration_s else None,
            "votes": {},
        }
        self._save()
        return {"ok": True, "active": self.view()["active"]}

    def vote(self, poll_id: str, option_id: str, student: str) -> dict:
        student = str(student or "").strip()
        if not student:
            return {"ok": False, "error": "缺少座號 / 學號"}
        if not self.active or self.active.get("poll") != poll_id:
            return {"ok": False, "error": "這個投票目前沒有進行中"}
        if self._remain_s() is not None and self._remain_s() <= 0:
            return {"ok": False, "error": "投票已截止"}
        spec = self.polls[poll_id]
        if not any(o.get("id") == option_id for o in spec.get("options", [])):
            return {"ok": False, "error": f"無此選項:{option_id}"}
        self.active["votes"][student] = option_id      # 可改票,以最後一次為準
        self._save()
        return {"ok": True, "voted": option_id, "tally": self._tally()}

    def close(self, execute: bool = True) -> dict:
        """收票 → 照多數決執行。平票時取「什麼都不做」的那個選項;沒有的話取第一個。"""
        if not self.active:
            return {"ok": False, "error": "目前沒有進行中的投票"}
        poll_id = self.active["poll"]
        spec = self.polls[poll_id]
        tally = self._tally()
        winner = self._winner(spec, tally)
        result = {"kind": "none", "detail": "未執行"}
        if execute and winner:
            result = self._execute(spec, winner)
        rec = {
            "poll": poll_id,
            "question": spec.get("question"),
            "device": self.active.get("device"),
            "opened_wall": self.active.get("opened_wall"),
            "closed_wall": time.time(),
            "sim_t": round(self.world.clock.now(), 1),
            "votes": sum(tally.values()),
            "tally": tally,
            "winner": winner,
            "winner_label": next((o.get("label") for o in spec.get("options", [])
                                  if o.get("id") == winner), None),
            "result": result,
        }
        self.history.append(rec)
        self.history = self.history[-MAX_HISTORY:]
        self.active = None
        self._save()
        return {"ok": True, "closed": rec}

    def _winner(self, spec: dict, tally: Dict[str, int]) -> Optional[str]:
        if not tally:
            return None
        top = max(tally.values())
        tied = [oid for oid, n in tally.items() if n == top]
        if len(tied) == 1:
            return tied[0]
        # 平票 → 傾向「什麼都不做」。現場真的平手時,不該由平台幫全班決定去動機器。
        for o in spec.get("options", []):
            if o.get("id") in tied and (o.get("effect") or {}).get("kind") == "none":
                return o["id"]
        return sorted(tied)[0]

    def _execute(self, spec: dict, option_id: str) -> dict:
        opt = next((o for o in spec.get("options", []) if o.get("id") == option_id), None)
        effect = (opt or {}).get("effect") or {}
        kind = effect.get("kind", "none")
        dev = self.world.devices.get(self.active.get("device") or "")

        if kind == "none":
            return {"kind": "none", "detail": "全班決定維持現況,引擎不動"}

        if kind == "maintenance":
            if dev is None:
                return {"kind": "maintenance", "ok": False, "detail": "找不到設備"}
            action = effect.get("action", "auto")
            if action == "auto":
                # auto = 挑目前健康度最低的那個元件對應的動作。投票的題目是「要不要保養」,
                # 不是「保養哪裡」,所以這一步由平台代勞不算洩題。
                worst = min(dev.components.values(), key=lambda c: c.health, default=None)
                action = action_for_component(worst.name) if worst is not None else "overhaul"
            res = dev.maintain(action, actor="全班投票")
            return {"kind": "maintenance", "ok": bool(res.get("ok")), "action": action,
                    "downtime_h": res.get("downtime_h"), "health_gain": res.get("health_gain"),
                    "detail": f"對 {dev.id} 執行「{action}」,停機 {res.get('downtime_h')}h"}

        if kind == "run_enable":
            if dev is None:
                return {"kind": "run_enable", "ok": False, "detail": "找不到設備"}
            value = bool(effect.get("value", True))
            dev.set_coil("run_enable", value)
            return {"kind": "run_enable", "ok": True, "value": value,
                    "detail": f"{dev.id} {'復機' if value else '停機'}"}

        if kind == "utilization":
            mes = getattr(self.world, "mes", None)
            if mes is None:
                return {"kind": "utilization", "ok": False, "detail": "此場景未啟用 MES"}
            level = str(effect.get("value", "normal"))
            mes.set_utilization(DENSITY.get(level, 1.0))
            return {"kind": "utilization", "ok": True, "value": level,
                    "detail": f"全園區訂單密度改為 {level}"}

        return {"kind": kind, "ok": False, "detail": f"未知的執行方式:{kind}"}

    # ── 視圖 ───────────────────────────────────────────────
    def _remain_s(self) -> Optional[float]:
        dl = (self.active or {}).get("deadline_wall")
        return None if not dl else round(max(0.0, dl - time.time()), 1)

    def _tally(self) -> Dict[str, int]:
        out: Dict[str, int] = {}
        for opt in (self.active or {}).get("votes", {}).values():
            out[opt] = out.get(opt, 0) + 1
        return out

    def list_polls(self) -> List[dict]:
        return [{"id": pid, "question": self.polls[pid].get("question"),
                 "brief": self.polls[pid].get("brief"),
                 "options": [{"id": o.get("id"), "label": o.get("label"), "detail": o.get("detail")}
                             for o in self.polls[pid].get("options", [])]}
                for pid in self.order]

    def view(self) -> dict:
        """學生手機 / 投影幕輪詢。票數即時公開 —— 投票不是考試,看得到風向才有討論。"""
        if not self.active:
            return {"active": None, "history": self.history[-5:][::-1]}
        spec = self.polls.get(self.active["poll"]) or {}
        return {"active": {
            "poll": self.active["poll"],
            "question": spec.get("question"),
            "brief": spec.get("brief"),
            "device": self.active.get("device"),
            "options": [{"id": o.get("id"), "label": o.get("label"), "detail": o.get("detail")}
                        for o in spec.get("options", [])],
            "tally": self._tally(),
            "votes": len(self.active.get("votes", {})),
            "remain_s": self._remain_s(),
            "closed": (self._remain_s() is not None and self._remain_s() <= 0),
        }, "history": self.history[-5:][::-1]}
