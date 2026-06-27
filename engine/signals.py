"""訊號模型:把隱藏 health + 運轉點 + 動態 + 雜訊合成為可觀測訊號(docs/02 §2)。

這支檔案是「數據誠不誠實」的關鍵。學生抓得到的只有觀測訊號 y_j:

    y_j(t) = baseline_j(op) + Σ_i g_ji(h_i) + dynamics_j(t) + noise_j

**訊號彼此相關**才是可訓練的核心:同一個 health / 運轉點同時驅動多個訊號
(軸承退化 → 振動先漲、電流後跟、溫度因摩擦升高),學生才能學到多訊號早期徵兆,
而不是看一個布林旗標翻轉。具體 CNC 訊號組裝在 templates/cnc_machining_center.py。

這裡提供可重用的訊號積木(熱滯後、雜訊、健康查詢),讓各 template 組裝 driver。
"""
from __future__ import annotations

from typing import Dict

import numpy as np

from .health import DegradationComponent


def health_of(components: Dict[str, DegradationComponent], name: str, default: float = 1.0) -> float:
    """安全取某退化元件的健康度;元件不存在時回傳 default(視為健康)。"""
    comp = components.get(name)
    return comp.health if comp is not None else default


class ThermalLag:
    """一階熱滯後(low-pass)。溫度不會瞬間到位,而是指數逼近目標(docs/02 §2)。

        T(t+Δt) = T + (T_target − T)·(1 − exp(−Δt_sim / τ))

    這是 **有狀態** 的訊號:每個用到的 tag 各自持有一個實例,保存上一刻溫度。
    退化推高 T_target(摩擦增加 → 發熱),就形成另一條與振動相關的線索。
    """

    def __init__(self, tau_sim_s: float, init_temp: float):
        self.tau = max(1e-6, float(tau_sim_s))   # 熱時間常數(模擬秒)
        self.T = float(init_temp)

    def update(self, target: float, dt_sim: float) -> float:
        if dt_sim > 0.0:
            alpha = 1.0 - np.exp(-dt_sim / self.tau)
            self.T += (float(target) - self.T) * alpha
        return self.T


def gaussian_noise(rng: np.random.Generator, sigma: float) -> float:
    """量測雜訊。sigma 為訊號單位下的標準差。"""
    return float(rng.normal(0.0, sigma)) if sigma > 0.0 else 0.0
