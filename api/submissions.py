"""作業自動比對(繳交端點)—— 對 ground-truth 容差計分(docs/課程規劃_18週.md)。

學生把算出的結果 POST 上來,平台用它握有的正解自動評分並回饋,支撐「一般教室 +
手機觀察 + 回家作業」且 60 人無助教的批改負擔。四種可自動批改的作業型別:

  connect  (W2)  : 交某設備某 tag 的即時讀值 → 比對平台當下實值(容差內即通過)
  stats    (W4/期中): 交某設備某 tag 一段時間的統計(mean/std/…)→ 比對 historian 窗內真值
  oee      (W11) : 交某設備 OEE 指標 → 比對平台 ground-truth OEE 累積器
  anomaly  (W6)  : 交你判斷「異常」的設備清單 → 對照本週實際被注入/故障的設備(F1)

計分:相對誤差 ≤ 容差 → 100;≤2×容差 → 線性 100→50;>3×容差 → 0(anomaly 用 F1×100)。
狀態只在引擎(鐵則):真值一律現算,SubmissionStore 只存學生繳交紀錄。
"""
from __future__ import annotations

import time
from statistics import mean, median, pstdev
from typing import Dict, List, Optional

STATS_METRICS = ("mean", "std", "min", "max", "median", "p95")


def _percentile(vals: List[float], p: float) -> float:
    s = sorted(vals)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * p
    lo = int(k)
    frac = k - lo
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * frac


def _stat(vals: List[float], metric: str) -> float:
    if metric == "mean":
        return mean(vals)
    if metric == "std":
        return pstdev(vals)
    if metric == "min":
        return min(vals)
    if metric == "max":
        return max(vals)
    if metric == "median":
        return median(vals)
    if metric == "p95":
        return _percentile(vals, 0.95)
    raise ValueError(f"未知統計量:{metric}")


def _lin_slope(xs: List[float], ys: List[float]) -> Optional[float]:
    """最小平方法斜率(dy/dx)。x 變異不足回 None。"""
    n = len(xs)
    if n < 2:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    vx = sum((x - mx) ** 2 for x in xs)
    if vx <= 1e-12:
        return None
    cov = sum((xs[i] - mx) * (ys[i] - my) for i in range(n))
    return cov / vx


def _pearson(a: List[float], b: List[float]) -> Optional[float]:
    n = len(a)
    if n < 2:
        return None
    ma, mb = sum(a) / n, sum(b) / n
    va = sum((x - ma) ** 2 for x in a)
    vb = sum((y - mb) ** 2 for y in b)
    if va <= 1e-12 or vb <= 1e-12:
        return None
    cov = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    return cov / (va ** 0.5 * vb ** 0.5)


def _score_rel(value: float, truth: float, tol: float) -> tuple[float, float]:
    """回傳 (score 0..100, rel_err)。以相對誤差對容差分段給分。"""
    denom = abs(truth) if abs(truth) > 1e-9 else 1.0
    rel = abs(value - truth) / denom
    if rel <= tol:
        return 100.0, rel
    if rel <= 2 * tol:
        return round(100.0 - 50.0 * (rel - tol) / tol, 1), rel
    if rel <= 3 * tol:
        return round(50.0 * (3 * tol - rel) / tol, 1), rel
    return 0.0, rel


class SubmissionStore:
    def __init__(self, world, historian, course, persist=None):
        self.world = world
        self.historian = historian
        self.course = course
        self.persist = persist
        self.submissions: List[dict] = []
        self._seq = 0
        if persist is not None:
            saved = persist.load("submissions") or {}
            self.submissions = saved.get("submissions", []) or []
            self._seq = int(saved.get("seq", 0))

    def _save(self) -> None:
        if self.persist is not None:
            self.persist.save("submissions", {"submissions": self.submissions, "seq": self._seq})

    def _tol(self, payload: dict) -> float:
        try:
            return float(payload.get("tolerance", self.course.default_tolerance))
        except (TypeError, ValueError):
            return self.course.default_tolerance

    # ── 純批改(不記錄):供課堂練習等重用同一套誠實 ground-truth 批改 ──
    async def grade(self, payload: dict) -> dict:
        """依 type 分派 grader 並回 {score, passed, feedback};**不寫入繳交紀錄**。"""
        stype = str(payload.get("type", "")).strip()
        grader = {
            "connect": self._grade_connect,
            "stats": self._grade_stats,
            "oee": self._grade_oee,
            "anomaly": self._grade_anomaly,
            "aggregate": self._grade_aggregate,
            "events": self._grade_events,
            "correlation": self._grade_correlation,
            "rul": self._grade_rul,
            "root_cause": self._grade_root_cause,
            "slope": self._grade_slope,
            "count_over": self._grade_count,
        }.get(stype)
        if grader is None:
            raise ValueError(f"未知的作業型別:{stype}(可用:connect/stats/oee/anomaly)")
        return await grader(payload)   # {score, passed, feedback, detail?}

    # ── 繳交 ────────────────────────────────────────────────
    async def submit(self, payload: dict) -> dict:
        stype = str(payload.get("type", "")).strip()
        student = str(payload.get("student") or payload.get("student_id") or "").strip()
        if not student:
            raise ValueError("缺少 student")
        result = await self.grade(payload)   # {score, passed, feedback, detail?}
        self._seq += 1
        rec = {
            "id": f"SUB-{self._seq:05d}",
            "student": student,
            "week": payload.get("week"),
            "type": stype,
            "submitted_wall": time.time(),
            "sim_t": round(self.world.clock.now(), 1),
            "score": result["score"],
            "passed": result["passed"],
            "feedback": result["feedback"],
        }
        self.submissions.append(rec)
        self.submissions = self.submissions[-5000:]
        self._save()
        return rec

    # ── 各型別 grader ──────────────────────────────────────
    async def _grade_connect(self, payload: dict) -> dict:
        device = payload.get("device")
        tag = payload.get("tag")
        value = payload.get("value")
        if device is None or tag is None or value is None:
            raise ValueError("connect 需要 device / tag / value")
        snap = self.world.last_snapshot or {}
        dev = (snap.get("devices") or {}).get(device)
        if not dev or tag not in (dev.get("tags") or {}):
            return {"score": 0.0, "passed": False, "feedback": f"平台查無 {device}.{tag},確認設備目錄的名稱。"}
        truth = float(dev["tags"][tag])
        tol = max(self._tol(payload), 0.15)   # 即時值抖動大,容差放寬
        score, rel = _score_rel(float(value), truth, tol)
        passed = score >= 60
        return {"score": score, "passed": passed,
                "feedback": f"你讀到 {float(value):.3f},平台此刻約 {truth:.3f}(相對誤差 {rel*100:.1f}%)"
                            + (" ✓ 連線正確" if passed else " ✗ 偏差過大,檢查 register/型別/位元組序")}

    async def _grade_stats(self, payload: dict) -> dict:
        device = payload.get("device")
        tag = payload.get("tag")
        metric = str(payload.get("metric", "mean")).lower()
        value = payload.get("value")
        if device is None or tag is None or value is None:
            raise ValueError("stats 需要 device / tag / value(可選 metric=mean/std、window)")
        if metric not in STATS_METRICS:
            raise ValueError(f"metric 支援 {' / '.join(STATS_METRICS)}")
        t_from, t_to = self._window(payload)
        rows = await self.historian.query(device, tag, t_from, t_to, limit=100000)
        vals = [r["value"] for r in rows if r.get("value") is not None]
        if len(vals) < 5:
            return {"score": 0.0, "passed": False,
                    "feedback": "此設備/tag 在該時間窗的歷史資料不足(<5 點),無法比對;確認資料窗與 tag 名稱。"}
        truth = _stat(vals, metric)
        tol = self._tol(payload)
        score, rel = _score_rel(float(value), float(truth), tol)
        passed = score >= 60
        return {"score": score, "passed": passed,
                "feedback": f"{metric}:你算 {float(value):.4f},參考 {truth:.4f}"
                            f"(n={len(vals)},相對誤差 {rel*100:.1f}%,容差 ±{tol*100:.0f}%)"
                            + (" ✓" if passed else " ✗ 檢查取樣範圍/單位/聚合方式")}

    async def _grade_oee(self, payload: dict) -> dict:
        device = payload.get("device")
        metric = str(payload.get("metric", "oee")).lower()
        value = payload.get("value")
        if device is None or value is None:
            raise ValueError("oee 需要 device / value(可選 metric=oee/availability/performance/quality)")
        dev = self.world.devices.get(device)
        if dev is None:
            return {"score": 0.0, "passed": False, "feedback": f"查無設備 {device}"}
        truth_all = dev.oee()
        if metric not in truth_all:
            raise ValueError("metric 支援 oee/availability/performance/quality")
        truth = float(truth_all[metric])
        tol = max(self._tol(payload), 0.15)   # OEE 由學生自算,容差放寬
        score, rel = _score_rel(float(value), truth, tol)
        passed = score >= 60
        return {"score": score, "passed": passed,
                "feedback": f"{metric}:你算 {float(value):.3f},參考 {truth:.3f}(相對誤差 {rel*100:.1f}%)"
                            + (" ✓" if passed else " ✗ 檢查可用率/表現/良率的定義與時間基準")}

    async def _grade_anomaly(self, payload: dict) -> dict:
        student = str(payload.get("student") or payload.get("student_id") or "")
        guess = payload.get("devices") or ([payload.get("device")] if payload.get("device") else [])
        guess = {str(x) for x in guess if x}
        # 候選範圍:學生認領公司的 producer 設備(公平);認領不到就用他列出的設備當範圍
        candidates = self._student_devices(student)
        if not candidates:
            candidates = set(guess)
        truth = {d.id for d in self.world.devices.values()
                 if d.id in candidates and (getattr(d, "_injected", None) or getattr(d, "_fault_latched", False))}
        guess &= candidates
        tp = len(guess & truth)
        fp = len(guess - truth)
        fn = len(truth - guess)
        if tp == 0 and fp == 0 and fn == 0:
            f1 = 1.0    # 該週無異常、學生也沒亂報 → 滿分
        else:
            prec = tp / (tp + fp) if (tp + fp) else 0.0
            rec = tp / (tp + fn) if (tp + fn) else 0.0
            f1 = 2 * prec * rec / (prec + rec) if (prec + rec) else 0.0
        score = round(f1 * 100, 1)
        return {"score": score, "passed": score >= 60,
                "feedback": f"命中 {tp}、誤報 {fp}、漏報 {fn}(候選 {len(candidates)} 台,F1={f1:.2f})"
                            + (" ✓" if score >= 60 else " ✗ 用多訊號趨勢再確認")}

    async def _grade_aggregate(self, payload: dict) -> dict:
        """W7 時序聚合:交某 tag 在「某小時(hour-of-day 0..23)」的平均,對照 historian 依時間重取樣的真值。"""
        device = payload.get("device")
        tag = payload.get("tag")
        value = payload.get("value")
        hour = payload.get("hour")
        if device is None or tag is None or value is None or hour is None:
            raise ValueError("aggregate 需要 device / tag / hour(0..23)/ value")
        try:
            hour = int(hour)
        except (TypeError, ValueError):
            raise ValueError("hour 需為 0..23 的整數")
        t_from, t_to = self._window(payload)
        rows = await self.historian.query(device, tag, t_from, t_to, limit=200000)
        vals = [r["value"] for r in rows
                if r.get("value") is not None and int((r.get("sim_t", 0) % 86400) / 3600) == hour]
        if len(vals) < 3:
            return {"score": 0.0, "passed": False,
                    "feedback": f"該時間窗內第 {hour} 時的資料點不足(<3);確認資料窗與是否用 sim_t 依 hour-of-day 分組。"}
        truth = mean(vals)
        tol = self._tol(payload)
        score, rel = _score_rel(float(value), float(truth), tol)
        return {"score": score, "passed": score >= 60,
                "feedback": f"第 {hour} 時平均:你算 {float(value):.4f},參考 {truth:.4f}"
                            f"(n={len(vals)},相對誤差 {rel*100:.1f}%)"
                            + (" ✓" if score >= 60 else " ✗ 檢查 hour-of-day 分組(sim_t%86400)與聚合")}

    async def _grade_events(self, payload: dict) -> dict:
        """W10 事件流:交本週該設備「完工工單數」,對照 MES 實際完工紀錄(訂閱事件計數的驗證)。"""
        device = payload.get("device")
        value = payload.get("value")
        if device is None or value is None:
            raise ValueError("events 需要 device / value(metric 預設 orders_done)")
        try:
            guess = int(value)
        except (TypeError, ValueError):
            raise ValueError("value 需為整數(事件計數)")
        start_sim = getattr(self.course, "window_start_sim", None) or 0.0
        done = getattr(self.world.mes, "done", {}).get(device, [])
        truth = sum(1 for o in done if (o.done_t is not None and o.done_t >= start_sim))
        diff = abs(guess - truth)
        if diff == 0:
            score = 100.0
        elif diff <= 1:
            score = 75.0
        else:
            score, _ = _score_rel(float(guess), float(truth), max(self._tol(payload), 0.15))
        return {"score": score, "passed": score >= 60,
                "feedback": f"完工工單數:你數 {guess},實際 {truth}(自當週資料窗起算,差 {diff})"
                            + (" ✓" if score >= 60 else " ✗ 訂閱 /ws/events 或輪詢 /api/orders 計 done")}

    # ── 進階題(挑戰) ──────────────────────────────────────
    async def _grade_correlation(self, payload: dict) -> dict:
        """挑戰:交兩個 tag 在資料窗內的皮爾森相關係數 r,對照 historian 真值。
        需自己撈兩條序列、對齊、算相關 —— 遠比單一統計難。r 可由公開資料推得,故回饋顯示真值。"""
        device = payload.get("device")
        tag_a = payload.get("tag_a") or payload.get("tag")
        tag_b = payload.get("tag_b")
        value = payload.get("value")
        if not (device and tag_a and tag_b and value is not None):
            raise ValueError("correlation 需要 device / tag_a / tag_b / value")
        t_from, t_to = self._window(payload)
        ra = await self.historian.query(device, tag_a, t_from, t_to, limit=200000)
        rb = await self.historian.query(device, tag_b, t_from, t_to, limit=200000)
        a = [r["value"] for r in ra if r.get("value") is not None]
        b = [r["value"] for r in rb if r.get("value") is not None]
        n = min(len(a), len(b))
        if n < 10:
            return {"score": 0.0, "passed": False, "feedback": "兩個 tag 在資料窗內的共同樣本不足(<10);確認 tag 名稱與資料窗。"}
        r = _pearson(a[:n], b[:n])
        if r is None:
            return {"score": 0.0, "passed": False, "feedback": "訊號變異不足,相關係數未定義;換一段有變化的資料窗。"}
        tol = float(payload.get("tolerance", 0.15))    # 相關係數用絕對容差
        err = abs(float(value) - r)
        score = 100.0 if err <= tol else (round(100.0 * (2 * tol - err) / tol, 1) if err <= 2 * tol else 0.0)
        return {"score": score, "passed": score >= 60,
                "feedback": f"{tag_a} ~ {tag_b} 相關 r={r:.3f}(你算 {float(value):.3f},差 {err:.3f},容差 ±{tol})"
                            + (" ✓" if score >= 60 else " ✗ 檢查兩序列是否對齊、是否用同一資料窗")}

    async def _grade_rul(self, payload: dict) -> dict:
        """挑戰:估計某設備「距離故障還有幾小時」(RUL),對照隱藏 ground-truth。
        **不透露正解**(那是隱藏健康狀態,洩漏會破壞預測遊戲),只回饋在容差內與否 + 方向。"""
        device = payload.get("device")
        value = payload.get("value")
        if device is None or value is None:
            raise ValueError("rul 需要 device / value(估計:距故障還有幾小時)")
        dev = self.world.devices.get(device)
        if dev is None:
            return {"score": 0.0, "passed": False, "feedback": f"查無設備 {device}"}
        rul = dev.ground_truth().get("rul_sim_s")
        if rul is None:
            return {"score": 0.0, "passed": False,
                    "feedback": "此設備目前待機或未退化,RUL 未定義;挑一台運轉中且正在退化的設備。"}
        truth_h = rul / 3600.0
        tol = max(self._tol(payload), 0.25)            # RUL 本就難,容差放寬
        score, _ = _score_rel(float(value), truth_h, tol)
        passed = score >= 60
        direction = "估計偏高" if float(value) > truth_h * (1 + tol) else "估計偏低" if float(value) < truth_h * (1 - tol) else "很接近"
        return {"score": score, "passed": passed,
                "feedback": f"你估距故障 {float(value):.1f} h — "
                            + ("在容差內 ✓" if passed else f"{direction}(正解不公開:RUL 是隱藏狀態,請靠退化趨勢估)")}

    async def _grade_root_cause(self, payload: dict) -> dict:
        """挑戰:判斷某設備的異常是「感測器故障(sensor)」還是「設備故障(equipment)」。
        對照 ground-truth;不透露細節,只回饋對錯 + 判準提示。"""
        device = payload.get("device")
        cause = str(payload.get("cause", "")).strip().lower()
        if device is None or cause not in ("sensor", "equipment"):
            raise ValueError("root_cause 需要 device / cause(sensor 或 equipment)")
        dev = self.world.devices.get(device)
        if dev is None:
            return {"score": 0.0, "passed": False, "feedback": f"查無設備 {device}"}
        gt = dev.ground_truth()
        has_sensor = bool(gt.get("is_sensor_fault"))
        injected = gt.get("injected") or []
        has_equip = (gt.get("fault_onset_sim_t") is not None) or any(i.get("kind") == "equipment" for i in injected)
        if not has_sensor and not has_equip:
            return {"score": 0.0, "passed": False,
                    "feedback": "此設備目前無異常;先用多訊號趨勢找出被動過手腳的設備,再判斷根因。"}
        correct = (cause == "sensor" and has_sensor) or (cause == "equipment" and has_equip)
        return {"score": 100.0 if correct else 0.0, "passed": correct,
                "feedback": "✓ 根因判斷正確" if correct else
                            "✗ 再想:感測器故障=讀值脫鉤真實但健康度不掉;設備故障=多訊號一致惡化、健康度真的退化"}

    async def _grade_slope(self, payload: dict) -> dict:
        """進階:某 tag 在資料窗內的線性趨勢斜率(每小時變化量),least-squares 對照真值。"""
        device = payload.get("device")
        tag = payload.get("tag")
        value = payload.get("value")
        if device is None or tag is None or value is None:
            raise ValueError("slope 需要 device / tag / value(每小時變化量)")
        t_from, t_to = self._window(payload)
        rows = await self.historian.query(device, tag, t_from, t_to, limit=200000)
        pts = [(r.get("sim_t", 0) / 3600.0, r["value"]) for r in rows if r.get("value") is not None]
        if len(pts) < 5:
            return {"score": 0.0, "passed": False, "feedback": "資料窗內樣本不足(<5),無法擬合趨勢。"}
        slope = _lin_slope([p[0] for p in pts], [p[1] for p in pts])
        if slope is None:
            return {"score": 0.0, "passed": False, "feedback": "時間變異不足,斜率未定義;換一段有時間跨度的資料窗。"}
        tol = max(self._tol(payload), 0.25)
        if abs(slope) < 1e-6:
            passed = abs(float(value)) < 1e-3
            score = 100.0 if passed else 0.0
        else:
            score, _ = _score_rel(float(value), float(slope), tol)
            passed = score >= 60
        return {"score": score, "passed": passed,
                "feedback": f"{tag} 趨勢斜率 ≈ {slope:.4f}/h(你算 {float(value):.4f})"
                            + (" ✓" if passed else " ✗ 用最小平方法對 sim 小時擬合;檢查單位(每小時)")}

    async def _grade_count(self, payload: dict) -> dict:
        """基礎~中:資料窗內某 tag 超過門檻的樣本數(需自己過濾計數)。"""
        device = payload.get("device")
        tag = payload.get("tag")
        threshold = payload.get("threshold")
        value = payload.get("value")
        if device is None or tag is None or threshold is None or value is None:
            raise ValueError("count_over 需要 device / tag / threshold / value(超過門檻的樣本數)")
        t_from, t_to = self._window(payload)
        rows = await self.historian.query(device, tag, t_from, t_to, limit=200000)
        vals = [r["value"] for r in rows if r.get("value") is not None]
        if len(vals) < 5:
            return {"score": 0.0, "passed": False, "feedback": "資料窗內樣本不足(<5)。"}
        truth = sum(1 for v in vals if v > float(threshold))
        diff = abs(int(value) - truth)
        if diff == 0:
            score = 100.0
        elif diff <= max(2, int(truth * 0.05)):
            score = 75.0
        else:
            score, _ = _score_rel(float(value), float(truth), max(self._tol(payload), 0.15))
        return {"score": score, "passed": score >= 60,
                "feedback": f"{tag} > {float(threshold):g} 的樣本數 = {truth}(你數 {int(value)},共 {len(vals)} 點,差 {diff})"
                            + (" ✓" if score >= 60 else " ✗ 確認資料窗與門檻")}

    # ── 輔助 ────────────────────────────────────────────────
    def _window(self, payload: dict) -> tuple[Optional[float], Optional[float]]:
        """作業資料窗(wall 秒)。優先用 payload 明確給的 from/to;否則用當週資料窗起點到現在。"""
        if payload.get("from") is not None or payload.get("to") is not None:
            f = payload.get("from")
            t = payload.get("to")
            return (float(f) if f is not None else None, float(t) if t is not None else None)
        start = getattr(self.course, "window_start_wall", None)
        return (float(start) if start is not None else None, None)

    def _student_devices(self, student: str) -> set:
        ids = set()
        if not student:
            return ids
        for c in self.world.park.get("companies", []) or []:
            if c.get("owner") == student:
                for d in c.get("devices", []) or []:
                    dev = self.world.devices.get(d.get("id"))
                    if dev is not None and getattr(dev, "mes_enabled", False):
                        ids.add(dev.id)
        return ids

    # ── 視圖 ────────────────────────────────────────────────
    def list(self, student: Optional[str] = None, week=None, type: Optional[str] = None) -> List[dict]:
        out = []
        for s in reversed(self.submissions):
            if student and s["student"] != student:
                continue
            if week is not None and str(s.get("week")) != str(week):
                continue
            if type and s["type"] != type:
                continue
            out.append(s)
        return out

    def leaderboard(self, week=None, type: Optional[str] = None) -> List[dict]:
        best: Dict[str, dict] = {}
        for s in self.submissions:
            if week is not None and str(s.get("week")) != str(week):
                continue
            if type and s["type"] != type:
                continue
            cur = best.get(s["student"])
            if cur is None or s["score"] > cur["score"]:
                best[s["student"]] = s
        rows = sorted(best.values(), key=lambda r: r["score"], reverse=True)
        return [{"student": r["student"], "score": r["score"], "type": r["type"], "week": r.get("week")} for r in rows]

    def gradebook(self, week=None, type: Optional[str] = None) -> List[dict]:
        """成績冊(期中/期末評分骨架):每位學生每項作業(type+week)取最佳分,彙整平均。
        自動批改的部分即這裡;期末專題的人工 rubric 由老師另計後併入。"""
        best: Dict[tuple, float] = {}
        for s in self.submissions:
            if week is not None and str(s.get("week")) != str(week):
                continue
            if type and s["type"] != type:
                continue
            key = (s["student"], s["type"], str(s.get("week")))
            best[key] = max(best.get(key, -1.0), float(s["score"]))
        per: Dict[str, dict] = {}
        for (student, typ, wk), sc in best.items():
            p = per.setdefault(student, {"student": student, "assignments": [], "sum": 0.0})
            p["assignments"].append({"type": typ, "week": None if wk == "None" else wk, "score": sc})
            p["sum"] += sc
        rows = []
        for p in per.values():
            n = len(p["assignments"])
            rows.append({
                "student": p["student"],
                "assignments": sorted(p["assignments"], key=lambda a: (str(a["week"]), a["type"])),
                "count": n,
                "avg": round(p["sum"] / n, 1) if n else 0.0,
            })
        rows.sort(key=lambda r: r["avg"], reverse=True)
        return rows
