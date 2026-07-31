"""協定端存取軌跡 —— 誰真的用工業協定讀了什麼。

為什麼要有:平台原本無從分辨「學生真的寫了 Modbus client」與「學生開瀏覽器看數字」。
關卡系統若只看學生自己回報的數字,至少還有「值對不對」當佐證;但「你的 client 到底
在用什麼頻率打我」這件事,只有伺服器端知道。

這一層記的東西同時是**教材**:W2 教接取、W10 教輪詢 vs 訂閱時,可以直接把學生自己的
足跡投影出來 ——「你這支 client 每 0.2 秒打一次,一天 43 萬次請求,你真的需要嗎?」

## 一個誠實的限制(不要對學生宣稱做得到的事)

pymodbus 的 datastore 拿不到 client 位址,所以本層記的是「**哪台設備被讀了幾次**」,
**不是「哪個學生讀的」**。班上任何人都能讀任何一台(設備目錄本來就公開)。

因此關卡預設**不用**存取軌跡當通關條件 —— 通關看的是學生自己交出來、對得上 ground-truth
的數字(那個假不了)。存取軌跡的角色是:
  1. 教材(輪詢頻率、請求量)。
  2. 教師面的佐證(這台到底有沒有人在讀)。
  3. 教師若確定班上一人一廠、不互相讀,可以在 levels.yaml 用 `kind: access` 當條件。

鐵則一:本層只記存取事件,不存任何設備狀態。
"""
from __future__ import annotations

import time
from collections import deque
from typing import Deque, Dict, Optional

# 每台設備保留多少筆最近存取(算頻率用);超過丟最舊的
_RECENT = 200


class AccessLog:
    """協定端存取統計。以 (device, protocol) 為鍵,記次數、最近時間、最近間隔。"""

    def __init__(self) -> None:
        self._counts: Dict[tuple, int] = {}
        self._last: Dict[tuple, float] = {}
        self._recent: Dict[tuple, Deque[float]] = {}
        self._first: Dict[tuple, float] = {}

    def record(self, device_id: Optional[str], protocol: str, n: int = 1) -> None:
        if not device_id:
            return
        key = (device_id, protocol)
        now = time.time()
        self._counts[key] = self._counts.get(key, 0) + n
        self._last[key] = now
        self._first.setdefault(key, now)
        q = self._recent.setdefault(key, deque(maxlen=_RECENT))
        q.append(now)

    def clear(self) -> int:
        n = len(self._counts)
        self._counts.clear()
        self._last.clear()
        self._recent.clear()
        self._first.clear()
        return n

    def reads(self, device_id: str, protocol: Optional[str] = None) -> int:
        if protocol:
            return self._counts.get((device_id, protocol), 0)
        return sum(v for (d, _p), v in self._counts.items() if d == device_id)

    def protocols_used(self, device_id: str) -> list[str]:
        return sorted({p for (d, p) in self._counts if d == device_id and self._counts[(d, p)] > 0})

    def rate_s(self, device_id: str, protocol: str) -> Optional[float]:
        """最近的平均請求間隔(秒)。少於 2 筆回 None。"""
        q = self._recent.get((device_id, protocol))
        if not q or len(q) < 2:
            return None
        span = q[-1] - q[0]
        return round(span / (len(q) - 1), 3) if span > 0 else None

    def view(self, device_id: Optional[str] = None) -> dict:
        """對外視圖:逐 (設備, 協定) 的次數、最近一次、平均間隔。"""
        rows = []
        for (dev, proto), count in sorted(self._counts.items()):
            if device_id and dev != device_id:
                continue
            last = self._last.get((dev, proto))
            rows.append({
                "device": dev,
                "protocol": proto,
                "reads": count,
                "last_wall_t": round(last, 1) if last else None,
                "avg_interval_s": self.rate_s(dev, proto),
                "since_wall_t": round(self._first.get((dev, proto), 0.0), 1) or None,
            })
        rows.sort(key=lambda r: r["reads"], reverse=True)
        return {
            "rows": rows,
            "note": "記的是『哪台設備被讀了幾次』,不是『哪個學生讀的』—— "
                    "協定層拿不到身分。用途是輪詢頻率教學與佐證,不當通關依據。",
        }
