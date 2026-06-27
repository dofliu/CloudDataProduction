"""OEE 設備總效率排名榜(docs/05 §自動評分、docs/07 P4)。

OEE = 可用率(Availability)× 表現(Performance)× 良率(Quality),製造業標準 KPI。
全部從引擎 ground-truth 累積器算(老師的「標準答案」),以公司為單位彙整出公開排名榜。

可用率主要由「故障停機多久」決定 → 學生越快偵測 + 結工單修復,可用率越高;
表現 / 良率由設備退化決定。所以 OEE 把「退化損失」與「學生故障管理」綜合成一個分數。
"""
from __future__ import annotations

from statistics import mean

from engine.world import World


class OeeEngine:
    def __init__(self, world: World):
        self.world = world

    def report(self) -> dict:
        dev_map = {d.id: d.oee() for d in self.world.devices.values()}

        rows = []
        for c in self.world.park.get("companies", []):
            cd = [dev_map[did] for did in c.get("device_ids", []) if did in dev_map]
            if not cd:
                # park_view 沒提供 device_ids 時退回掃描 company_id
                cd = [dev_map[d.id] for d in self.world.devices.values()
                      if d.company_id == c.get("id")]
            if not cd:
                continue
            agg = lambda k: round(mean(x[k] for x in cd), 3)
            rows.append({
                "company": c.get("id"), "name": c.get("name"), "owner": c.get("owner"),
                "oee": agg("oee"), "availability": agg("availability"),
                "performance": agg("performance"), "quality": agg("quality"),
                "devices": [x["device"] for x in cd],
            })
        rows.sort(key=lambda r: r["oee"], reverse=True)
        return {"synthetic": True, "ranking": rows, "devices": list(dev_map.values())}
