#!/usr/bin/env python3
"""資料鏈契約測試:停機原因碼 / 逐件生產紀錄 / 事件落地(CI)。

這一套守的是 docs/資料盤點_生產數據完整性.md 指出的三個缺口補完後**不能再退回去**:

  ① 產出 = 良品 + 不良品,對得起帳(先前只有一支累積量,良率算不出來)
  ② 停機分得出原因(先前餓料 / 滿料 / 無工單 / 班外全落成同一個 idle)
  ③ 事件與逐件明細真的落地成可查詢的資料(先前廣播完就沒了)

外加一條紅線:學生面的生產資料**不得洩漏 ground-truth**(哪個元件在壞、健康度多少)。

    python3 tests/test_production_records.py     # 回傳 0 = 全過
"""
from __future__ import annotations

import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import yaml  # noqa: E402

from engine.device import PRODUCTION_COUNT_TAGS, STOP_REASON_CODES  # noqa: E402
from engine.world import World  # noqa: E402
from historian.writer import Historian  # noqa: E402

SCENARIO = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "scenarios", "class_park.yaml")

_fails: list[str] = []


def check(cond: bool, label: str, detail: str = "") -> None:
    if cond:
        print(f"  PASS  {label}")
    else:
        _fails.append(label)
        print(f"  FAIL  {label}{(' — ' + detail) if detail else ''}")


def load_world() -> World:
    park = yaml.safe_load(open(SCENARIO, encoding="utf-8"))["park"]
    return World(park)


def count_of(device) -> int:
    name = PRODUCTION_COUNT_TAGS.get(device.template)
    if name is None:
        return 0
    return int(next(t.value for t in device.tags if t.name == name))


# ── ① 逐件記帳守恆 ────────────────────────────────────────
def test_conservation() -> None:
    print("\n① 逐件記帳:產出 = 良品 + 不良品")
    world = load_world()
    pieces: list[dict] = []
    for _ in range(80):
        world.step(12.0)
        pieces.extend(world._pending_pieces)

    producers = [d for d in world.devices.values() if PRODUCTION_COUNT_TAGS.get(d.template)]
    bad = [d.id for d in producers if d.good_count + d.reject_count != count_of(d)]
    check(not bad, f"良品 + 不良品 = 累積量({len(producers)} 台 producer)", f"對不起帳:{bad[:5]}")

    # 明細筆數要與計數器一致 —— 少送一筆,學生的追溯就會斷一件
    per_dev: dict = {}
    for pc in pieces:
        per_dev[pc["device"]] = per_dev.get(pc["device"], 0) + 1
    mismatch = [d.id for d in producers
                if per_dev.get(d.id, 0) != d.good_count + d.reject_count]
    check(not mismatch, "逐件明細筆數 = 良品 + 不良品", f"不符:{mismatch[:5]}")

    serials = [pc["serial"] for pc in pieces]
    check(len(serials) == len(set(serials)), f"工件序號不重複({len(serials)} 件)")
    check(all((pc["defect"] is None) == pc["good"] for pc in pieces),
          "良品沒有不良類型、不良品一定有")

    non_producers = [d for d in world.devices.values()
                     if not PRODUCTION_COUNT_TAGS.get(d.template)]
    check(all(d.good_count == 0 and d.reject_count == 0 for d in non_producers),
          f"非 producer 不記生產帳({len(non_producers)} 台:手臂 / 輸送帶 / 電表 …)")


# ── ② 停機原因碼 ──────────────────────────────────────────
def test_stop_reason() -> None:
    print("\n② 停機原因:分得出「為什麼沒在產」")
    world = load_world()
    for _ in range(40):
        world.step(12.0)

    reasons = {d.stop_reason for d in world.devices.values()}
    check(reasons <= set(STOP_REASON_CODES), "回報的原因碼都在字典裡", f"未知:{reasons - set(STOP_REASON_CODES)}")
    check(all((d.state in ("running", "moving")) == (d.stop_reason == "running")
              for d in world.devices.values()),
          "原因碼與實際狀態一致(在動才叫 running)")

    tagged = [d for d in world.devices.values()
              if any(t.name == "stop_reason_code" for t in d.tags)]
    check(len(tagged) == len(world.devices), f"每台都有 stop_reason_code tag({len(tagged)} 台)")

    # 教師停機 → teacher_stop;故障 → fault;保養 → maintenance
    dev = next(d for d in world.devices.values() if d.template == "cnc_machining_center")
    dev.set_coil("run_enable", False)
    world.step(12.0)
    check(dev.stop_reason == "teacher_stop", "教師 run_enable 停機 → teacher_stop", dev.stop_reason)
    dev.set_coil("run_enable", True)

    comp = next(c for c in dev.components.values() if c.causes_device_fault)
    comp.D = comp.D_fail * 1.5          # 直接推到失效
    world.step(12.0)
    check(dev.stop_reason == "fault", "元件失效 → fault", dev.stop_reason)
    dev.reset()

    # 產線餓料:被 line 管的非首站,入料為 0 時要說 starved
    starved = [d for d in world.devices.values()
               if d.line_enabled and d.line_role in ("mid", "sink") and not d.line_has_input]
    if starved:
        world.step(12.0)
        check(all(d.stop_reason in ("starved", "fault", "maintenance", "teacher_stop")
                  for d in starved),
              f"產線無料的站 → starved({len(starved)} 台)")
    else:
        print("  SKIP  這次取樣沒有餓料的站(產線都吃得飽)")


# ── ③ 事件與逐件明細落地 ─────────────────────────────────
async def _run_historian() -> dict:
    db = tempfile.mktemp(suffix=".db")
    hist = Historian(dsn="", enabled=True, backend="sqlite", sqlite_path=db,
                     sample_interval_s=0.0)
    await hist.connect()
    world = load_world()
    # 讓一台 CNC 的刀具磨到底 → 這一輪一定會有不良品可查
    cnc = next(d for d in world.devices.values() if d.template == "cnc_machining_center")
    cnc.components["tool_wear"].D = cnc.components["tool_wear"].D_fail * 0.9
    for _ in range(80):
        snap = world.step(12.0)
        await hist.on_snapshot(snap)
        for ev in world._pending_events:
            await hist.on_event(ev)
        if world._pending_pieces:
            await hist.on_pieces(world._pending_pieces)
    await hist._flush()

    out = {
        "events": await hist.query_events(limit=50000),
        "pieces": await hist.query_production(limit=50000),
        "rejects": await hist.query_production(good=False, limit=50000),
        "hourly": await hist.query_production_hourly(limit=50000),
        "cnc": cnc.id,
        "cnc_pieces": await hist.query_production(device_id=cnc.id, limit=50000),
    }
    await hist.close()
    os.unlink(db)
    return out


def test_landing() -> None:
    print("\n③ 落地:事件與逐件明細查得回來")
    res = asyncio.run(_run_historian())

    check(len(res["events"]) > 0, f"事件表有資料({len(res['events'])} 筆)")
    check(all(set(e) >= {"wall_t", "device_id", "type", "stop_reason"} for e in res["events"]),
          "事件欄位齊備(含 stop_reason)")
    check(len(res["pieces"]) > 0, f"逐件明細有資料({len(res['pieces'])} 件)")
    check(len(res["rejects"]) > 0, f"篩得出不良品({len(res['rejects'])} 件)")
    check(all(not p["good"] for p in res["rejects"]), "good=false 篩選只回不良品")

    # 追溯:拿一件不良品的序號回查,要查得到同一件
    one = res["rejects"][0]
    same = [p for p in res["cnc_pieces"] if p["serial"] == one["serial"]] \
        if one["device_id"] == res["cnc"] else None
    check(one["serial"] and one["defect"], f"不良品帶序號與不良類型({one['serial']} / {one['defect']})")
    if same is not None:
        check(len(same) == 1, "序號可回溯到唯一一件")

    # 每小時彙總 = 明細加總(明細清掉後趨勢仍要對)
    detail_total = len(res["pieces"])
    hourly_total = sum(b["pieces"] for b in res["hourly"])
    check(detail_total == hourly_total,
          f"每小時彙總件數 = 明細件數({hourly_total} vs {detail_total})")
    hourly_good = sum(b["pieces"] for b in res["hourly"] if not b["defect"])
    detail_good = sum(1 for p in res["pieces"] if p["good"])
    check(hourly_good == detail_good, f"彙總良品數 = 明細良品數({hourly_good} vs {detail_good})")


# ── ④ 學生面不洩 ground-truth ────────────────────────────
def test_no_ground_truth_leak() -> None:
    print("\n④ 紅線:學生面的生產資料不洩 ground-truth")
    res = asyncio.run(_run_historian())
    banned = {"component", "health", "rul", "fault_type", "d_fail", "onset"}
    leak_ev = [k for e in res["events"][:200] for k in e if k.lower() in banned]
    leak_pc = [k for p in res["pieces"][:200] for k in p if k.lower() in banned]
    check(not leak_ev, "事件不含元件名 / 健康度", f"洩漏欄位:{set(leak_ev)}")
    check(not leak_pc, "逐件明細不含元件名 / 健康度", f"洩漏欄位:{set(leak_pc)}")

    world = load_world()
    world.step(12.0)
    dev = next(d for d in world.devices.values() if d.template == "cnc_machining_center")
    snap = dev.public_snapshot()
    check("stop_reason_code" in snap["tags"], "停機原因碼在學生面 snapshot 讀得到")
    check(all(k not in str(snap) for k in ("D_fail", "init_health")),
          "public_snapshot 仍不含 ground-truth 欄位")


def main() -> int:
    print("資料鏈契約測試(停機原因碼 / 逐件生產 / 事件落地)")
    test_conservation()
    test_stop_reason()
    test_landing()
    test_no_ground_truth_leak()
    print(f"\n失敗 {len(_fails)} 項" + ("" if not _fails else f":{_fails}"))
    return 1 if _fails else 0


if __name__ == "__main__":
    raise SystemExit(main())
