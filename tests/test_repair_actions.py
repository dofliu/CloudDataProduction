"""處置動作 / 預防保養的行為驗證(engine/repair.py + engine/device.py)。

要守住的四件事:
  1. **動作表沒有漏**:場景裡出現的每個退化元件,都對應到一個具體動作(不是萬用大修)。
     新增產業模板卻忘了在 engine/repair.py 補對應時,這條會擋下來。
  2. **選錯不會修好**:錯的動作照樣佔維修工時,但設備仍是壞的 —— 工單不能變成打卡。
  3. **保養不是免費的**:保養停機計入可用率損失,學生要權衡「現在停」與「等它壞」。
  4. **一次故障只開一張單**:設備進出維修會讓 state 在 maintenance / fault 之間來回,
     故障事件必須看閂鎖的邊緣,不能看 state 字串,否則同一次故障會被重複開單。

用法:
    python3 tests/test_repair_actions.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.repair import REPAIR_ACTIONS, UNIVERSAL_ACTION, action_for_component  # noqa: E402
from engine.world import World  # noqa: E402

FAIL: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {msg}")
    if not cond:
        FAIL.append(msg)


PARK = {
    "name": "repair-test",
    "sim": {"time_multiplier": 600, "tick_hz": 10, "seed": 7},
    "mes": {"enabled": False},          # 排除工單變因
    "companies": [{
        "id": "c01", "name": "處置測試", "industry": "test", "product": "測試件",
        "devices": [
            {"id": "cnc-1", "template": "cnc_machining_center",
             "duty_cycle": {"profile": "continuous", "load_nom": 70}},
        ],
    }],
}


def build() -> World:
    return World(yaml.safe_load(yaml.safe_dump(PARK)))


def run(world: World, ticks: int, events: list | None = None) -> None:
    """推進世界。事件在 World.run()(async 主迴圈)才廣播,同步測試要自己收 _pending_events。"""
    dt_wall = 1.0 / world.clock.tick_hz
    for _ in range(ticks):
        dt_sim = world.clock.advance(dt_wall)
        world.step(dt_sim)
        if events is not None:
            events.extend(world._pending_events)


# ── 1. 動作表沒有漏 ─────────────────────────────────────────
def test_action_table_covers_all_components() -> None:
    print("\n[1] 每個退化元件都有對症的動作")
    names: set[str] = set()
    for path in sorted((ROOT / "engine" / "templates").glob("*.py")):
        text = path.read_text(encoding="utf-8")
        # 模板的 degradation 預設寫成 '"component_name": {"rate": ...}'
        for line in text.splitlines():
            line = line.strip()
            if '": {"rate"' in line and line.startswith('"'):
                names.add(line.split('"')[1])
    check(len(names) >= 10, f"從模板抓到 {len(names)} 個退化元件(至少該有 10 個)")
    missing = sorted(n for n in names if action_for_component(n) == UNIVERSAL_ACTION)
    check(not missing, f"沒有元件只能靠整機大修(漏掉的:{missing})")
    for n in sorted(names):
        assert action_for_component(n) in REPAIR_ACTIONS


# ── 2. 選錯不會修好、選對才修好 ──────────────────────────────
def test_wrong_action_does_not_fix() -> None:
    print("\n[2] 選錯動作:白花工時,設備仍是壞的")
    world = build()
    run(world, 5)
    dev = world.devices["cnc-1"]
    dev.inject_fault("sudden", "spindle_bearing")
    run(world, 3)
    check(dev.faulted, "注入後設備確實故障閂鎖")

    res = dev.repair("clean_filter", actor="tester")     # 錯:壞的是軸承不是濾網
    check(res["ok"] and not res["success"], "錯的動作回報 success=False")
    check(dev.faulted, "錯的動作之後設備仍然是壞的")
    check(res["downtime_h"] > 0, f"錯的動作照樣佔工時({res['downtime_h']}h)")
    run(world, 1)                                         # 狀態在下一拍才更新
    check(dev.in_maintenance and dev.state == "maintenance", "維修期間狀態顯示 maintenance")

    # 維修中不能連點(避免刷次數繞過工時)
    busy = dev.repair("replace_bearing")
    check(not busy.get("ok"), "維修工時未結束前不接受下一次處置")

    run(world, 400)                                       # 等維修工時走完
    check(not dev.in_maintenance, "維修工時結束")
    check(dev.state == "fault", "工時結束後狀態誠實翻回 fault(它本來就沒修好)")

    ok = dev.repair("replace_bearing", actor="tester")    # 對症
    check(ok["success"] and not ok["still_faulted"], "對症的動作修好了")
    check(not dev.faulted, "設備解除故障閂鎖")


def test_overhaul_always_works() -> None:
    print("\n[3] 整機大修一定成功,但工時最長")
    world = build()
    run(world, 5)
    dev = world.devices["cnc-1"]
    dev.inject_fault("sudden", "spindle_bearing")
    run(world, 3)
    res = dev.repair(UNIVERSAL_ACTION)
    check(res["success"] and not dev.faulted, "大修修好了(不需診斷)")
    check(res["downtime_h"] >= max(s["duration_h"] for a, s in REPAIR_ACTIONS.items()
                                   if a != UNIVERSAL_ACTION),
          f"大修工時({res['downtime_h']}h)是所有動作裡最長的")


# ── 4. 保養有代價 ───────────────────────────────────────────
def test_maintenance_costs_availability() -> None:
    print("\n[4] 預防保養:買得到壽命,但停機計入可用率損失")
    world = build()
    run(world, 200)
    dev = world.devices["cnc-1"]
    before = dev.oee()
    health_before = dev.components["spindle_bearing"].health

    res = dev.maintain("replace_bearing", actor="tester")
    check(res["ok"] and res["health_gain"] > 0, f"對症保養買到壽命(+{res['health_gain']})")
    check(dev.components["spindle_bearing"].health > health_before, "軸承健康度確實回升")
    check(dev.in_maintenance, "保養期間設備停機")

    run(world, 400)                     # 走完 6h 維修工時(400 拍 × 60 sim 秒 = 6.7h)
    after = dev.oee()
    check(after["down_h"] > before["down_h"], "保養停機計入 down_h(可用率損失)")
    check(after["availability"] <= before["availability"], "可用率因保養而下降 —— 保養不是免費的")

    # 保養沒在退化的東西 = 白停機(health_gain 為 0),學生看得到這個回饋
    waste = dev.maintain("recalibrate_process")
    check(waste["ok"] and waste["health_gain"] == 0.0, "保養不相干的部位:買到壽命 0(白花工時)")


# ── 5. 一次故障只開一張單 ────────────────────────────────────
def test_one_fault_one_event() -> None:
    print("\n[5] 進出維修不會對同一次故障重複發 fault 事件")
    world = build()
    events: list[dict] = []
    run(world, 5, events)
    dev = world.devices["cnc-1"]
    dev.inject_fault("sudden", "spindle_bearing")
    run(world, 3, events)
    faults = [e for e in events if e.get("type") == "fault"]
    check(len(faults) == 1, f"故障當下發一次 fault 事件(實際 {len(faults)})")

    dev.repair("clean_filter")          # 選錯 → 進維修 → 出維修後仍是 fault
    run(world, 500, events)
    faults = [e for e in events if e.get("type") == "fault"]
    check(dev.state == "fault", "工時結束回到 fault")
    check(len(faults) == 1, f"整段過程只有一次 fault 事件(實際 {len(faults)})")


def main() -> int:
    print("處置動作 / 預防保養驗證")
    test_action_table_covers_all_components()
    test_wrong_action_does_not_fix()
    test_overhaul_always_works()
    test_maintenance_costs_availability()
    test_one_fault_one_event()
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
