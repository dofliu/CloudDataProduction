"""預防保養排程(學生面的第二個「有代價的決策」)。

工單是**壞了之後**的處置;保養是**還沒壞之前**的決策。兩者共用同一套動作字典
(engine/repair.py),語義一致:保養 = 提前做那個動作。

為什麼這件事值得做:平台原本所有學生互動都是「觀察 → 回答數字」,做對做錯只影響分數,
不影響工廠。保養把 OEE 從「你算得對不對」變成「你管得好不好」——

  - 保養要停機,停機**計入可用率損失**(engine/device.py `_accumulate_oee`)。
  - 保養對症才買得到壽命(health_gain > 0);保養沒在退化的東西 = 白停機。
  - 完全不保養 → 遲早跳機,故障停機更久,還吃良率。

所以這是一題沒有標準答案的取捨題,抄不到、也代寫不了 —— 對「防 AI 代寫」特別有用。

鐵則一:本類只存「誰在什麼時候做了什麼保養」這種流程紀錄;設備健康度真值在引擎。
"""
from __future__ import annotations

from typing import Dict, List, Optional

from engine.repair import REPAIR_ACTIONS
from engine.world import World

MAX_LOG = 2000          # 保養紀錄上限(超過丟最舊的),避免長學期無限成長


class MaintenanceStore:
    def __init__(self, world: World, persist=None):
        self.world = world
        self.persist = persist
        self.log: List[dict] = []
        self._seq = 0
        if persist is not None:
            saved = persist.load("maintenance") or {}
            self.log = saved.get("log", []) or []
            self._seq = int(saved.get("seq", 0))

    def _save(self) -> None:
        if self.persist is not None:
            self.persist.save("maintenance", {"log": self.log, "seq": self._seq})

    def clear(self) -> int:
        n = len(self.log)
        self.log = []
        self._seq = 0
        self._save()
        return n

    # ── 執行保養 ───────────────────────────────────────────
    def apply(self, device_id: str, action: str, actor: Optional[str] = None) -> dict:
        device = self.world.devices.get(device_id)
        if device is None:
            return {"ok": False, "error": f"無此設備:{device_id}"}
        if action not in REPAIR_ACTIONS:
            return {"ok": False, "error": f"未知的保養動作:{action}", "actions": sorted(REPAIR_ACTIONS)}

        res = device.maintain(action, actor=actor)
        if not res.get("ok"):
            return res

        self._seq += 1
        rec = {
            "id": f"M{self._seq:04d}",
            "device": device_id,
            "company": device.company_id,
            "actor": actor,
            "action": action,
            "sim_t": res["sim_t"],
            "downtime_h": res["downtime_h"],
            # health_gain = 這次保養實際買到多少壽命。0 代表保養了沒在退化的東西(白停機),
            # 這個回饋刻意留給學生看 —— 它不是 ground-truth 洩題,是「你這次划不划算」。
            "health_gain": res["health_gain"],
            "effective": bool(res["success"]),
        }
        self.log.append(rec)
        if len(self.log) > MAX_LOG:
            self.log = self.log[-MAX_LOG:]
        self._save()
        return {"ok": True, "maintenance": rec,
                "downtime_h": rec["downtime_h"], "health_gain": rec["health_gain"],
                "hint": "買到壽命 0 代表這個動作對這台目前沒有用 —— 停機工時是白花的。"
                        if not rec["effective"] else None}

    # ── 查詢 ───────────────────────────────────────────────
    def list(self, actor: Optional[str] = None, device: Optional[str] = None,
             limit: int = 200) -> List[dict]:
        rows = self.log
        if actor:
            rows = [r for r in rows if r.get("actor") == actor]
        if device:
            rows = [r for r in rows if r.get("device") == device]
        return list(reversed(rows[-limit:]))

    def summary(self) -> dict:
        """以公司彙整:做了幾次、花掉多少停機工時、其中幾次是白花的。

        「保養做得好不好」不在這裡評分 —— 它已經誠實地反映在 /api/oee 的可用率上了,
        再另外給一個保養分數只會鼓勵學生刷次數。這裡只呈現事實。
        """
        by_company: Dict[str, dict] = {}
        for c in self.world.park.get("companies", []):
            by_company[c["id"]] = {"company": c["id"], "name": c.get("name"), "owner": c.get("owner"),
                                   "count": 0, "downtime_h": 0.0, "wasted": 0, "health_gain": 0.0}
        for r in self.log:
            row = by_company.get(r.get("company") or "")
            if row is None:
                continue
            row["count"] += 1
            row["downtime_h"] = round(row["downtime_h"] + r.get("downtime_h", 0.0), 2)
            row["health_gain"] = round(row["health_gain"] + r.get("health_gain", 0.0), 4)
            if not r.get("effective"):
                row["wasted"] += 1
        rows = [r for r in by_company.values() if r["count"] > 0]
        rows.sort(key=lambda r: r["count"], reverse=True)
        return {"synthetic": True, "rows": rows, "total": len(self.log)}
