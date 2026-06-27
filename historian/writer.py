"""Historian:把遙測寫入 TimescaleDB(docs/04 §Historian)。

階段一 → 階段二的橋:學生之後用 SQL 撈歷史訓練模型。
**容錯設計**:連不上 DB 時自動降級為 in-memory ring buffer,引擎照常跑、
/api/history 仍可回最近資料 —— 確保 P0「會動的垂直切片」不被 DB 卡住。

訊號取樣節流到約 2 Hz(wall),對退化曲線解析度綽綽有餘,也不灌爆 DB。
"""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from typing import Deque, Dict, List, Optional, Tuple

_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS telemetry (
    time      TIMESTAMPTZ      NOT NULL,
    sim_t     DOUBLE PRECISION NOT NULL,
    device_id TEXT             NOT NULL,
    tag       TEXT             NOT NULL,
    value     DOUBLE PRECISION
);
"""
# create_hypertable 需 timescaledb extension;失敗(純 PostgreSQL)時退回普通表也能用
_HYPERTABLE_SQL = "SELECT create_hypertable('telemetry', 'time', if_not_exists => TRUE);"


class Historian:
    def __init__(
        self,
        dsn: str,
        enabled: bool = True,
        sample_interval_s: float = 0.5,
        mem_maxlen: int = 20000,
    ):
        self.dsn = dsn
        self.enabled = enabled
        self.sample_interval_s = sample_interval_s

        self._pool = None
        self.degraded: bool = False          # True = 用 in-memory fallback
        self._buffer: List[tuple] = []       # 待寫 DB 的批次列
        self._mem: Dict[Tuple[str, str], Deque[tuple]] = defaultdict(
            lambda: deque(maxlen=mem_maxlen)
        )
        self._last_sample_wall: float = 0.0
        self._flush_task: Optional[asyncio.Task] = None
        self._running = False

    # ── 連線 ────────────────────────────────────────────────
    async def connect(self) -> None:
        if not self.enabled:
            self.degraded = True
            print("[historian] 已停用 DB,使用 in-memory 模式")
            return
        try:
            import asyncpg  # 延遲匯入:未裝也能降級執行

            self._pool = await asyncpg.create_pool(self.dsn, min_size=1, max_size=4)
            async with self._pool.acquire() as conn:
                await conn.execute(_CREATE_SQL)
                try:
                    await conn.execute(_HYPERTABLE_SQL)
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
                row = (wall_t, sim_t, device_id, tag, float(value))
                if self.degraded:
                    self._mem[(device_id, tag)].append((wall_t, sim_t, float(value)))
                else:
                    self._buffer.append(row)

    # ── 批次 flush ──────────────────────────────────────────
    async def _flush_loop(self) -> None:
        while self._running:
            await asyncio.sleep(1.0)
            await self._flush()

    async def _flush(self) -> None:
        if self.degraded or not self._buffer or self._pool is None:
            return
        batch, self._buffer = self._buffer, []
        try:
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

    def start_background(self) -> None:
        self._running = True
        self._flush_task = asyncio.create_task(self._flush_loop())

    async def close(self) -> None:
        self._running = False
        await self._flush()
        if self._pool is not None:
            await self._pool.close()

    # ── 查詢:GET /api/history ───────────────────────────────
    async def query(
        self,
        device_id: str,
        tag: str,
        t_from: Optional[float] = None,
        t_to: Optional[float] = None,
        limit: int = 5000,
    ) -> List[dict]:
        if self.degraded or self._pool is None:
            rows = list(self._mem.get((device_id, tag), []))
            if t_from is not None:
                rows = [r for r in rows if r[0] >= t_from]
            if t_to is not None:
                rows = [r for r in rows if r[0] <= t_to]
            rows = rows[-limit:]
            return [{"wall_t": w, "sim_t": s, "value": v} for (w, s, v) in rows]

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
        # DESC 取回後反轉成時間遞增,方便畫曲線
        return [
            {"wall_t": r["wall_t"], "sim_t": r["sim_t"], "value": r["value"]}
            for r in reversed(records)
        ]
