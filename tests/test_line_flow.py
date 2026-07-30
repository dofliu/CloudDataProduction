"""產線物料流端到端驗證(engine/line.py)。

驗「工件真的在設備之間流」這條線:
  1. 兩台 CNC 夾一支手臂:上游完工 → 手臂搬運 → 下游才有料可加工。
  2. 守恆:下游消耗 ≤ 手臂搬運量 ≤ 上游完工量(工件不會憑空出現)。
  3. 餓料誠實:把手臂鎖停(run_enable=0),下游吃完緩衝後必須真的停(不再計件)。
  4. 手臂事件驅動:cycle_count = 實際搬運次數,無料時待命(state=idle、電流掉回保持電流)。

用法:
    python3 tests/test_line_flow.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.world import World  # noqa: E402

FAIL: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {msg}")
    if not cond:
        FAIL.append(msg)


PARK = {
    "name": "line-test",
    "sim": {"time_multiplier": 120, "tick_hz": 10, "seed": 42},
    "mes": {"enabled": False},   # 排除工單變因,單測物料流
    "companies": [{
        "id": "c01", "name": "產線測試", "industry": "test", "product": "測試件",
        "line": ["cnc-a", "arm-1", "cnc-b"],
        "devices": [
            {"id": "cnc-a", "template": "cnc_machining_center",
             "duty_cycle": {"profile": "continuous", "load_nom": 70}},
            {"id": "arm-1", "template": "robot_arm_6axis",
             "duty_cycle": {"profile": "continuous", "load_nom": 65}},
            {"id": "cnc-b", "template": "cnc_machining_center",
             "duty_cycle": {"profile": "continuous", "load_nom": 70}},
        ],
    }],
}


def run(world: World, ticks: int) -> dict:
    dt_sim = 120 / 10.0
    snap = {}
    for _ in range(ticks):
        world.clock.advance(1.0 / 10.0)
        snap = world.step(dt_sim)
    return snap


def main() -> None:
    print("產線物料流驗證(CNC → 手臂 → CNC)")
    import copy
    world = World(copy.deepcopy(PARK))

    check(len(world.lines.lines) == 1, "line: 宣告解析成功(1 條產線)")
    snap = run(world, 300)   # 300 拍 × 12 sim 秒 = 1 sim 小時

    tags = {d: s["tags"] for d, s in snap["devices"].items()}
    line = snap["lines"][0]
    by_dev = {s["device"]: s for s in line["stations"]}

    made_a = int(tags["cnc-a"]["part_count"])
    moved = int(tags["arm-1"]["cycle_count"])
    made_b = int(tags["cnc-b"]["part_count"])
    out_a = by_dev["cnc-a"]["out_buffer"]
    in_b = by_dev["cnc-b"]["in_buffer"]

    check(made_a > 10, f"上游 cnc-a 有產出({made_a} 件)")
    check(moved > 10, f"手臂有搬運(cycle_count={moved})")
    check(made_b > 10, f"下游 cnc-b 有產出({made_b} 件)")
    # 守恆:上游完工 = 出料緩衝 + 在手 + 已交付;交付 ≥ 下游消耗(緩衝暫存)
    carrying = 1 if by_dev["arm-1"]["carrying"] else 0
    check(made_a == out_a + carrying + moved,
          f"上游守恆:完工 {made_a} = 待取 {out_a} + 在手 {carrying} + 已搬 {moved}")
    check(made_b <= moved, f"下游守恆:消耗 {made_b} ≤ 送達 {moved}(工件不憑空出現)")
    check(0 <= out_a <= 3 and 0 <= in_b <= 3, f"緩衝在容量內(out={out_a}, in={in_b})")

    # FC04 可觀測點位
    irs_a = snap["devices"]["cnc-a"]["input_regs"]
    irs_b = snap["devices"]["cnc-b"]["input_regs"]
    check("line_out_buffer" in irs_a and irs_a["line_out_buffer"] == out_a,
          f"cnc-a 的 line_out_buffer FC04 點位與產線帳一致({irs_a.get('line_out_buffer')})")
    check("line_in_buffer" in irs_b and irs_b["line_in_buffer"] == in_b,
          f"cnc-b 的 line_in_buffer FC04 點位與產線帳一致({irs_b.get('line_in_buffer')})")

    # ── 餓料:鎖停手臂,下游吃完緩衝後必須真的停 ──
    world.devices["arm-1"].set_coil("run_enable", False)
    run(world, 100)   # 先讓下游把殘餘緩衝吃完
    snap2 = run(world, 5)
    b_before = int(snap2["devices"]["cnc-b"]["tags"]["part_count"])
    snap3 = run(world, 100)   # 再跑 20 sim 分鐘
    b_after = int(snap3["devices"]["cnc-b"]["tags"]["part_count"])
    in_b3 = {s["device"]: s for s in snap3["lines"][0]["stations"]}["cnc-b"]["in_buffer"]
    check(in_b3 == 0, f"手臂停止後下游入料緩衝耗盡({in_b3})")
    check(b_after == b_before, f"無料時下游真的停(件數 {b_before} → {b_after},不再憑空計件)")
    check(snap3["devices"]["cnc-b"]["state"] == "idle", "無料的下游 state=idle(待機,不罰可用率)")
    # 上游被塞滿後也要停
    a_out3 = {s["device"]: s for s in snap3["lines"][0]["stations"]}["cnc-a"]["out_buffer"]
    check(a_out3 == 3, f"上游出料緩衝塞滿({a_out3}/3)")
    check(snap3["devices"]["cnc-a"]["state"] == "idle", "滿料的上游 state=idle(停機等搬運)")

    # ── 手臂待命誠實:恢復手臂,搬完緩衝後 waiting → idle、電流掉回保持電流 ──
    world.devices["arm-1"].set_coil("run_enable", True)
    snap4 = run(world, 200)
    arm4 = snap4["devices"]["arm-1"]
    check(int(snap4["devices"]["cnc-b"]["tags"]["part_count"]) > b_after,
          "手臂恢復後下游繼續生產(物料流重新接通)")
    # 觀察窗內找一拍「待命」:手臂沒在搬運時 state=idle 且電流掉回保持電流
    # (沒在搬 = 沒被授予搬運;可能因上游無料,也可能因下游緩衝滿 —— 都該停)
    waited = False
    for _ in range(80):
        s = run(world, 1)
        st_line = {x["device"]: x for x in s["lines"][0]["stations"]}
        if not st_line["arm-1"]["carrying"]:
            a = s["devices"]["arm-1"]
            if a["state"] == "idle" and a["tags"]["joint_current_1"] < 1.0:
                waited = True
                break
    check(waited, "手臂沒搬運時待命(state=idle、電流掉回保持電流)")

    print(f"\n失敗 {len(FAIL)} 項")
    for f in FAIL:
        print(f"  - {f}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
