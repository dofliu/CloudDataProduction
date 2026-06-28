"""Historian:把遙測寫入持久層(docs/04 §Historian)。

階段一 → 階段二的橋:學生之後用 SQL 撈歷史訓練模型。
三種後端(DB_BACKEND):
  - sqlite   :本機檔案(stdlib sqlite3,免 Docker,進程重啟資料不失)—— 本機開發預設
  - timescale:TimescaleDB / PostgreSQL(asyncpg)—— 5090 production
  - memory   :in-memory ring buffer(不持久,僅驗證用)
**容錯設計**:後端連不上時自動降級為 in-memory,引擎照常跑、/api/history 仍可回最近資料。

訊號取樣節流到約 2 Hz(wall),對退化曲線解析度綽綽有餘,也不灌爆 DB。
"""
from __future__ import annotations

import asyncio
import sqlite3
import threading
from collections import defaultdict, deque
from typing import Deque, Dict, List, Optional, Tuple

# ── TimescaleDB / PostgreSQL schema ──────────────────────
_PG_CREATE = """
CREATE TABLE IF NOT EXISTS telemetry (
    time      TIMESTAMPTZ      NOT NULL,
    sim_t     DOUBLE PRECISION NOT NULL,
    device_id TEXT             NOT NULL,
    tag       TEXT             NOT NULL,
    value     DOUBLE PRECISION
);
"""
_PG_HYPERTABLE = "SELECT create_hypertable('telemetry', 'time', if_not_exists => TRUE);"

# ── SQLite schema(wall_t 存 epoch 秒,查詢用)────────────
_SQLITE_CREATE = """
CREATE TABLE IF NOT EXISTS telemetry (
    wall_t    REAL NOT NULL,
    sim_t     REAL NOT NULL,
    device_id TEXT NOT NULL,
    tag       TEXT NOT NULL,
    value     REAL
);
"""
_SQLITE_INDEX = "CREATE INDEX IF NOT EXISTS idx_tel ON telemetry(device_id, tag, wall_t);"


class Historian:
    def __init__(
        self,
        dsn: str,
        enabled: bool = True,
        backend: str = "memory",
        sqlite_path: str = "historian.db",
        sample_interval_s: float = 0.5,
        mem_maxlen: int = 20000,
    ):
        self.dsn = dsn
        self.enabled = enabled
        self.backend = (backend or "memory").lower()
        self.sqlite_path = sqlite_path
        self.sample_interval_s = sample_interval_s

        self._pool = None                     # asyncpg pool(timescale)
        self._sqlite: Optional[sqlite3.Connection] = None
        self._sqlite_lock = threading.Lock()
        self.degraded: bool = False           # True = 用 in-memory fallback
        self._buffer: List[tuple] = []        # 待寫 DB 的批次列
        self._mem: Dict[Tuple[str, str], Deque[tuple]] = defaultdict(
            lambda: deque(maxlen=mem_maxlen)
        )
        self._last_sample_wall: float = 0.0
        self._flush_task: Optional[asyncio.Task] = None
        self._running = False

    # ── 連線 ────────────────────────────────────────────────
    async def connect(self) -> None:
        if not self.enabled or self.backend == "memory":
            self.degraded = True
            print("[historian] in-memory 模式(不持久)")
            return
        if self.backend == "sqlite":
            try:
                self._sqlite = sqlite3.connect(self.sqlite_path, check_same_thread=False)
                with self._sqlite_lock:
                    self._sqlite.execute(_SQLITE_CREATE)
                    self._sqlite.execute(_SQLITE_INDEX)
                    self._sqlite.commit()
                print(f"[historian] SQLite 持久化:{self.sqlite_path}")
            except Exception as exc:
                self.degraded = True
                print(f"[historian] 開 SQLite 失敗,降級 in-memory:{exc}")
            return
        # timescale / postgres
        try:
            import asyncpg  # 延遲匯入:未裝也能降級執行

            self._pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=4)
            async with self._pool.acquire() as conn:
                await conn.execute(_PG_CREATE)
                try:
                    await conn.execute(_PG_HYPERTABLE)
                except Exception as exc:
                    print(f"[historian] create_hypertable 略過(非 TimescaleDB?):{exc}")
            print("[historian] 已連上 TimescaleDB")
        except Exception as exc:
            self.degraded = True
            print(f"[historian] 連 DB 失敗,降級為 in-memory:{exc}")

    # ── 訂閱者:收 snapshot → 取樣 → 入緩衝 ─────────────────
    async def on_snapshot(self, snapshot: dict) -> None:
        wall_t = snapshot["wall_t"]
        if wall_t - self._last_sample_wall < self.sample_interval_s:
            return
        self._last_sample_wall = wall_t
        sim_t = snapshot["sim_t"]

        for device_id, dev in snapshot["devices"].items():
            for tag, value in dev["tags"].items():
                if self.degraded:
                    self._mem[(device_id, tag)].append((wall_t, sim_t, float(value)))
                else:
                    self._buffer.append((wall_t, sim_t, device_id, tag, float(value)))

    # ── 批次 flush ──────────────────────────────────────────
    async def _flush_loop(self) -> None:
        while self._running:
            await asyncio.sleep(1.0)
            await self._flush()

    async def _flush(self) -> None:
        if self.degraded or not self._buffer:
            return
        batch, self._buffer = self._buffer, []
        try:
            if self.backend == "sqlite":
                await asyncio.to_thread(self._sqlite_write, batch)
            elif self._pool is not None:
                async with self._pool.acquire() as conn:
                    await conn.executemany(
                        "INSERT INTO telemetry(time, sim_t, device_id, tag, value) "
                        "VALUES (to_timestamp($1), $2, $3, $4, $5)",
                        batch,
                    )
        except Exception as exc:
            print(f"[historian] flush 失敗,改寫 in-memory:{exc}")
            self.degraded = True
            for wall_t, sim_t, device_id, tag, value in batch:
                self._mem[(device_id, tag)].append((wall_t, sim_t, value))

    def _sqlite_write(self, batch: List[tuple]) -> None:
        with self._sqlite_lock:
            self._sqlite.executemany(
                "INSERT INTO telemetry(wall_t, sim_t, device_id, tag, value) VALUES (?,?,?,?,?)",
                batch,
            )
            self._sqlite.commit()

    def start_background(self) -> None:
        self._running = True
        self._flush_task = asyncio.create_task(self._flush_loop())

    async def close(self) -> None:
        self._running = False
        await self._flush()
        if self._pool is not None:
            await self._pool.close()
        if self._sqlite is not None:
            with self._sqlite_lock:
                self._sqlite.close()

    # ── 查詢:GET /api/history ───────────────────────────────
    async def query(
        self,
        device_id: str,
        tag: str,
        t_from: Optional[float] = None,
        t_to: Optional[float] = None,
        limit: int = 5000,
    ) -> List[dict]:
        if self.degraded:
            rows = list(self._mem.get((device_id, tag), []))
            if t_from is not None:
                rows = [r for r in rows if r[0] >= t_from]
            if t_to is not None:
                rows = [r for r in rows if r[0] <= t_to]
            return [{"wall_t": w, "sim_t": s, "value": v} for (w, s, v) in rows[-limit:]]

        if self.backend == "sqlite":
            return await asyncio.to_thread(self._sqlite_query, device_id, tag, t_from, t_to, limit)

        clauses = ["device_id = $1", "tag = $2"]
        params: list = [device_id, tag]
        if t_from is not None:
            params.append(t_from)
            clauses.append(f"time >= to_timestamp(${len(params)})")
        if t_to is not None:
            params.append(t_to)
            clauses.append(f"time <= to_timestamp(${len(params)})")
        params.append(limit)
        sql = (
            "SELECT extract(epoch from time) AS wall_t, sim_t, value FROM telemetry "
            f"WHERE {' AND '.join(clauses)} ORDER BY time DESC LIMIT ${len(params)}"
        )
        async with self._pool.acquire() as conn:
            records = await conn.fetch(sql, *params)
        return [
            {"wall_t": r["wall_t"], "sim_t": r["sim_t"], "value": r["value"]}
            for r in reversed(records)
        ]

    def _sqlite_query(self, device_id, tag, t_from, t_to, limit) -> List[dict]:
        clauses = ["device_id = ?", "tag = ?"]
        params: list = [device_id, tag]
        if t_from is not None:
            clauses.append("wall_t >= ?"); params.append(t_from)
        if t_to is not None:
            clauses.append("wall_t <= ?"); params.append(t_to)
        params.append(limit)
        sql = (f"SELECT wall_t, sim_t, value FROM telemetry WHERE {' AND '.join(clauses)} "
               f"ORDER BY wall_t DESC LIMIT ?")
        with self._sqlite_lock:
            rows = self._sqlite.execute(sql, params).fetchall()
        return [{"wall_t": w, "sim_t": s, "value": v} for (w, s, v) in reversed(rows)]
