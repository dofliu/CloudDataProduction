"""營運狀態持久化(工單 / 預測 / OEE 累積器)。

與 historian.py 分工:
  - historian.db  = 高頻 telemetry 時序(學生分析用)
  - state.db(本檔)= 低頻營運狀態:工單、學生預測、OEE 累積器

用 kv 表存 JSON blob(集合都不大,寫穿即可,免 schema 遷移)。進程重啟後工單/預測/OEE 不歸零。
連不上時 enabled=False 降級為純記憶體(不持久),引擎照常跑。
"""
from __future__ import annotations

import json
import sqlite3
import threading
from typing import Any, Optional

_CREATE = "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT)"


class StateStore:
    def __init__(self, path: str = "state.db", enabled: bool = True):
        self.path = path
        self.enabled = enabled
        self._conn: Optional[sqlite3.Connection] = None
        self._lock = threading.Lock()

    def connect(self) -> None:
        if not self.enabled:
            print("[state] 狀態持久化停用(工單/預測/OEE 僅記憶體)")
            return
        try:
            self._conn = sqlite3.connect(self.path, check_same_thread=False)
            with self._lock:
                self._conn.execute(_CREATE)
                self._conn.commit()
            print(f"[state] 營運狀態持久化:{self.path}")
        except Exception as exc:
            self._conn = None
            print(f"[state] 開 state.db 失敗,降級為記憶體:{exc}")

    def save(self, key: str, obj: Any) -> None:
        if self._conn is None:
            return
        try:
            data = json.dumps(obj, ensure_ascii=False)
            with self._lock:
                self._conn.execute(
                    "INSERT INTO kv(key, json) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET json=excluded.json",
                    (key, data),
                )
                self._conn.commit()
        except Exception as exc:
            print(f"[state] 存 {key} 失敗:{exc}")

    def load(self, key: str, default: Any = None) -> Any:
        if self._conn is None:
            return default
        try:
            with self._lock:
                row = self._conn.execute("SELECT json FROM kv WHERE key=?", (key,)).fetchone()
            return json.loads(row[0]) if row else default
        except Exception as exc:
            print(f"[state] 讀 {key} 失敗:{exc}")
            return default

    def close(self) -> None:
        if self._conn is not None:
            with self._lock:
                self._conn.close()
            self._conn = None
