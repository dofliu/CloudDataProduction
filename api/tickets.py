"""工單 / 票務(docs/05 §工單)。

故障事件自動生成工單;學生 ack → 處置 → resolve。量 MTTR 與偵測延遲,當天然評分指標。
工單只存在記憶體(讀視圖原則:狀態真值在引擎,工單是流程紀錄)。
resolve 會順手 reset 對應設備(學生「處置」→ 設備修復回綠),閉環更有感。
"""
from __future__ import annotations

from typing import Optional

from engine.world import World


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
        }
        self.tickets[tid] = ticket
        self._save()
        return ticket

    # ── 查詢 / 處置 ────────────────────────────────────────
    def list(self, owner: Optional[str] = None, status: Optional[str] = None) -> list[dict]:
        res = list(self.tickets.values())
        if owner:
            res = [t for t in res if t["owner"] == owner]
        if status:
            res = [t for t in res if t["status"] == status]
        return sorted(res, key=lambda t: t["onset_sim_t"] or 0, reverse=True)

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

    def resolve(self, tid: str) -> Optional[dict]:
        t = self.tickets.get(tid)
        if t is None:
            return None
        now = self.world.clock.now()
        if t["ack_sim_t"] is None:                 # 沒先 ack 直接 resolve,補記
            t["ack_sim_t"] = now
            if t["onset_sim_t"] is not None:
                t["detection_latency_sim_s"] = now - t["onset_sim_t"]
        t["resolve_sim_t"] = now
        t["status"] = "resolved"
        if t["onset_sim_t"] is not None:
            t["mttr_sim_s"] = now - t["onset_sim_t"]
        # 處置 = 修復設備,翻回綠燈(閉環)
        device = self.world.devices.get(t["device"])
        if device is not None:
            device.reset()
        self._save()
        return t
