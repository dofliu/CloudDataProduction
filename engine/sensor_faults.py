"""感測器故障層(docs/02 §3)。

**後處理**:套在真實訊號輸出之後,完全不動隱藏健康狀態 h,所以 ground-truth 仍然乾淨。
教學重點:讓學生分辨「設備壞了」(health 退化)與「感測器壞了」(讀值脫鉤真實)。

每個感測器故障綁在某 (device, tag) 上,Device.step 算完 tag 值後套用。
"""
from __future__ import annotations

import numpy as np

SENSOR_FAULT_TYPES = ("stuck", "drift", "bias", "noise", "dropout")


class SensorFault:
    """單一 tag 的感測器故障。狀態化(stuck 記最後值、drift 記起始時間)。"""

    def __init__(self, fault_type: str, severity: float = 1.0,
                 onset_sim_s: float | None = None, seed: int | None = None, **params):
        ft = fault_type.replace("sensor_", "")
        if ft not in SENSOR_FAULT_TYPES:
            raise ValueError(f"未知感測器故障型態:{fault_type}")
        self.fault_type = ft
        self.severity = float(severity)
        self.params = params
        self._last: float | None = None
        self._t0: float | None = onset_sim_s
        self._rng = np.random.default_rng(seed)

    def apply(self, value: float, sim_t: float, dt_sim: float) -> float:
        if self._t0 is None:
            self._t0 = sim_t
        ft = self.fault_type

        if ft == "stuck":                       # 數值卡死在故障開始那一刻
            if self._last is None:
                self._last = value
            return self._last

        if ft == "drift":                       # 緩慢線性漂移(每 sim 小時 drift_per_h·severity)
            drift_per_h = self.params.get("drift_per_h", 3.0)
            elapsed_h = max(0.0, (sim_t - self._t0) / 3600.0)
            return value + self.severity * drift_per_h * elapsed_h

        if ft == "bias":                        # 固定偏移
            offset = self.params.get("offset", 5.0)
            return value + self.severity * offset

        if ft == "noise":                       # 雜訊變異數暴增
            sigma = self.params.get("sigma", 3.0) * self.severity
            return value + float(self._rng.normal(0.0, sigma))

        if ft == "dropout":                     # 間歇遺失:保持前值(造成卡頓/缺洞)
            prob = self.params.get("prob", 0.4)
            if self._last is not None and self._rng.random() < prob:
                return self._last
            self._last = value
            return value

        return value

    def info(self) -> dict:
        return {"type": f"sensor_{self.fault_type}", "severity": self.severity}
