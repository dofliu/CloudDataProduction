"""學生託管告警規則 —— 手機就能做的預警(W13 的低門檻入口)。

階段二要學生自己寫一支服務,訂閱遙測、跑模型、`POST /api/predictions`。那對跟得上的人
很好,但對「一般教室 + 只有手機」的課堂當下不可行,而且要學生的機器一直掛著。

這裡讓學生只交**一條規則**,平台代跑:

    「c01-cnc-01 的 vibration_rms,一小時移動平均 > 4.5,持續 30 分鐘就告警」

平台每個 snapshot 評估一次,對 ground-truth 的真實故障起始時刻算 precision / recall / F1
與提前量(lead time)。跟 api/predictions.py 是同一套教學目標的兩個難度:
規則是「你設的門檻對不對」,預測服務是「你的模型準不準」。

誠實性:
  - 移動平均用 EMA(指數移動平均),不是等寬視窗 —— 這件事寫在 API 回傳與文件裡,
    學生自己在家算的 boxcar 平均會跟平台略有出入,那是**要教的**取樣/濾波差異,不是 bug。
  - 評分用引擎的真實故障起始時刻,不是「狀態燈變紅的那一刻」。
  - 告警與故障的配對:一次故障只認一次命中,同一次故障的後續告警不重複計分也不算誤報。

鐵則一:本類只存規則與告警紀錄(流程),tag 值一律現讀 snapshot,不自存設備狀態。
"""
from __future__ import annotations

from typing import Dict, List, Optional

OPS = (">", ">=", "<", "<=")
AGGS = ("raw", "ema")
# 告警要提前多久算命中:告警後這段模擬時間內真的故障 → 命中。
LEAD_HORIZON_S = 24 * 3600.0
MAX_ALERTS = 3000
MAX_ONSETS = 2000


def _cmp(value: float, op: str, threshold: float) -> bool:
    if op == ">":
        return value > threshold
    if op == ">=":
        return value >= threshold
    if op == "<":
        return value < threshold
    return value <= threshold


class AlarmRuleStore:
    def __init__(self, world, persist=None):
        self.world = world
        self.persist = persist
        self.rules: Dict[str, dict] = {}
        self.alerts: List[dict] = []
        self.onsets: List[dict] = []          # 真實故障起始(ground-truth,評分用,不對外)
        self._seq = 0
        self._alert_seq = 0
        self._rt: Dict[str, dict] = {}        # 規則執行期狀態(EMA / 持續計時),不持久化
        self._last_sim_t: Optional[float] = None
        self._emit = None
        if persist is not None:
            saved = persist.load("alarm_rules") or {}
            self.rules = saved.get("rules", {}) or {}
            self.alerts = saved.get("alerts", []) or []
            self.onsets = saved.get("onsets", []) or []
            self._seq = int(saved.get("seq", 0))
            self._alert_seq = int(saved.get("alert_seq", 0))

    def set_emitter(self, emit) -> None:
        """告警即時推到 /ws/events(與預測命中同一條通道)。"""
        self._emit = emit

    def _save(self) -> None:
        if self.persist is not None:
            self.persist.save("alarm_rules", {
                "rules": self.rules, "alerts": self.alerts[-MAX_ALERTS:],
                "onsets": self.onsets[-MAX_ONSETS:],
                "seq": self._seq, "alert_seq": self._alert_seq})

    def clear(self) -> int:
        n = len(self.rules)
        self.rules, self.alerts, self.onsets = {}, [], []
        self._rt, self._seq, self._alert_seq = {}, 0, 0
        self._save()
        return n

    # ── 規則 CRUD ──────────────────────────────────────────
    def add(self, spec: dict) -> dict:
        device_id = str(spec.get("device") or "")
        device = self.world.devices.get(device_id)
        if device is None:
            return {"ok": False, "error": f"無此設備:{device_id}"}
        tag = str(spec.get("tag") or "")
        if not any(t.name == tag for t in device.tags):
            return {"ok": False, "error": f"設備 {device_id} 沒有這個 tag:{tag}",
                    "tags": [t.name for t in device.tags]}
        op = str(spec.get("op") or ">")
        if op not in OPS:
            return {"ok": False, "error": f"比較運算子只能是 {list(OPS)}"}
        agg = str(spec.get("agg") or "raw")
        if agg not in AGGS:
            return {"ok": False, "error": f"聚合方式只能是 {list(AGGS)}"}
        try:
            threshold = float(spec.get("threshold"))
            window_s = float(spec.get("window_s") or 0.0)
            for_s = float(spec.get("for_s") or 0.0)
        except (TypeError, ValueError):
            return {"ok": False, "error": "threshold / window_s / for_s 需為數字"}
        if agg == "ema" and window_s <= 0:
            return {"ok": False, "error": "agg=ema 需要 window_s > 0(模擬秒)"}

        student = str(spec.get("student") or "anon")
        # 一人一設備一 tag 只留一條:避免刷規則洗分數(想改就是覆蓋)
        for rid, r in list(self.rules.items()):
            if r["student"] == student and r["device"] == device_id and r["tag"] == tag:
                self.rules.pop(rid, None)
                self._rt.pop(rid, None)

        self._seq += 1
        rid = f"R{self._seq:04d}"
        rule = {"id": rid, "student": student, "device": device_id, "tag": tag,
                "agg": agg, "window_s": window_s, "op": op, "threshold": threshold,
                "for_s": for_s, "enabled": True,
                "created_sim_t": self.world.clock.now()}
        self.rules[rid] = rule
        self._save()
        return {"ok": True, "rule": rule,
                "note": "agg=ema 是指數移動平均(時間常數 = window_s),不是等寬視窗平均。"}

    def delete(self, rule_id: str, student: Optional[str] = None) -> dict:
        r = self.rules.get(rule_id)
        if r is None:
            return {"ok": False, "error": f"無此規則:{rule_id}"}
        if student is not None and r["student"] != student:
            return {"ok": False, "error": "只能刪自己的規則"}
        self.rules.pop(rule_id, None)
        self._rt.pop(rule_id, None)
        self._save()
        return {"ok": True, "deleted": rule_id}

    def list(self, student: Optional[str] = None) -> List[dict]:
        rows = list(self.rules.values())
        if student:
            rows = [r for r in rows if r["student"] == student]
        return sorted(rows, key=lambda r: r["id"])

    def list_alerts(self, student: Optional[str] = None, limit: int = 200) -> List[dict]:
        rows = self.alerts
        if student:
            rows = [a for a in rows if a["student"] == student]
        return list(reversed(rows[-limit:]))

    # ── 評估(每個 snapshot 跑一次)──────────────────────────
    async def on_snapshot(self, snapshot: dict) -> None:
        sim_t = float(snapshot.get("sim_t", 0.0))
        dt = 0.0 if self._last_sim_t is None else max(0.0, sim_t - self._last_sim_t)
        self._last_sim_t = sim_t
        if dt <= 0.0 or not self.rules:
            return
        devices = snapshot.get("devices", {})
        fired = []
        for rid, rule in self.rules.items():
            if not rule.get("enabled", True):
                continue
            dev = devices.get(rule["device"])
            if dev is None:
                continue
            raw = dev.get("tags", {}).get(rule["tag"])
            if raw is None:
                continue
            st = self._rt.setdefault(rid, {"ema": float(raw), "hold": 0.0, "armed": True})

            if rule["agg"] == "ema":
                alpha = dt / (rule["window_s"] + dt)          # 時間常數 = window_s
                st["ema"] += alpha * (float(raw) - st["ema"])
                value = st["ema"]
            else:
                value = float(raw)

            if _cmp(value, rule["op"], rule["threshold"]):
                st["hold"] += dt
                if st["armed"] and st["hold"] >= rule["for_s"]:
                    st["armed"] = False
                    fired.append(self._fire(rule, sim_t, value))
            else:
                st["hold"] = 0.0
                st["armed"] = True                            # 條件解除 → 重新武裝

        if fired:
            self._save()
            if self._emit is not None:
                for a in fired:
                    await self._emit({"type": "student_alert", **a})

    def _fire(self, rule: dict, sim_t: float, value: float) -> dict:
        self._alert_seq += 1
        alert = {"id": f"A{self._alert_seq:05d}", "rule": rule["id"], "student": rule["student"],
                 "device": rule["device"], "tag": rule["tag"], "value": round(float(value), 4),
                 "sim_t": sim_t}
        self.alerts.append(alert)
        if len(self.alerts) > MAX_ALERTS:
            self.alerts = self.alerts[-MAX_ALERTS:]
        return alert

    async def on_event(self, ev: dict) -> None:
        """記真實故障起始時刻(ground-truth),供評分配對。"""
        if ev.get("type") != "fault":
            return
        self.onsets.append({"device": ev.get("device"), "sim_t": float(ev.get("sim_t") or 0.0)})
        if len(self.onsets) > MAX_ONSETS:
            self.onsets = self.onsets[-MAX_ONSETS:]
        self._save()

    # ── 評分 ───────────────────────────────────────────────
    def scores(self) -> dict:
        """對 ground-truth 算 precision / recall / F1 與平均提前量。

        配對規則:每次告警找「同設備、在告警之後 LEAD_HORIZON_S 之內」最早的那次故障;
        該次故障若已被同一位學生更早的告警認領,這則告警算重複(不計分也不算誤報)。
        """
        by_student: Dict[str, dict] = {}
        for r in self.rules.values():
            by_student.setdefault(r["student"], self._empty_row(r["student"]))["rules"] += 1

        # 每位學生各自配對(不同學生可以同時抓到同一次故障)
        claimed: Dict[str, set] = {}
        for a in sorted(self.alerts, key=lambda x: x["sim_t"]):
            row = by_student.setdefault(a["student"], self._empty_row(a["student"]))
            mine = claimed.setdefault(a["student"], set())
            onset = self._match_onset(a)
            if onset is None:
                row["false_alarms"] += 1
                continue
            key = (onset["device"], onset["sim_t"])
            if key in mine:
                row["duplicates"] += 1
                continue
            mine.add(key)
            row["hits"] += 1
            row["_lead"].append(onset["sim_t"] - a["sim_t"])

        # 漏報:被監控設備上發生、但該學生沒抓到的故障
        for student, row in by_student.items():
            watched = {r["device"] for r in self.rules.values() if r["student"] == student}
            mine = claimed.get(student, set())
            for o in self.onsets:
                if o["device"] in watched and (o["device"], o["sim_t"]) not in mine:
                    row["misses"] += 1

        rows = []
        for row in by_student.values():
            lead = row.pop("_lead")
            tp, fp, fn = row["hits"], row["false_alarms"], row["misses"]
            precision = tp / (tp + fp) if (tp + fp) else 0.0
            recall = tp / (tp + fn) if (tp + fn) else 0.0
            f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
            row.update({
                "alerts": tp + fp + row["duplicates"],
                "precision": round(precision, 3), "recall": round(recall, 3),
                "f1": round(f1, 3),
                "avg_lead_time_h": round(sum(lead) / len(lead) / 3600.0, 2) if lead else None,
                "score": round(f1 * 100.0, 1),
            })
            rows.append(row)
        rows.sort(key=lambda r: (r["score"], r["hits"]), reverse=True)
        return {"synthetic": True, "horizon_h": LEAD_HORIZON_S / 3600.0, "ranking": rows}

    @staticmethod
    def _empty_row(student: str) -> dict:
        return {"student": student, "rules": 0, "hits": 0, "false_alarms": 0,
                "misses": 0, "duplicates": 0, "_lead": []}

    def _match_onset(self, alert: dict) -> Optional[dict]:
        best = None
        for o in self.onsets:
            if o["device"] != alert["device"]:
                continue
            lead = o["sim_t"] - alert["sim_t"]
            if 0.0 <= lead <= LEAD_HORIZON_S and (best is None or o["sim_t"] < best["sim_t"]):
                best = o
        return best
