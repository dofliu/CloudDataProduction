"""階段二:閉環即時推論預測(docs/01 閉環、docs/05 階段二)。

學生模型訂閱遙測 → 在故障注入/退化越界**之前** POST 預測 →
系統用 ground-truth 的 fault_onset_time 比對,算 lead time(提前量),
命中就發 prediction_hit、設備在 2D 世界翻橘、上預測榜。

預測只存記憶體(讀視圖原則)。比對靠訂閱 world 的故障事件。
"""
from __future__ import annotations

from statistics import mean
from typing import Awaitable, Callable, Optional

from engine.world import World

# 誤報窗:預測後經過這段 sim 時間仍沒故障(且設備非故障中)→ 視為誤報。
# 與學生的 eta 脫鉤 —— eta 估錯不該把「真的有故障」翻成誤報;誤報只看「設備到底有沒有壞」。
FALSE_WINDOW_SIM_S = 7 * 86400.0   # 7 sim-天


class PredictionStore:
    def __init__(self, world: World, persist=None):
        self.world = world
        self.persist = persist
        self.predictions: list[dict] = []
        self.fault_count: dict[str, int] = {}
        self._seq = 0
        if persist is not None:                       # 開機載入既有預測(進程重啟不歸零)
            saved = persist.load("predictions") or {}
            self.predictions = saved.get("predictions", [])
            self.fault_count = saved.get("fault_count", {})
            self._seq = saved.get("seq", 0)
        # 廣播 prediction / prediction_hit 到 /ws/events(由 create_app 注入 events_mgr.broadcast)
        self._emit: Optional[Callable[[dict], Awaitable[None]]] = None

    def _save(self) -> None:
        if self.persist is not None:
            self.persist.save("predictions", {
                "predictions": self.predictions, "fault_count": self.fault_count, "seq": self._seq})

    def set_emitter(self, emit: Callable[[dict], Awaitable[None]]) -> None:
        self._emit = emit

    async def _broadcast(self, msg: dict) -> None:
        if self._emit is not None:
            await self._emit(msg)

    # ── 收預測 ──────────────────────────────────────────────
    async def add(self, body: dict) -> dict:
        device = body.get("device")
        if device not in self.world.devices:
            raise KeyError(device)
        self._seq += 1
        now = self.world.clock.now()
        pred = {
            "id": f"P{self._seq:04d}",
            "device": device,
            "student": body.get("student", "anon"),
            "predicted_fault": body.get("predicted_fault", "fault"),
            "eta_sim_s": body.get("eta_sim_s"),          # 預估「還有多久故障」
            "confidence": float(body.get("confidence", 1.0)),
            "created_sim_t": now,
            "status": "pending",                          # pending → hit / false
            "lead_time_sim_s": None,
        }
        self.predictions.append(pred)
        self._save()
        await self._broadcast({
            "type": "prediction", "device": device, "student": pred["student"],
            "confidence": pred["confidence"], "sim_t": now,
        })
        return pred

    # ── 訂閱 world 事件:故障 → 比對命中 ────────────────────
    async def on_event(self, ev: dict) -> None:
        if ev.get("type") != "fault":
            return
        device = ev["device"]
        onset = ev.get("sim_t", self.world.clock.now())
        self.fault_count[device] = self.fault_count.get(device, 0) + 1
        for p in self.predictions:
            if p["device"] == device and p["status"] == "pending" and p["created_sim_t"] <= onset:
                p["status"] = "hit"
                p["lead_time_sim_s"] = max(0.0, onset - p["created_sim_t"])
                await self._broadcast({
                    "type": "prediction_hit", "device": device, "student": p["student"],
                    "lead_time_sim": p["lead_time_sim_s"], "sim_t": onset,
                })
        self._save()

    # ── 查詢 / 評分 ────────────────────────────────────────
    def _lazy_mark_false(self, now: float) -> None:
        changed = False
        for p in self.predictions:
            if p["status"] != "pending":
                continue
            dev = self.world.devices.get(p["device"])
            if now > p["created_sim_t"] + FALSE_WINDOW_SIM_S and (dev is None or dev.state != "fault"):
                p["status"] = "false"      # 預測後夠久仍沒故障 → 設備其實沒壞 → 誤報
                changed = True
        if changed:
            self._save()

    def list(self, student: Optional[str] = None) -> list[dict]:
        self._lazy_mark_false(self.world.clock.now())
        res = self.predictions if student is None else [p for p in self.predictions if p["student"] == student]
        return sorted(res, key=lambda p: p["created_sim_t"], reverse=True)

    def scores(self) -> dict:
        now = self.world.clock.now()
        self._lazy_mark_false(now)
        by_student: dict[str, dict] = {}
        for p in self.predictions:
            s = by_student.setdefault(p["student"], {"hits": [], "false": 0, "pending": 0, "total": 0})
            s["total"] += 1
            if p["status"] == "hit":
                s["hits"].append(p["lead_time_sim_s"])
            elif p["status"] == "false":
                s["false"] += 1
            else:
                s["pending"] += 1

        rows = []
        for student, d in by_student.items():
            hits = len(d["hits"])
            avg_lead_h = round(mean(d["hits"]) / 3600.0, 2) if d["hits"] else None
            hit_rate = round(hits / (hits + d["false"]), 2) if (hits + d["false"]) else None
            score = 0.0
            for lt in d["hits"]:
                score += min(120.0, 20.0 + (lt / 3600.0) * 5.0)   # 命中基礎 20 + 每提前 1h 加 5,封頂 120
            score -= 25.0 * d["false"]                              # 誤報重扣
            rows.append({
                "student": student, "predictions": d["total"], "hits": hits,
                "false_alarms": d["false"], "pending": d["pending"],
                "avg_lead_time_h": avg_lead_h, "hit_rate": hit_rate,
                "score": round(score, 1),
            })
        rows.sort(key=lambda r: r["score"], reverse=True)
        return {"synthetic": True, "stage": 2, "ranking": rows}
