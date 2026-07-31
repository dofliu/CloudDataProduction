"""工單 / 票務(docs/05 §工單)。

故障事件自動生成工單;學生 ack → **診斷 → 選處置動作** → resolve。量 MTTR、偵測延遲與
誤修次數,當天然評分指標。工單只存流程紀錄(讀視圖原則:設備真值在引擎)。

resolve 不再是「按一下就好」:必須帶 `action`(見 engine/repair.py 的維修手冊),
只有對症的動作會修好;選錯照樣扣工時、工單退回處理中。這樣工單才是判斷題而不是打卡。

學生面看到的工單**不含** component / fault_type —— 那是 ground-truth(等於直接寫答案)。
學生只看得到症狀與設備,要自己從遙測資料判斷該用哪個動作。教師面才給完整根因。
"""
from __future__ import annotations

from typing import Optional

from engine.repair import REPAIR_ACTIONS
from engine.world import World

# 學生面要遮掉的 ground-truth 欄位(直接寫著答案的那些)
_TEACHER_ONLY_FIELDS = ("component", "fault_type")


class TicketStore:
    def __init__(self, world: World, persist=None):
        self.world = world
        self.persist = persist
        self.tickets: dict[str, dict] = {}
        self._seq = 0
        if persist is not None:                       # 開機載入既有工單(進程重啟不歸零)
            saved = persist.load("tickets") or {}
            self.tickets = saved.get("tickets", {})
            self._seq = saved.get("seq", 0)

    def _save(self) -> None:
        if self.persist is not None:
            self.persist.save("tickets", {"tickets": self.tickets, "seq": self._seq})

    def clear(self) -> int:
        """清空所有工單(教師「重置課堂資料」用)。回傳清掉的張數。"""
        n = len(self.tickets)
        self.tickets = {}
        self._seq = 0
        self._save()
        return n

    # ── 事件訂閱:故障自動開單 ──────────────────────────────
    async def on_event(self, ev: dict) -> None:
        if ev.get("type") == "fault":
            self._create(ev)

    def _owner_of(self, company_id: Optional[str]) -> Optional[str]:
        for c in self.world.park.get("companies", []):
            if c.get("id") == company_id:
                return c.get("owner")
        return None

    def _create(self, ev: dict) -> dict:
        self._seq += 1
        tid = f"T{self._seq:04d}"
        ticket = {
            "id": tid,
            "device": ev.get("device"),
            "company": ev.get("company"),
            "owner": self._owner_of(ev.get("company")),
            "type": "fault",
            "component": ev.get("component"),
            "fault_type": ev.get("fault_type"),
            "onset_sim_t": ev.get("sim_t"),
            "status": "open",            # open → acked → resolved
            "ack_sim_t": None,
            "resolve_sim_t": None,
            "detection_latency_sim_s": None,
            "mttr_sim_s": None,
            # 學生看得到的只有症狀(現場的事實),不含根因
            "symptom": "設備跳機停線 —— 請由遙測資料判斷根因,再選擇處置動作",
            "attempts": [],              # 每次處置嘗試 {action, success, sim_t, actor}
            "wrong_attempts": 0,         # 誤修次數(評分用)
            "repair_downtime_h": 0.0,    # 這張單累計花掉的維修工時(含白花的)
        }
        self.tickets[tid] = ticket
        self._save()
        return ticket

    # ── 查詢 / 處置 ────────────────────────────────────────
    @staticmethod
    def _redact(t: dict) -> dict:
        """學生視圖:拿掉根因欄位。舊工單沒有 symptom 欄位時補一個,避免前端空白。"""
        out = {k: v for k, v in t.items() if k not in _TEACHER_ONLY_FIELDS}
        out.setdefault("symptom", "設備跳機停線 —— 請由遙測資料判斷根因,再選擇處置動作")
        out.setdefault("attempts", [])
        out.setdefault("wrong_attempts", 0)
        out.setdefault("repair_downtime_h", 0.0)
        return out

    def list(self, owner: Optional[str] = None, status: Optional[str] = None,
             reveal: bool = False) -> list[dict]:
        """reveal=True 才給根因(教師面);預設是學生視圖。"""
        res = list(self.tickets.values())
        if owner:
            res = [t for t in res if t["owner"] == owner]
        if status:
            res = [t for t in res if t["status"] == status]
        res = sorted(res, key=lambda t: t["onset_sim_t"] or 0, reverse=True)
        return res if reveal else [self._redact(t) for t in res]

    def ack(self, tid: str) -> Optional[dict]:
        t = self.tickets.get(tid)
        if t is None:
            return None
        if t["ack_sim_t"] is None:
            t["ack_sim_t"] = self.world.clock.now()
            if t["onset_sim_t"] is not None:
                t["detection_latency_sim_s"] = t["ack_sim_t"] - t["onset_sim_t"]
        if t["status"] == "open":
            t["status"] = "acked"
        self._save()
        return t

    def resolve(self, tid: str, action: str, actor: Optional[str] = None) -> dict:
        """帶處置動作結案。選對才修得好、才結案;選錯扣工時並退回處理中。

        回傳 {ok, ticket, repair} —— repair 是引擎回報的處置結果(已遮掉根因)。
        """
        t = self.tickets.get(tid)
        if t is None:
            return {"ok": False, "error": f"無此工單:{tid}"}
        if action not in REPAIR_ACTIONS:
            return {"ok": False, "error": f"未知的處置動作:{action}",
                    "actions": sorted(REPAIR_ACTIONS)}
        if t["status"] == "resolved":
            return {"ok": True, "ticket": self._redact(t), "repair": None, "already": True}

        now = self.world.clock.now()
        if t["ack_sim_t"] is None:                 # 沒先 ack 直接處置,補記偵測時刻
            t["ack_sim_t"] = now
            if t["onset_sim_t"] is not None:
                t["detection_latency_sim_s"] = now - t["onset_sim_t"]
        t["status"] = "acked"

        device = self.world.devices.get(t["device"])
        if device is None:                         # 設備已不存在(場景換過)→ 直接結案,不留孤兒單
            t["status"] = "resolved"
            t["resolve_sim_t"] = now
            self._save()
            return {"ok": True, "ticket": self._redact(t), "repair": None}

        # 故障已被別的途徑清掉(教師 reset / 保養順手修好)→ 這張單視同完成,不算誤修
        if not device.faulted:
            t["status"] = "resolved"
            t["resolve_sim_t"] = now
            if t["onset_sim_t"] is not None:
                t["mttr_sim_s"] = now - t["onset_sim_t"]
            self._save()
            return {"ok": True, "ticket": self._redact(t), "repair": None, "note": "設備已恢復"}

        res = device.repair(action, actor=actor, ticket=tid)
        if not res.get("ok"):                      # 例如正在維修中 → 不記帳,原樣退回
            return {"ok": False, "error": res.get("error"), "ticket": self._redact(t)}

        t.setdefault("attempts", []).append(
            {"action": action, "success": bool(res["success"]), "sim_t": now, "actor": actor})
        t["repair_downtime_h"] = round(t.get("repair_downtime_h", 0.0) + res["downtime_h"], 2)
        if res["success"] and not res["still_faulted"]:
            t["status"] = "resolved"
            t["resolve_sim_t"] = now
            if t["onset_sim_t"] is not None:
                t["mttr_sim_s"] = now - t["onset_sim_t"]
        else:
            t["wrong_attempts"] = t.get("wrong_attempts", 0) + 1
        self._save()
        # 回饋不洩答案:只說「修好了沒」,不說真正壞的是哪個元件。
        repair_view = {"action": action, "success": bool(res["success"]),
                       "still_faulted": bool(res["still_faulted"]),
                       "downtime_h": res["downtime_h"]}
        return {"ok": True, "ticket": self._redact(t), "repair": repair_view}
