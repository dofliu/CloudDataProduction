"""取數介面(T14)的契約測試 —— 進 CI。

守的是四件事,每一件都曾經是(或很容易變成)真的會咬人的問題:

  ① **舊呼叫零回歸**:?device=&tag= 的回傳形狀、欄位名一個字都不能變。
     學生已經寫好的連線程式與既有前端不能因為升級而壞掉。
  ② **降採樣的數字要對**:avg / min / max / count 拿手算得出來的資料驗,
     而且三種後端(sqlite / degraded in-memory)必須逐列相同 —— 降級時
     學生不能拿到對不上的數字。
  ③ **wide 不能是破的**:limit 在 wide 是「時間列數」。照長列數截斷會讓最舊那個
     時間點少掉幾欄;要了卻沒資料的序列要列進 missing,不能靜靜少一欄。
  ④ **唯讀 SQL 真的唯讀**:語法閘門擋得住是一回事,**繞過閘門直接打資料庫**
     也必須寫不進去 —— 那才是真正的邊界。

跑法:python3 tests/test_data_access.py(回傳 0/1 供 CI)
"""
from __future__ import annotations

import asyncio
import io
import os
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from historian.writer import Historian  # noqa: E402

_fails: list[str] = []


def check(ok: bool, name: str, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"\n        {detail}" if detail else ""))
    if not ok:
        _fails.append(name)


# ── 造一份可以「手算」的資料 ────────────────────────────────
# 每 0.5 秒一拍、共 40 拍 = 20 秒。dA.vib = 1..40,dB.vib = 100..140(step 1)。
# 10 秒一桶 → 每桶 20 筆,第一桶 dA 是 1..20(avg 10.5 / min 1 / max 20 / count 20)。
BASE_T = 1_700_000_000.0
N_TICKS = 40
SNAPSHOTS = [
    {
        "wall_t": BASE_T + i * 0.5,
        "sim_t": i * 5.0,
        "devices": {
            "dA": {"tags": {"vib": 1.0 + i, "temp": 200.0 - i}},
            "dB": {"tags": {"vib": 100.0 + i}},
        },
    }
    for i in range(N_TICKS)
]


async def _feed(h: Historian) -> None:
    await h.connect()
    h.sample_interval_s = 0.0
    for sn in SNAPSHOTS:
        await h.on_snapshot(sn)
    if h._buffer:
        await h._flush()


async def _make(backend: str, path: str) -> Historian:
    h = Historian(dsn="", backend=backend, sqlite_path=path)
    await _feed(h)
    return h


# ── ② 降採樣的數字 + 後端一致 ──────────────────────────────
async def test_bucket_math(tmp: str) -> None:
    print("\n降採樣:數字要對,而且三種後端要一致")
    mem = await _make("memory", os.path.join(tmp, "m.db"))
    sql = await _make("sqlite", os.path.join(tmp, "s.db"))
    check(mem.degraded and not sql.degraded, "memory 走降級、sqlite 走真後端",
          f"degraded: memory={mem.degraded} / sqlite={sql.degraded}")

    for h, label in ((mem, "memory"), (sql, "sqlite")):
        rows = await h.query_multi(["dA"], ["vib"], bucket_s=10.0)
        first = next((r for r in rows if r["t"] == BASE_T), None)
        ok = (first is not None and first["count"] == 20
              and abs(first["avg"] - 10.5) < 1e-9
              and abs(first["min"] - 1.0) < 1e-9
              and abs(first["max"] - 20.0) < 1e-9)
        check(ok, f"{label}:第一桶 avg=10.5 / min=1 / max=20 / count=20(手算值)",
              f"實得 {first}")

    def norm(rows, keys):
        return sorted(tuple([round(r["t"], 6), r["device"], r["tag"]]
                            + [round(float(r[k]), 9) for k in keys]) for r in rows)

    for bucket, keys in ((0.0, ["value"]), (10.0, ["avg", "min", "max", "count"])):
        a = await mem.query_multi(["dA", "dB"], ["vib", "temp"], bucket_s=bucket)
        b = await sql.query_multi(["dA", "dB"], ["vib", "temp"], bucket_s=bucket)
        check(norm(a, keys) == norm(b, keys) and len(a) > 0,
              f"memory 與 sqlite 逐列相同(bucket={bucket:g})",
              f"{len(a)} 列 vs {len(b)} 列")

    # 峰值不能被平均吃掉 —— 這正是降採樣要吐 max 的理由
    rows = await sql.query_multi(["dA"], ["vib"], bucket_s=20.0)
    check(all(r["max"] > r["avg"] > r["min"] for r in rows),
          "每個桶都保住了 min < avg < max(峰值沒被平均抹掉)",
          f"{len(rows)} 個桶")
    await mem.close(); await sql.close()


# ── ①③ API 契約 ───────────────────────────────────────────
async def test_api(tmp: str) -> None:
    print("\n/api/history:舊呼叫零回歸 + wide 不能是破的")
    try:
        from fastapi.testclient import TestClient
        from api.rest import create_app
    except ImportError:
        print("  SKIP  fastapi / httpx 未安裝 —— 引擎層的取數契約已在上一段驗過")
        return

    class _FakeDevice:
        pass

    h = await _make("sqlite", os.path.join(tmp, "api.db"))

    class _World:
        devices = {"dA": _FakeDevice(), "dB": _FakeDevice()}
        companies: dict = {}

    app = create_app(_World(), h, None, {"teacher_token": "tt"})
    c = TestClient(app)

    # ① 舊呼叫:形狀一個字都不能變
    r = c.get("/api/history?device=dA&tag=vib&limit=10")
    j = r.json()
    check(r.status_code == 200 and set(j) == {"device", "tag", "count", "degraded", "points"},
          "舊呼叫回傳的頂層欄位完全沒變", f"實得 {sorted(j)}")
    check(bool(j["points"]) and set(j["points"][0]) == {"wall_t", "sim_t", "value"},
          "舊呼叫的點位欄位完全沒變(wall_t / sim_t / value)",
          f"實得 {sorted(j['points'][0])}")

    # ③ wide:limit 是時間列數,每列都要滿(不能有因為截斷造成的破洞)
    r = c.get("/api/history?devices=dA,dB&tags=vib&limit=5")
    j = r.json()
    cols = j["columns"]
    holes = [p for p in j["points"] if any(p.get(cl) is None for cl in cols)]
    check(len(j["points"]) == 5 and not holes,
          "wide 的 limit 是「時間列數」,每一列所有欄位都有值",
          f"{len(j['points'])} 列 / {len(cols)} 欄 / 破洞 {len(holes)} 列")

    # 要了卻沒資料的序列要講出來(dB 沒有 temp)
    r = c.get("/api/history?devices=dA,dB&tags=vib,temp&limit=3")
    check(r.json().get("missing") == ["dB:temp"],
          "要了卻無資料的序列列進 missing(不靜靜少一欄)",
          f"missing={r.json().get('missing')}")

    # long:降採樣的四個統計量都在
    r = c.get("/api/history?devices=dA&tags=vib&bucket=10&shape=long")
    p0 = r.json()["points"][0]
    check({"avg", "min", "max", "count"} <= set(p0),
          "long + bucket 四個統計量都在", f"欄位 {sorted(p0)}")

    # wide + agg:一格只放一個統計量,由 agg 決定
    r = c.get("/api/history?devices=dA&tags=vib&bucket=10&agg=max")
    j = r.json()
    check(j["value"] == "max" and abs(j["points"][0]["vib"] - 20.0) < 1e-9,
          "wide + bucket 由 ?agg= 決定放哪個統計量(agg=max → 20.0)",
          f"value={j['value']} 首格={j['points'][0].get('vib')}")

    # CSV:用 csv 模組解得開、表頭正確
    import csv as _csv
    r = c.get("/api/history?devices=dA,dB&tags=vib&bucket=10&format=csv")
    text = r.text.lstrip("﻿")
    rdr = list(_csv.DictReader(io.StringIO(text)))
    check(r.headers["content-type"].startswith("text/csv")
          and rdr and set(rdr[0]) == {"t", "sim_t", "dA:vib", "dB:vib"},
          "CSV 解得開且表頭正確", f"表頭 {sorted(rdr[0]) if rdr else '(空)'}")
    check(r.text.startswith("﻿"), "CSV 帶 UTF-8 BOM(Excel 開中文不亂碼)")

    # 錯誤處理
    for q, code in (("?devices=nope&tags=vib", 404),
                    ("?devices=dA&tags=vib&agg=median", 422),
                    ("?devices=dA&tags=vib&shape=blah", 422),
                    ("?tags=vib", 422)):
        check(c.get("/api/history" + q).status_code == code,
              f"錯誤參數回 {code}:{q}")
    await h.close()


# ── ④ 唯讀 SQL ─────────────────────────────────────────────
async def test_sql(tmp: str) -> None:
    print("\n唯讀 SQL:語法閘門 + **資料庫層**都要擋得住寫入")
    T = Historian.SQL_TABLES
    try:
        from api.rest import check_readonly_sql
    except ImportError:
        check_readonly_sql = None
        print("  SKIP  語法閘門(fastapi 未安裝)—— 下面**資料庫層**那道照跑,那才是真邊界")

    allow = [
        "SELECT * FROM telemetry LIMIT 5",
        "select device_id, avg(value) from telemetry group by device_id",
        "WITH v AS (SELECT * FROM events) SELECT COUNT(*) FROM v",
        "SELECT * FROM telemetry /* comment */ WHERE tag='vib'",
    ]
    block = [
        ("DELETE FROM telemetry", "寫入"),
        ("UPDATE telemetry SET value=0", "寫入"),
        ("INSERT INTO telemetry VALUES (1,1,'a','b',1)", "寫入"),
        ("DROP TABLE telemetry", "DDL"),
        ("SELECT 1; DROP TABLE telemetry", "多句"),
        ("SELECT * FROM sqlite_master", "非白名單表"),
        ("PRAGMA table_info(telemetry)", "PRAGMA"),
        ("ATTACH DATABASE '/tmp/x.db' AS x", "ATTACH"),
        ("SELECT * FROM telemetry -- ok\nUNION SELECT * FROM sqlite_master", "註解後夾帶"),
        ("", "空查詢"),
    ]
    if check_readonly_sql is not None:
        check(all(check_readonly_sql(q, T) is None for q in allow),
              f"{len(allow)} 句正當查詢都放行",
              str([q[:30] for q in allow if check_readonly_sql(q, T)]))
        bad = [(q, why) for q, why in block if check_readonly_sql(q, T) is None]
        check(not bad, f"{len(block)} 句危險 / 誤用查詢都擋下", f"漏擋:{bad}")

    # **真正的邊界**:繞過語法閘門,直接請 historian 跑寫入
    h = await _make("sqlite", os.path.join(tmp, "ro.db"))
    n_before = (await h.query_sql("SELECT COUNT(*) FROM telemetry"))[1][0][0]
    blocked_by_db = []
    for stmt in ("DELETE FROM telemetry",
                 "UPDATE telemetry SET value = 0",
                 "DROP TABLE telemetry",
                 "INSERT INTO telemetry VALUES (1,1,'x','y',1)"):
        try:
            await h.query_sql(stmt)
            blocked_by_db.append((stmt, "沒擋住!"))
        except Exception:
            pass
    n_after = (await h.query_sql("SELECT COUNT(*) FROM telemetry"))[1][0][0]
    check(not blocked_by_db and n_before == n_after and n_before > 0,
          "繞過語法閘門直接打資料庫:**資料庫自己**拒絕寫入,資料一列沒少",
          f"漏擋 {blocked_by_db};列數 {n_before} → {n_after}")

    # 學生面不該撈得到 ground-truth
    cols, _ = await h.query_sql("SELECT * FROM events LIMIT 1")
    cols2, _ = await h.query_sql("SELECT * FROM production LIMIT 1")
    leak = {c.lower() for c in (*cols, *cols2)} & {"component", "health", "fault_type", "severity"}
    check(not leak, "events / production 沒有 ground-truth 欄位(元件名 / 健康度)",
          f"外洩欄位:{leak or '無'}")

    # 降級模式要誠實說「這裡沒有 SQL」,不能假裝
    mem = await _make("memory", os.path.join(tmp, "m2.db"))
    try:
        await mem.query_sql("SELECT 1")
        check(False, "降級模式下 query_sql 要明確拒絕")
    except RuntimeError as exc:
        check("降級" in str(exc) or "memory" in str(exc).lower(),
              "降級模式誠實拒絕並指路(不假裝能跑 SQL)", str(exc)[:70])
    await h.close(); await mem.close()


async def main() -> int:
    print("取數介面(T14)契約測試")
    with tempfile.TemporaryDirectory() as tmp:
        await test_bucket_math(tmp)
        await test_api(tmp)
        await test_sql(tmp)
    print(f"\n失敗 {len(_fails)} 項" + ("" if not _fails else ":\n  - " + "\n  - ".join(_fails)))
    return 1 if _fails else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
