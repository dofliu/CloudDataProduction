"""隱藏健康狀態與退化過程(docs/02 §1)。

核心觀念:每台設備有一個或多個看不見的退化元件,各自持有累積損傷 D。
觀測訊號是 health 的函數(signals.py),故障是 D 越過門檻的結果。
這支檔案只管「損傷怎麼累積」,完全不知道協定與畫面。
"""
from __future__ import annotations

import numpy as np


# 退化軌跡:P0 實作 linear / exponential 兩種(docs/07 P0)。
# 其餘(wiener / random_shock / step_then_run)留待 P1+,結構已預留。
TRAJECTORIES = ("linear", "exponential", "wiener", "random_shock", "step_then_run")


class DegradationComponent:
    """單一退化元件的隱藏健康狀態。

    health = clip(1 − D / D_fail, 0, 1)。損傷 D 對 **模擬時間** 單調累積:
        D(t+Δt) = D(t) + r_eff · s(operating_point) · (1 + σ·ξ) · Δt_sim
    其中 r_eff 視軌跡而定(exponential 會隨損傷加速)。
    """

    def __init__(
        self,
        name: str,
        rate: float,
        trajectory: str = "linear",
        sigma: float = 0.0,
        D_fail: float = 1.0,
        failure_threshold: float = 0.0,
        init_health: float = 1.0,
        k: float = 3.0,
        causes_device_fault: bool = True,
        seed: int | None = None,
    ):
        if trajectory not in TRAJECTORIES:
            raise ValueError(f"未知退化軌跡:{trajectory}")
        self.name = name
        self.rate = float(rate)            # 基礎退化率 r_i(每模擬秒)
        self.trajectory = trajectory
        self.sigma = float(sigma)          # 隨機強度,讓同型設備壽命有分散
        self.D_fail = float(D_fail)
        self.failure_threshold = float(failure_threshold)
        # exponential 加速係數:r_eff = r·(1 + k·D),k 越大越「後期崩得快」
        self.k = float(k)
        # 是否會讓「設備」進入 fault(感測器型退化設 False,只汙染讀值不算設備壞)
        self.causes_device_fault = bool(causes_device_fault)

        # 由 init_health 反推初始損傷:給同型設備不同起點 → 學生模型要泛化而非背曲線
        self.D: float = (1.0 - float(init_health)) * self.D_fail
        self._rng = np.random.default_rng(seed)

    # ── 狀態查詢 ────────────────────────────────────────────
    @property
    def health(self) -> float:
        return float(np.clip(1.0 - self.D / self.D_fail, 0.0, 1.0))

    @property
    def failed(self) -> bool:
        return self.health <= self.failure_threshold

    def effective_rate(self) -> float:
        if self.trajectory == "exponential":
            # 損傷越深、退化越快,對應軸承劣化 / 裂紋擴展
            return self.rate * (1.0 + self.k * self.D)
        # linear:固定率,對應刀具磨耗 / 皮帶磨損
        return self.rate

    # ── 推進一步 ────────────────────────────────────────────
    def step(self, dt_sim: float, stress: float) -> None:
        """累積損傷一步。stress 是運轉點應力倍率(負載/轉速越高越大)。"""
        if dt_sim <= 0.0 or self.failed:
            return
        xi = self._rng.standard_normal()
        # (1 + σ·ξ) 讓退化有隨機抖動;clip 確保「損傷單調不減」(設備不會自己變好)
        factor = max(0.0, 1.0 + self.sigma * xi)
        dD = self.effective_rate() * max(0.0, stress) * factor * dt_sim
        self.D = min(self.D + dD, self.D_fail)

    def rul(self, stress: float) -> float:
        """剩餘壽命(模擬秒):依當前損傷與退化率前推到失效門檻。

        回傳 sim 秒,故與時間倍率無關 —— 用於階段二 lead-time 評分的乾淨 ground-truth。
        失效門檻 h=failure_threshold 對應 D_at_fail = (1−threshold)·D_fail。
        """
        if self.failed:
            return 0.0
        r_eff = self.effective_rate() * max(1e-9, stress)
        D_at_fail = (1.0 - self.failure_threshold) * self.D_fail
        remaining = (D_at_fail - self.D) / r_eff
        return max(0.0, float(remaining))

    def ground_truth(self, stress: float) -> dict:
        """老師面 ground-truth(學生面不可見)。"""
        return {
            "name": self.name,
            "health": self.health,
            "D": self.D,
            "rul_sim_s": self.rul(stress),
            "failed": self.failed,
            "trajectory": self.trajectory,
        }
