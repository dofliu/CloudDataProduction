"""學生託管告警規則的評分驗證(api/alarm_rules.py)。

規則本身很簡單,難的是**評分要誠實**:

  1. 條件要「持續 for_s」才告警 —— 一碰到門檻就叫的規則會被雜訊洗成誤報機。
  2. 條件解除後才重新武裝 —— 同一次越界不能連續刷出上百則告警灌高命中數。
  3. 命中要對 ground-truth 的真實故障起始時刻,而且**一次故障只認一次**;
     同一次故障的後續告警算重複,不計分也不算誤報(不然「一直叫」就能刷 recall)。
  4. 沒有對應故障的告警 = 誤報;監控中的設備壞了卻沒叫 = 漏報。

本檔不需要 fastapi —— api/alarm_rules.py 是純邏輯,只吃 world 與 snapshot。

用法:
    python3 tests/test_alarm_rules.py
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api.alarm_rules import LEAD_HORIZON_S, AlarmRuleStore  # noqa: E402

FAIL: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {msg}")
    if not cond:
        FAIL.append(msg)


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def now(self) -> float:
        return self.t


class FakeTag:
    def __init__(self, name: str) -> None:
        self.name = name


class FakeDevice:
    def __init__(self, did: str) -> None:
        self.id = did
        self.tags = [FakeTag("vibration_rms"), FakeTag("spindle_temp")]


class FakeWorld:
    """只提供 AlarmRuleStore 用得到的介面(devices / clock),不牽動真引擎 —— 這裡測的是評分邏輯。"""

    def __init__(self) -> None:
        self.clock = FakeClock()
        self.devices = {"cnc-1": FakeDevice("cnc-1"), "cnc-2": FakeDevice("cnc-2")}


def feed(store: AlarmRuleStore, world: FakeWorld, series: list[tuple[float, float]],
         device: str = "cnc-1", tag: str = "vibration_rms") -> None:
    """把 (sim_t, value) 序列餵進去,模擬 world snapshot。"""
    for sim_t, value in series:
        world.clock.t = sim_t
        asyncio.run(store.on_snapshot({
            "sim_t": sim_t,
            "devices": {device: {"tags": {tag: value}}},
        }))


def fault(store: AlarmRuleStore, device: str, sim_t: float) -> None:
    asyncio.run(store.on_event({"type": "fault", "device": device, "sim_t": sim_t}))


def test_hold_and_rearm() -> None:
    print("\n[1] 持續時間與重新武裝")
    world = FakeWorld()
    store = AlarmRuleStore(world)
    r = store.add({"student": "S001", "device": "cnc-1", "tag": "vibration_rms",
                   "op": ">", "threshold": 4.0, "for_s": 600.0})
    check(r["ok"], "規則建立成功")

    # 越界但只維持 300 秒 → 還不到 for_s,不該叫
    feed(store, world, [(0, 1.0), (300, 4.5)])
    check(len(store.alerts) == 0, f"越界未滿 600s 不告警(實際 {len(store.alerts)} 則)")

    # 繼續越界到滿 600 秒 → 叫一次
    feed(store, world, [(900, 4.6)])
    check(len(store.alerts) == 1, f"滿足持續時間後告警一次(實際 {len(store.alerts)} 則)")

    # 持續越界不該一直叫(已解除武裝)
    feed(store, world, [(1200, 5.0), (1500, 5.2), (1800, 5.5)])
    check(len(store.alerts) == 1, f"同一次越界只叫一次(實際 {len(store.alerts)} 則)")

    # 回到門檻下 → 重新武裝;再越界滿時間 → 第二則
    feed(store, world, [(2100, 1.0), (2400, 4.9), (3100, 4.9)])
    check(len(store.alerts) == 2, f"條件解除後重新武裝(實際 {len(store.alerts)} 則)")


def test_scoring_against_ground_truth() -> None:
    print("\n[2] 對 ground-truth 的 precision / recall / lead time")
    world = FakeWorld()
    store = AlarmRuleStore(world)
    store.add({"student": "S001", "device": "cnc-1", "tag": "vibration_rms",
               "op": ">", "threshold": 4.0, "for_s": 0.0})

    # 告警 @1000s,故障 @1000+6h → 命中,提前 6 小時
    feed(store, world, [(0, 1.0), (1000, 4.5)])
    fault(store, "cnc-1", 1000 + 6 * 3600)

    row = next(r for r in store.scores()["ranking"] if r["student"] == "S001")
    check(row["hits"] == 1 and row["false_alarms"] == 0, f"命中 1 / 誤報 0(實際 {row})")
    check(row["avg_lead_time_h"] == 6.0, f"平均提前 6.0h(實際 {row['avg_lead_time_h']})")
    check(row["recall"] == 1.0 and row["precision"] == 1.0, "precision / recall 皆為 1")

    # 再一則告警,後面沒有任何故障 → 誤報
    feed(store, world, [(100000, 1.0), (101000, 4.5)])
    row = next(r for r in store.scores()["ranking"] if r["student"] == "S001")
    check(row["false_alarms"] == 1, f"沒有後續故障的告警算誤報(實際 {row['false_alarms']})")
    check(row["f1"] < 1.0, f"誤報把 F1 拉下來(實際 {row['f1']})")


def test_duplicate_not_double_counted() -> None:
    print("\n[3] 一次故障只認一次命中(叫得多不會刷高分)")
    world = FakeWorld()
    store = AlarmRuleStore(world)
    store.add({"student": "S001", "device": "cnc-1", "tag": "vibration_rms",
               "op": ">", "threshold": 4.0, "for_s": 0.0})

    onset = 20 * 3600.0
    # 同一次故障前叫三次(中間回到門檻下重新武裝)
    for t in (1000.0, 5000.0, 9000.0):
        feed(store, world, [(t - 100, 1.0), (t, 4.5)])
    fault(store, "cnc-1", onset)
    row = next(r for r in store.scores()["ranking"] if r["student"] == "S001")
    check(row["hits"] == 1, f"三則告警對同一次故障只算 1 次命中(實際 {row['hits']})")
    check(row["duplicates"] == 2, f"其餘 2 則算重複(實際 {row['duplicates']})")
    check(row["false_alarms"] == 0, "重複告警不算誤報(它們確實提前示警了)")


def test_miss_counted() -> None:
    print("\n[4] 監控中的設備壞了卻沒叫 = 漏報")
    world = FakeWorld()
    store = AlarmRuleStore(world)
    store.add({"student": "S001", "device": "cnc-1", "tag": "vibration_rms",
               "op": ">", "threshold": 99.0, "for_s": 0.0})   # 門檻設太高,永遠不叫
    feed(store, world, [(0, 1.0), (1000, 5.0)])
    fault(store, "cnc-1", 5000.0)
    row = next(r for r in store.scores()["ranking"] if r["student"] == "S001")
    check(row["hits"] == 0 and row["misses"] == 1, f"門檻設太高 → 漏報 1(實際 {row})")
    check(row["recall"] == 0.0, "recall 為 0")

    # 沒監控的設備故障不算它的漏報(沒下規則就不該被罰)
    fault(store, "cnc-2", 6000.0)
    row = next(r for r in store.scores()["ranking"] if r["student"] == "S001")
    check(row["misses"] == 1, f"沒監控的設備故障不計漏報(實際 {row['misses']})")


def test_horizon() -> None:
    print("\n[5] 提前太久的告警不算命中(超出評分視窗)")
    world = FakeWorld()
    store = AlarmRuleStore(world)
    store.add({"student": "S001", "device": "cnc-1", "tag": "vibration_rms",
               "op": ">", "threshold": 4.0, "for_s": 0.0})
    feed(store, world, [(0, 1.0), (1000, 4.5)])
    fault(store, "cnc-1", 1000 + LEAD_HORIZON_S + 3600)      # 超出視窗一小時
    row = next(r for r in store.scores()["ranking"] if r["student"] == "S001")
    check(row["hits"] == 0 and row["false_alarms"] == 1,
          f"視窗外的告警算誤報而非命中(實際 {row})")


def test_ema_smooths_spike() -> None:
    print("\n[6] EMA 平滑掉單點尖峰(raw 會叫、ema 不叫)")
    world = FakeWorld()
    raw_store, ema_store = AlarmRuleStore(world), AlarmRuleStore(world)
    raw_store.add({"student": "S001", "device": "cnc-1", "tag": "vibration_rms",
                   "op": ">", "threshold": 4.0, "agg": "raw", "for_s": 0.0})
    ema_store.add({"student": "S001", "device": "cnc-1", "tag": "vibration_rms",
                   "op": ">", "threshold": 4.0, "agg": "ema", "window_s": 3600.0, "for_s": 0.0})
    spike = [(0, 1.0), (60, 1.0), (120, 9.0), (180, 1.0), (240, 1.0)]
    feed(raw_store, world, spike)
    feed(ema_store, world, spike)
    check(len(raw_store.alerts) == 1, f"raw 被單點尖峰觸發(實際 {len(raw_store.alerts)} 則)")
    check(len(ema_store.alerts) == 0, f"ema 平滑掉尖峰不誤報(實際 {len(ema_store.alerts)} 則)")


def main() -> int:
    print("學生託管告警規則驗證")
    test_hold_and_rearm()
    test_scoring_against_ground_truth()
    test_duplicate_not_double_counted()
    test_miss_counted()
    test_horizon()
    test_ema_smooths_spike()
    print()
    if FAIL:
        print(f"✗ {len(FAIL)} 項未通過:")
        for m in FAIL:
            print(f"  - {m}")
        return 1
    print("✓ 全部通過")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
