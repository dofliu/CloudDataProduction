"""自動評分(docs/05 §自動評分)。

因為有 ground-truth(故障真正起始時刻),階段一可自動算:偵測延遲、MTTR、漏報。
以公司(學生認領單位)為單位彙整,產出公開排名榜。所有指標對 sim 時間計算。
"""
from __future__ import annotations

from statistics import mean
from typing import Optional

from engine.world import World
from .tickets import TicketStore


def _avg_h(values: list[float]) -> Optional[float]:
    """平均並換算成 sim 小時;無資料回 None。"""
    vals = [v for v in values if v is not None]
    return round(mean(vals) / 3600.0, 2) if vals else None


class ScoringEngine:
    def __init__(self, world: World, tickets: TicketStore):
        self.world = world
        self.tickets = tickets

    def scores(self) -> dict:
        rows = []
        all_tickets = list(self.tickets.tickets.values())
        for c in self.world.park.get("companies", []):
            cid = c.get("id")
            ts = [t for t in all_tickets if t["company"] == cid]
            acked = [t for t in ts if t["ack_sim_t"] is not None]
            resolved = [t for t in ts if t["status"] == "resolved"]
            missed = [t for t in ts if t["ack_sim_t"] is None]   # 從未偵測到

            avg_det_h = _avg_h([t["detection_latency_sim_s"] for t in acked])
            avg_mttr_h = _avg_h([t["mttr_sim_s"] for t in resolved])

            # 分數:每解一單給基礎分,偵測 / 修復越慢扣越多;漏報重扣
            score = 0.0
            for t in resolved:
                det_h = (t["detection_latency_sim_s"] or 0) / 3600.0
                mttr_h = (t["mttr_sim_s"] or 0) / 3600.0
                score += max(0.0, 100.0 - det_h * 10.0 - mttr_h * 5.0)
            score -= 30.0 * len(missed)

            rows.append({
                "company": cid,
                "name": c.get("name"),
                "owner": c.get("owner"),
                "faults": len(ts),
                "detected": len(acked),
                "resolved": len(resolved),
                "missed": len(missed),
                "avg_detection_h": avg_det_h,
                "avg_mttr_h": avg_mttr_h,
                "score": round(score, 1),
            })
        rows.sort(key=lambda r: r["score"], reverse=True)
        return {"synthetic": True, "ranking": rows}
