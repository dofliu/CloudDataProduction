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

# ── 事件 / 逐件生產 / 每小時彙總(docs/資料盤點_生產數據完整性.md 的 P1)────────────
#
# 先前這三種資料只存在於「當下」:事件廣播給工單與告警評分就丟掉、產線帳只有即時視圖、
# 完工工單每台只留最近 8 張。學生因此算不出 MTBF、做不出停機 Pareto、追溯不到一件不良品。
#
# 三張表的分工(與真 historian 同一套邏輯:明細短期、彙總長期):
#   events            狀態轉換 / 故障,帶停機原因 → MTBF、MTTR、停機 Pareto
#   production        逐件明細(序號 / 良不良 / 不良類型)→ 追溯、良率與參數的相關
#   production_hourly 每台每小時 × 每種結果的件數 → 一學期的良率趨勢(明細清掉也還在)
#
# events 刻意**不存故障元件名** —— 那是 ground-truth(等於寫著答案),學生面只給
# 「這台在這個時間點進了 fault」這種現場看得到的事實。
_SQLITE_EVENTS = """
CREATE TABLE IF NOT EXISTS events (
    wall_t      REAL NOT NULL,
    sim_t       REAL NOT NULL,
    device_id   TEXT NOT NULL,
    company_id  TEXT,
    type        TEXT NOT NULL,
    from_state  TEXT,
    to_state    TEXT,
    stop_reason TEXT
);
"""
_SQLITE_PRODUCTION = """
CREATE TABLE IF NOT EXISTS production (
    wall_t     REAL NOT NULL,
    sim_t      REAL NOT NULL,
    serial     TEXT NOT NULL,
    device_id  TEXT NOT NULL,
    company_id TEXT,
    template   TEXT,
    good       INTEGER NOT NULL,
    defect     TEXT,
    order_id   TEXT
);
"""
_SQLITE_HOURLY = """
CREATE TABLE IF NOT EXISTS production_hourly (
    hour_t     REAL NOT NULL,
    device_id  TEXT NOT NULL,
    company_id TEXT,
    template   TEXT,
    defect     TEXT NOT NULL,
    pieces     INTEGER NOT NULL,
    PRIMARY KEY (hour_t, device_id, defect)
);
"""
_SQLITE_MORE_INDEX = [
    "CREATE INDEX IF NOT EXISTS idx_ev ON events(device_id, wall_t);",
    "CREATE INDEX IF NOT EXISTS idx_ev_reason ON events(stop_reason, wall_t);",
    "CREATE INDEX IF NOT EXISTS idx_prod ON production(device_id, wall_t);",
    "CREATE INDEX IF NOT EXISTS idx_prod_serial ON production(serial);",
    "CREATE INDEX IF NOT EXISTS idx_hourly ON production_hourly(device_id, hour_t);",
]

_PG_EVENTS = _SQLITE_EVENTS.replace("REAL", "DOUBLE PRECISION").replace("INTEGER", "INT")
_PG_PRODUCTION = _SQLITE_PRODUCTION.replace("REAL", "DOUBLE PRECISION").replace("INTEGER", "INT")
_PG_HOURLY = _SQLITE_HOURLY.replace("REAL", "DOUBLE PRECISION").replace("INTEGER", "INT")

HOUR_S = 3600.0


class Historian:
    def __init__(
        self,
        dsn: str,
        enabled: bool = True,
        backend: str = "memory",
        sqlite_path: str = "historian.db",
        sample_interval_s: float = 0.5,
        mem_maxlen: int = 20000,
        retention_days: float = 14.0,
        production_retention_days: float = 2.0,
    ):
        self.dsn = dsn
        self.enabled = enabled
        self.backend = (backend or "memory").lower()
        self.sqlite_path = sqlite_path
        self.sample_interval_s = sample_interval_s
        # 保留期:課堂規模(154 台 × ~11 tag、5 秒一拍)一天就寫 ~2900 萬列 ≈ 2-3 GB,
        # 而教學只查「當週資料窗」、凍結週包又是離線預產 —— 不清就只是白占硬碟。
        # 0 = 不清(要留整學期做期末大分析時再開)。
        self.retention_days = float(retention_days)
        # 逐件明細的保留期。課堂園區 89 台 producer 在 ×120 下一天寫上千萬件 ——
        # 明細留兩天(夠學生做追溯與良率相關),長期趨勢靠 production_hourly(小到可以永久留)。
        # 這也是真 historian 的做法:raw 短期、aggregate 長期。
        self.production_retention_days = float(production_retention_days)

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
        # 事件 / 逐件 / 每小時彙總的待寫緩衝(degraded 時退回有界的記憶體佇列)
        self._ev_buffer: List[tuple] = []
        self._prod_buffer: List[tuple] = []
        self._hourly_acc: Dict[tuple, int] = defaultdict(int)   # (hour_t, dev, comp, tmpl, defect) → 件數
        self._mem_events: Deque[dict] = deque(maxlen=mem_maxlen)
        self._mem_prod: Deque[dict] = deque(maxlen=mem_maxlen)

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
                    for ddl in (_SQLITE_EVENTS, _SQLITE_PRODUCTION, _SQLITE_HOURLY):
                        self._sqlite.execute(ddl)
                    for idx in _SQLITE_MORE_INDEX:
                        self._sqlite.execute(idx)
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
                for ddl in (_PG_EVENTS, _PG_PRODUCTION, _PG_HOURLY):
                    await conn.execute(ddl)
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

    # ── 訂閱者:事件 / 逐件生產 ─────────────────────────────
    async def on_event(self, ev: dict) -> None:
        """狀態轉換 / 故障事件落地。先前這些事件只廣播給工單 / 預測 / 告警評分就消失了,
        歷史上沒留下任何一列 —— MTBF、MTTR、停機 Pareto 因此全都算不出來。"""
        import time as _time
        row = (
            float(ev.get("wall_t") or _time.time()),
            float(ev.get("sim_t") or 0.0),
            str(ev.get("device") or ""),
            ev.get("company"),
            str(ev.get("type") or ""),
            ev.get("from"),
            ev.get("to"),
            ev.get("stop_reason"),
        )
        if self.degraded:
            self._mem_events.append({
                "wall_t": row[0], "sim_t": row[1], "device_id": row[2], "company_id": row[3],
                "type": row[4], "from_state": row[5], "to_state": row[6], "stop_reason": row[7]})
        else:
            self._ev_buffer.append(row)

    async def on_pieces(self, pieces: List[dict]) -> None:
        """逐件生產明細落地 + 同步累積每小時彙總(明細清掉後趨勢還在)。"""
        import time as _time
        wall_t = _time.time()
        hour_t = (wall_t // HOUR_S) * HOUR_S
        for pc in pieces:
            good = bool(pc.get("good"))
            defect = "" if good else str(pc.get("defect") or "unknown")
            row = (wall_t, float(pc.get("sim_t") or 0.0), str(pc.get("serial") or ""),
                   str(pc.get("device") or ""), pc.get("company"), pc.get("template"),
                   1 if good else 0, pc.get("defect"), pc.get("order"))
            if self.degraded:
                self._mem_prod.append({
                    "wall_t": row[0], "sim_t": row[1], "serial": row[2], "device_id": row[3],
                    "company_id": row[4], "template": row[5], "good": bool(good),
                    "defect": row[7], "order_id": row[8]})
            else:
                self._prod_buffer.append(row)
            self._hourly_acc[(hour_t, row[3], row[4], row[5], defect)] += 1

    # ── 批次 flush + 定期清舊 ───────────────────────────────
    async def _flush_loop(self) -> None:
        tick = 0
        while self._running:
            await asyncio.sleep(1.0)
            await self._flush()
            tick += 1
            # 每小時清一次超過保留期的列(啟動後 60 秒先清一輪,舊 DB 立刻止血)
            if self.retention_days > 0 and (tick == 60 or tick % 3600 == 0):
                await self._prune()

    async def _prune(self) -> None:
        if self.degraded:
            return
        import time as _time
        cutoff = _time.time() - self.retention_days * 86400.0
        try:
            if self.backend == "sqlite":
                deleted = await asyncio.to_thread(self._sqlite_prune, cutoff)
            elif self._pool is not None:
                async with self._pool.acquire() as conn:
                    res = await conn.execute(
                        "DELETE FROM telemetry WHERE time < to_timestamp($1)", cutoff)
                    await conn.execute("DELETE FROM events WHERE wall_t < $1", cutoff)
                    if self.production_retention_days > 0:
                        await conn.execute(
                            "DELETE FROM production WHERE wall_t < $1",
                            _time.time() - self.production_retention_days * 86400.0)
                deleted = int(res.split()[-1]) if res else 0
            else:
                return
            if deleted:
                print(f"[historian] 保留期 {self.retention_days:g} 天:清除 {deleted} 列舊 telemetry")
        except Exception as exc:
            print(f"[historian] 清舊失敗(下輪再試):{exc}")

    def _sqlite_prune(self, cutoff: float) -> int:
        with self._sqlite_lock:
            cur = self._sqlite.execute("DELETE FROM telemetry WHERE wall_t < ?", (cutoff,))
            # 事件與 telemetry 同一個保留期;逐件明細更短(見 production_retention_days),
            # production_hourly **不清** —— 一學期的良率趨勢就靠它,而它一天也才幾千列。
            self._sqlite.execute("DELETE FROM events WHERE wall_t < ?", (cutoff,))
            if self.production_retention_days > 0:
                import time as _time
                self._sqlite.execute(
                    "DELETE FROM production WHERE wall_t < ?",
                    (_time.time() - self.production_retention_days * 86400.0,))
            self._sqlite.commit()
            # 釋放出的頁面會被之後的寫入重複使用(檔案停止成長);要實際縮小檔案
            # 得離線跑一次 VACUUM —— 那會鎖表數十秒,不適合在活廠自動做。
            return cur.rowcount

    async def _flush(self) -> None:
        await self._flush_records()
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

    # ── 事件 / 逐件 / 彙總的 flush ─────────────────────────
    _EV_COLS = "wall_t, sim_t, device_id, company_id, type, from_state, to_state, stop_reason"
    _PROD_COLS = ("wall_t, sim_t, serial, device_id, company_id, template, good, defect, order_id")
    # 彙總是 upsert:同一小時同一台同一種結果只有一列,件數累加(SQLite 3.24+ / PG 都支援)
    _HOURLY_UPSERT_SQLITE = (
        "INSERT INTO production_hourly(hour_t, device_id, company_id, template, defect, pieces) "
        "VALUES (?,?,?,?,?,?) ON CONFLICT(hour_t, device_id, defect) "
        "DO UPDATE SET pieces = pieces + excluded.pieces")
    _HOURLY_UPSERT_PG = (
        "INSERT INTO production_hourly(hour_t, device_id, company_id, template, defect, pieces) "
        "VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(hour_t, device_id, defect) "
        "DO UPDATE SET pieces = production_hourly.pieces + excluded.pieces")

    async def _flush_records(self) -> None:
        if self.degraded:
            return
        evs, self._ev_buffer = self._ev_buffer, []
        prods, self._prod_buffer = self._prod_buffer, []
        hourly = [(k[0], k[1], k[2], k[3], k[4], n) for k, n in self._hourly_acc.items()]
        self._hourly_acc.clear()
        if not (evs or prods or hourly):
            return
        try:
            if self.backend == "sqlite":
                await asyncio.to_thread(self._sqlite_write_records, evs, prods, hourly)
            elif self._pool is not None:
                async with self._pool.acquire() as conn:
                    if evs:
                        await conn.executemany(
                            f"INSERT INTO events({self._EV_COLS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", evs)
                    if prods:
                        await conn.executemany(
                            f"INSERT INTO production({self._PROD_COLS}) "
                            "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", prods)
                    if hourly:
                        await conn.executemany(self._HOURLY_UPSERT_PG, hourly)
        except Exception as exc:
            print(f"[historian] 事件 / 生產紀錄 flush 失敗:{exc}")

    def _sqlite_write_records(self, evs, prods, hourly) -> None:
        with self._sqlite_lock:
            if evs:
                self._sqlite.executemany(
                    f"INSERT INTO events({self._EV_COLS}) VALUES (?,?,?,?,?,?,?,?)", evs)
            if prods:
                self._sqlite.executemany(
                    f"INSERT INTO production({self._PROD_COLS}) VALUES (?,?,?,?,?,?,?,?,?)", prods)
            if hourly:
                self._sqlite.executemany(self._HOURLY_UPSERT_SQLITE, hourly)
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

    # ── 多設備 × 多 tag + 時間桶降採樣(T14)────────────────
    #
    # 為什麼要有這一支:單設備單 tag 的 query() 做不了「一條產線的跨設備相關分析」——
    # 學生得打幾十次 API 再自己對齊時間戳,取數本身變成作業的主要難度,而那不是這門課
    # 想教的東西(要教的是**怎麼從資料看出問題**)。
    #
    # **時間戳天然對齊**:historian 是對同一份 snapshot 取樣的(見 on_snapshot),
    # 一拍裡所有設備所有 tag 共用同一個 wall_t —— 所以多設備的原始點本來就對得齊,
    # 不必先降採樣才能並排。這是這套模擬平台才有的性質,真工廠的多來源資料沒這麼好命,
    # 教材要記得講這個差別。
    #
    # 降採樣吐 avg / min / max / count 四個量,不是只有 avg:
    #   預測性維護看的是**峰值** —— 振動尖峰、溫度突波被平均一抹就不見了。
    #   count 讓學生看得出這個桶裡實際有幾筆(補值與缺值分得開)。
    _AGGS = ("avg", "min", "max", "count")

    async def query_multi(
        self,
        devices: List[str],
        tags: List[str],
        t_from: Optional[float] = None,
        t_to: Optional[float] = None,
        bucket_s: float = 0.0,
        limit: int = 20000,
    ) -> List[dict]:
        """多設備 × 多 tag 查詢。回傳 long 形狀,依 (t, device, tag) 排序。

        bucket_s <= 0 → 原始點:{t, sim_t, device, tag, value}
        bucket_s >  0 → 時間桶:{t, sim_t, device, tag, avg, min, max, count}
                        t = 桶起點(floor(wall_t / bucket) * bucket)
                        sim_t = 桶內最小 sim_t(= 桶起點對應的模擬時間)

        limit 是**回傳列數**上限,取最近的;超過就截斷(API 會回報 truncated)。
        """
        devices = [d for d in dict.fromkeys(devices) if d]
        tags = [t for t in dict.fromkeys(tags) if t]
        if not devices or not tags:
            return []
        if self.degraded:
            return self._mem_query_multi(devices, tags, t_from, t_to, bucket_s, limit)
        if self.backend == "sqlite":
            return await asyncio.to_thread(self._sqlite_query_multi, devices, tags,
                                           t_from, t_to, bucket_s, limit)
        return await self._pg_query_multi(devices, tags, t_from, t_to, bucket_s, limit)

    @staticmethod
    def _bucket_of(wall_t: float, bucket_s: float) -> float:
        return (wall_t // bucket_s) * bucket_s

    def _mem_query_multi(self, devices, tags, t_from, t_to, bucket_s, limit) -> List[dict]:
        """降級模式(in-memory ring buffer)。與 SQL 後端**同一套桶定義**,
        免得學生在降級時拿到對不上的數字。"""
        raw: List[tuple] = []                       # (t, device, tag, sim_t, value)
        for d in devices:
            for tg in tags:
                for (w, s, v) in self._mem.get((d, tg), ()):
                    if t_from is not None and w < t_from:
                        continue
                    if t_to is not None and w > t_to:
                        continue
                    raw.append((w, d, tg, s, v))
        if bucket_s <= 0:
            raw.sort(key=lambda r: (r[0], r[1], r[2]))
            rows = [{"t": w, "sim_t": s, "device": d, "tag": tg, "value": v}
                    for (w, d, tg, s, v) in raw]
            return rows[-limit:]
        acc: Dict[tuple, dict] = {}
        for (w, d, tg, s, v) in raw:
            key = (self._bucket_of(w, bucket_s), d, tg)
            a = acc.get(key)
            if a is None:
                acc[key] = {"sum": v, "min": v, "max": v, "count": 1, "sim_t": s}
            else:
                a["sum"] += v
                a["min"] = min(a["min"], v)
                a["max"] = max(a["max"], v)
                a["count"] += 1
                a["sim_t"] = min(a["sim_t"], s)
        out = [{"t": k[0], "sim_t": a["sim_t"], "device": k[1], "tag": k[2],
                "avg": a["sum"] / a["count"], "min": a["min"], "max": a["max"],
                "count": a["count"]}
               for k, a in acc.items()]
        out.sort(key=lambda r: (r["t"], r["device"], r["tag"]))
        return out[-limit:]

    def _sqlite_query_multi(self, devices, tags, t_from, t_to, bucket_s, limit) -> List[dict]:
        dq = ",".join("?" * len(devices))
        tq = ",".join("?" * len(tags))
        clauses = [f"device_id IN ({dq})", f"tag IN ({tq})"]
        params: list = [*devices, *tags]
        if t_from is not None:
            clauses.append("wall_t >= ?"); params.append(t_from)
        if t_to is not None:
            clauses.append("wall_t <= ?"); params.append(t_to)
        where = " AND ".join(clauses)
        if bucket_s <= 0:
            sql = (f"SELECT wall_t, sim_t, device_id, tag, value FROM telemetry WHERE {where} "
                   f"ORDER BY wall_t DESC LIMIT ?")
            with self._sqlite_lock:
                rows = self._sqlite.execute(sql, [*params, limit]).fetchall()
            out = [{"t": w, "sim_t": s, "device": d, "tag": tg, "value": v}
                   for (w, s, d, tg, v) in rows]
        else:
            # epoch 恆正,CAST(... AS INTEGER) 即 floor —— 與 _bucket_of() 同一套桶定義
            sql = (f"SELECT CAST(wall_t / ? AS INTEGER) * ? AS bt, MIN(sim_t), device_id, tag, "
                   f"AVG(value), MIN(value), MAX(value), COUNT(value) FROM telemetry "
                   f"WHERE {where} GROUP BY bt, device_id, tag ORDER BY bt DESC LIMIT ?")
            with self._sqlite_lock:
                rows = self._sqlite.execute(sql, [bucket_s, bucket_s, *params, limit]).fetchall()
            out = [{"t": bt, "sim_t": st, "device": d, "tag": tg,
                    "avg": av, "min": mn, "max": mx, "count": c}
                   for (bt, st, d, tg, av, mn, mx, c) in rows]
        out.sort(key=lambda r: (r["t"], r["device"], r["tag"]))
        return out

    async def _pg_query_multi(self, devices, tags, t_from, t_to, bucket_s, limit) -> List[dict]:
        params: list = [devices, tags]
        clauses = ["device_id = ANY($1)", "tag = ANY($2)"]
        if t_from is not None:
            params.append(t_from); clauses.append(f"time >= to_timestamp(${len(params)})")
        if t_to is not None:
            params.append(t_to); clauses.append(f"time <= to_timestamp(${len(params)})")
        where = " AND ".join(clauses)
        if bucket_s <= 0:
            params.append(limit)
            sql = ("SELECT extract(epoch from time) AS t, sim_t, device_id, tag, value "
                   f"FROM telemetry WHERE {where} ORDER BY time DESC LIMIT ${len(params)}")
            async with self._pool.acquire() as conn:
                recs = await conn.fetch(sql, *params)
            out = [{"t": r["t"], "sim_t": r["sim_t"], "device": r["device_id"],
                    "tag": r["tag"], "value": r["value"]} for r in recs]
        else:
            params.append(bucket_s)
            b = f"${len(params)}"
            params.append(limit)
            sql = (f"SELECT floor(extract(epoch from time) / {b}) * {b} AS bt, MIN(sim_t) AS sim_t, "
                   "device_id, tag, AVG(value) AS avg, MIN(value) AS mn, MAX(value) AS mx, "
                   "COUNT(value) AS cnt FROM telemetry "
                   f"WHERE {where} GROUP BY bt, device_id, tag ORDER BY bt DESC LIMIT ${len(params)}")
            async with self._pool.acquire() as conn:
                recs = await conn.fetch(sql, *params)
            out = [{"t": r["bt"], "sim_t": r["sim_t"], "device": r["device_id"], "tag": r["tag"],
                    "avg": r["avg"], "min": r["mn"], "max": r["mx"], "count": r["cnt"]}
                   for r in recs]
        out.sort(key=lambda r: (r["t"], r["device"], r["tag"]))
        return out

    # ── 唯讀 SQL(T14 進階)──────────────────────────────────
    #
    # 技術棧選 TimescaleDB 的初衷就是「SQL 對學生分析友善」。REST 再怎麼加參數,
    # 學到的仍是「一支 API」;能寫 SQL 才是可轉移的技能(去業界也是這樣撈資料)。
    #
    # **安全邊界不靠字串比對**。關鍵字黑名單一定繞得過(註解、大小寫、巢狀),所以真正
    # 的防線是**讓資料庫自己拒絕寫入**:
    #   sqlite    另開一條 mode=ro 的唯讀連線(URI 模式)—— 寫入在驅動層就被擋
    #   timescale 在 READ ONLY transaction 裡跑 —— 寫入由 PG 自己拒絕
    # 白名單與語法檢查是**第二層**(讓錯誤訊息友善、擋掉明顯的誤用),不是唯一那層。
    #
    # 四張表都是學生面的事實,不含 ground-truth:events 不存故障元件名、production 只有
    # 品質結果(良/不良/不良類型)。要看「哪個元件在壞」仍得走教師面的 API。
    SQL_TABLES = ("telemetry", "events", "production", "production_hourly")

    async def query_sql(self, sql: str, limit: int = 5000,
                        timeout_s: float = 10.0) -> Tuple[List[str], List[list]]:
        """跑一段唯讀 SQL,回傳 (欄位名, 列)。不支援 memory / 降級模式。"""
        if self.degraded or self.backend not in ("sqlite", "timescale"):
            raise RuntimeError("唯讀 SQL 需要真的資料庫後端(sqlite / timescale);"
                               "目前是 in-memory 降級模式,請改用 /api/history")
        if self.backend == "sqlite":
            return await asyncio.to_thread(self._sqlite_query_sql, sql, limit, timeout_s)
        return await self._pg_query_sql(sql, limit, timeout_s)

    def _sqlite_query_sql(self, sql, limit, timeout_s) -> Tuple[List[str], List[list]]:
        import time as _time
        # 唯讀連線:寫入在**驅動層**就被擋(不是靠我們檢查字串)
        conn = sqlite3.connect(f"file:{self.sqlite_path}?mode=ro", uri=True,
                               check_same_thread=False)
        try:
            deadline = _time.monotonic() + timeout_s
            # 逾時:每跑一批 VM 指令就檢查一次,超時丟例外中止(避免一句慢查詢卡住全班)
            def _guard():
                return 1 if _time.monotonic() > deadline else 0
            conn.set_progress_handler(_guard, 10000)
            cur = conn.execute(sql)
            cols = [d[0] for d in (cur.description or [])]
            rows = [list(r) for r in cur.fetchmany(limit)]
            return cols, rows
        finally:
            conn.close()

    async def _pg_query_sql(self, sql, limit, timeout_s) -> Tuple[List[str], List[list]]:
        async with self._pool.acquire() as conn:
            # READ ONLY transaction:寫入由 PG 自己拒絕
            async with conn.transaction(readonly=True):
                await conn.execute(f"SET LOCAL statement_timeout = {int(timeout_s * 1000)}")
                recs = await conn.fetch(sql)
        cols = list(recs[0].keys()) if recs else []
        return cols, [list(r.values()) for r in recs[:limit]]

    # ── 查詢:事件 / 逐件生產 / 每小時彙總 ──────────────────
    async def query_events(self, device_id=None, company_id=None, ev_type=None,
                           stop_reason=None, t_from=None, t_to=None, limit=2000) -> List[dict]:
        """狀態轉換 / 故障事件。學生用它算 MTBF / MTTR、做停機 Pareto。"""
        cols = ["wall_t", "sim_t", "device_id", "company_id", "type",
                "from_state", "to_state", "stop_reason"]
        filters = [("device_id", device_id), ("company_id", company_id),
                   ("type", ev_type), ("stop_reason", stop_reason)]
        if self.degraded:
            rows = [r for r in self._mem_events
                    if all(v is None or r.get(k) == v for k, v in filters)
                    and (t_from is None or r["wall_t"] >= t_from)
                    and (t_to is None or r["wall_t"] <= t_to)]
            return rows[-limit:]
        return await self._query_table("events", cols, filters, t_from, t_to, limit)

    async def query_production(self, device_id=None, company_id=None, serial=None,
                               good=None, defect=None, t_from=None, t_to=None,
                               limit=2000) -> List[dict]:
        """逐件生產明細(追溯用)。序號 / 良不良 / 不良類型都是現場看得到的品質結果,
        **不含** ground-truth(哪個元件在壞、健康度多少)。"""
        cols = ["wall_t", "sim_t", "serial", "device_id", "company_id", "template",
                "good", "defect", "order_id"]
        filters = [("device_id", device_id), ("company_id", company_id),
                   ("serial", serial), ("defect", defect),
                   ("good", None if good is None else (1 if good else 0))]
        if self.degraded:
            def _match(r):
                for k, v in filters:
                    if v is None:
                        continue
                    rv = int(bool(r["good"])) if k == "good" else r.get(k)
                    if rv != v:
                        return False
                return True
            rows = [r for r in self._mem_prod if _match(r)
                    and (t_from is None or r["wall_t"] >= t_from)
                    and (t_to is None or r["wall_t"] <= t_to)]
            return rows[-limit:]
        rows = await self._query_table("production", cols, filters, t_from, t_to, limit)
        for r in rows:
            r["good"] = bool(r["good"])
        return rows

    async def query_production_hourly(self, device_id=None, company_id=None,
                                      t_from=None, t_to=None, limit=5000) -> List[dict]:
        """每台每小時 × 每種結果的件數(defect='' 代表良品)。明細清掉後趨勢仍在。"""
        cols = ["hour_t", "device_id", "company_id", "template", "defect", "pieces"]
        filters = [("device_id", device_id), ("company_id", company_id)]
        if self.degraded:
            agg: Dict[tuple, int] = defaultdict(int)
            for r in self._mem_prod:
                if device_id and r["device_id"] != device_id:
                    continue
                if company_id and r["company_id"] != company_id:
                    continue
                hour_t = (r["wall_t"] // HOUR_S) * HOUR_S
                if t_from is not None and hour_t < (t_from // HOUR_S) * HOUR_S:
                    continue
                if t_to is not None and hour_t > t_to:
                    continue
                key = (hour_t, r["device_id"], r["company_id"], r["template"],
                       "" if r["good"] else (r["defect"] or "unknown"))
                agg[key] += 1
            out = [{"hour_t": k[0], "device_id": k[1], "company_id": k[2], "template": k[3],
                    "defect": k[4], "pieces": n} for k, n in agg.items()]
            # 還沒 flush 的當下這一批也要算進去,不然剛跑起來的世界看起來像沒生產
            for k, n in self._hourly_acc.items():
                if device_id and k[1] != device_id:
                    continue
                if company_id and k[2] != company_id:
                    continue
                out.append({"hour_t": k[0], "device_id": k[1], "company_id": k[2],
                            "template": k[3], "defect": k[4], "pieces": n})
            return sorted(out, key=lambda r: (r["hour_t"], r["device_id"]))[-limit:]
        return await self._query_table("production_hourly", cols, filters,
                                       t_from, t_to, limit, time_col="hour_t")

    async def _query_table(self, table: str, cols: List[str], filters: List[tuple],
                           t_from, t_to, limit: int, time_col: str = "wall_t") -> List[dict]:
        """三張新表共用的查詢組裝(SQLite ? 佔位 / PG $n 佔位)。"""
        active = [(k, v) for k, v in filters if v is not None]
        if self.backend == "sqlite":
            clauses = [f"{k} = ?" for k, _ in active]
            params = [v for _, v in active]
            if t_from is not None:
                clauses.append(f"{time_col} >= ?"); params.append(t_from)
            if t_to is not None:
                clauses.append(f"{time_col} <= ?"); params.append(t_to)
            where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
            sql = (f"SELECT {', '.join(cols)} FROM {table} {where} "
                   f"ORDER BY {time_col} DESC LIMIT ?")
            params.append(int(limit))
            rows = await asyncio.to_thread(self._sqlite_fetch, sql, params)
            return [dict(zip(cols, r)) for r in reversed(rows)]
        if self._pool is None:
            return []
        clauses, params = [], []
        for k, v in active:
            params.append(v); clauses.append(f"{k} = ${len(params)}")
        if t_from is not None:
            params.append(t_from); clauses.append(f"{time_col} >= ${len(params)}")
        if t_to is not None:
            params.append(t_to); clauses.append(f"{time_col} <= ${len(params)}")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        params.append(int(limit))
        sql = (f"SELECT {', '.join(cols)} FROM {table} {where} "
               f"ORDER BY {time_col} DESC LIMIT ${len(params)}")
        async with self._pool.acquire() as conn:
            records = await conn.fetch(sql, *params)
        return [dict(r) for r in reversed(records)]

    def _sqlite_fetch(self, sql: str, params: list) -> list:
        with self._sqlite_lock:
            return self._sqlite.execute(sql, params).fetchall()

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
