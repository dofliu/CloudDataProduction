"""全域模擬時鐘(sim_clock)與時間加速。

為什麼要獨立時鐘:run-to-failure 在真實時間可能是數百小時,課堂演示不可能等。
所有退化、計時、RUL 都對「模擬時間」積分,**絕不對 wall clock**(見 docs/02 §5)。
調倍率只動這一個物件,引擎其他部分照常用 sim 秒,完全無感。
"""
from __future__ import annotations

import time


class SimClock:
    """持有模擬時間與加速倍率的單一事實來源。

    用法:世界主迴圈每個 wall-clock tick 呼叫 ``advance(dt_wall)``,
    它把真實經過時間乘上倍率,累積成模擬時間並回傳這次推進的 ``dt_sim``。
    引擎其餘部分一律以 ``now()``(模擬秒)為準。
    """

    def __init__(self, time_multiplier: float = 1.0, tick_hz: float = 10.0):
        # 倍率:1 = 即時、60 = 一分鐘走一小時、3600 = 一秒走一小時
        self.time_multiplier: float = float(time_multiplier)
        # 主迴圈目標頻率(Hz)。退化積分用實際 dt,不假設剛好等於 1/tick_hz,
        # 因此即使迴圈抖動也不會讓時間漂移。
        self.tick_hz: float = float(tick_hz)
        self.paused: bool = False

        self._sim_t: float = 0.0          # 累積模擬秒
        self._wall_start: float = time.monotonic()

    def now(self) -> float:
        """目前模擬時間(秒)。"""
        return self._sim_t

    def advance(self, dt_wall: float) -> float:
        """推進模擬時間,回傳這次推進的模擬秒(暫停時為 0)。"""
        if self.paused or dt_wall <= 0.0:
            return 0.0
        dt_sim = dt_wall * self.time_multiplier
        self._sim_t += dt_sim
        return dt_sim

    def set_multiplier(self, multiplier: float) -> None:
        """即時調整倍率。因為積分用 dt_sim,倍率改變是平滑的、不會跳時間。"""
        self.time_multiplier = max(0.0, float(multiplier))

    def set_paused(self, paused: bool) -> None:
        self.paused = bool(paused)

    @property
    def target_dt(self) -> float:
        """主迴圈每圈應 sleep 的 wall-clock 秒數。"""
        return 1.0 / self.tick_hz if self.tick_hz > 0 else 0.1

    def snapshot(self) -> dict:
        return {
            "sim_t": self._sim_t,
            "multiplier": self.time_multiplier,
            "paused": self.paused,
            "tick_hz": self.tick_hz,
        }
