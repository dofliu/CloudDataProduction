"""跨公司供應鏈驗證(engine/supply.py)。

要守住的因果:

  1. **上游停 → 下游餓料停機**。這是整個功能的重點:你上游那位同學的機台壞了沒人管,
     你的產線就得停。停下來的必須是真的停(不轉不磨、不再計件),不是畫面上假裝。
  2. **下游停 → 上游阻塞**。進料倉塞滿,上游出貨端被卡住 —— 供應鏈是雙向的。
  3. **守恆**:下游吃掉的件數不會超過上游供的 + 外部備援買的。工件不能憑空出現。
  4. **餓料 / 阻塞不罰可用率**。餓料不是設備的錯,它降的是產出;可用率的分母只算
     「排程要它產出卻沒產出」。這條跟 engine/line.py 的計帳原則一致。
  5. **外部備援**:有備援的鏈缺料一段時間後會補一件(單一供應商風險可量化);
     沒備援的鏈就真的一直餓著 —— 誠實,不為了資料好看造假。

用法:
    python3 tests/test_supply_chain.py
"""
from __future__ import annotations

import copy
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


def park(**link) -> dict:
    spec = {"from": "c01", "to": "c02", "part": "測試件", "cap": 10, "initial": 5}
    spec.update(link)
    return {
        "name": "supply-test",
        "sim": {"time_multiplier": 600, "tick_hz": 10, "seed": 5},
        "mes": {"enabled": False},          # 排除工單變因,單測供應鏈
        "companies": [
            {"id": "c01", "name": "上游", "industry": "test", "product": "件",
             "devices": [{"id": "up-1", "template": "cnc_machining_center",
                          "duty_cycle": {"profile": "continuous", "load_nom": 70}}]},
            {"id": "c02", "name": "下游", "industry": "test", "product": "件",
             "devices": [{"id": "dn-1", "template": "cnc_machining_center",
                          "duty_cycle": {"profile": "continuous", "load_nom": 70}}]},
        ],
        "supply_chain": [spec],
    }


def build(**link) -> World:
    return World(copy.deepcopy(park(**link)))


def run(world: World, ticks: int) -> None:
    for _ in range(ticks):
        dt = world.clock.advance(1.0 / world.clock.tick_hz)
        world.step(dt)


def parts(world: World, dev: str) -> int:
    return int(next(t.value for t in world.devices[dev].tags if t.name == "part_count"))


def test_upstream_stop_starves_downstream() -> None:
    print("\n[1] 上游停 → 下游餓料停機")
    world = build(cap=50, initial=6, external_backup_h=0)
    run(world, 100)
    link = world.supply.links[0]
    check(link.delivered > 0 and link.consumed > 0, f"平常有在供也有在吃(供 {link.delivered} / 吃 {link.consumed})")

    world.devices["up-1"].set_coil("run_enable", False)      # 上游停機
    run(world, 400)
    check(link.stock == 0, f"下游把庫存吃光(剩 {link.stock})")

    before = parts(world, "dn-1")
    run(world, 300)
    after = parts(world, "dn-1")
    check(after == before, f"沒料之後下游真的停了,不再計件({before} → {after})")
    check(world.devices["dn-1"].state == "idle", f"下游狀態是 idle(實際 {world.devices['dn-1'].state})")
    check(link.starved_sim_s > 0, f"缺料時間有累計({link.starved_sim_s / 3600:.1f}h)")

    world.devices["up-1"].set_coil("run_enable", True)       # 上游復機
    run(world, 300)
    check(parts(world, "dn-1") > after, "上游恢復後下游繼續生產")


def test_downstream_stop_blocks_upstream() -> None:
    print("\n[2] 下游停 → 上游阻塞(供應鏈是雙向的)")
    world = build(cap=8, initial=0, external_backup_h=0)
    run(world, 60)
    link = world.supply.links[0]
    world.devices["dn-1"].set_coil("run_enable", False)      # 下游停機,不再吃料

    run(world, 600)
    check(link.stock >= link.cap, f"進料倉塞滿({link.stock}/{link.cap})")
    check(world.devices["up-1"].line_output_blocked, "上游出貨端被標記為阻塞")

    before = parts(world, "up-1")
    run(world, 300)
    check(parts(world, "up-1") == before, "倉滿之後上游真的停了,不再計件")
    check(link.blocked_sim_s > 0, f"阻塞時間有累計({link.blocked_sim_s / 3600:.1f}h)")


def test_conservation() -> None:
    print("\n[3] 守恆:吃掉的不會超過供的 + 買的")
    world = build(cap=20, initial=4, external_backup_h=1)
    run(world, 1500)
    link = world.supply.links[0]
    check(link.consumed <= link.delivered + link.purchased + 4,
          f"消耗 {link.consumed} ≤ 供 {link.delivered} + 買 {link.purchased} + 開場 4")
    check(link.stock == 4 + link.delivered + link.purchased - link.consumed,
          f"庫存帳平({link.stock})")
    check(0 <= link.stock <= link.cap, f"庫存在 [0, cap] 之內({link.stock}/{link.cap})")


def test_starvation_does_not_hurt_availability() -> None:
    print("\n[4] 餓料不罰可用率(不是設備的錯,它降的是產出)")
    world = build(cap=50, initial=2, external_backup_h=0)
    run(world, 60)
    dn = world.devices["dn-1"]
    world.devices["up-1"].set_coil("run_enable", False)
    run(world, 200)                                          # 先把庫存吃光
    before = dn.oee()
    run(world, 600)                                          # 這段全在餓料
    after = dn.oee()
    check(after["down_h"] == before["down_h"], f"餓料期間不累積停機時數({before['down_h']} → {after['down_h']})")
    check(after["availability"] >= before["availability"] - 1e-9,
          f"可用率沒有因為餓料下降({before['availability']} → {after['availability']})")


def test_external_backup() -> None:
    print("\n[5] 外部備援:有備援不會死,沒備援就真的一直餓著")
    with_backup = build(cap=20, initial=1, external_backup_h=1)
    with_backup.devices["up-1"].set_coil("run_enable", False)
    run(with_backup, 1200)
    lk = with_backup.supply.links[0]
    check(lk.purchased > 0, f"有備援的鏈會外購補料(買了 {lk.purchased} 件)")
    check(lk.view()["self_sufficiency"] is not None and lk.view()["self_sufficiency"] < 1.0,
          f"自給率掉下來,看得出誰靠外購撐著({lk.view()['self_sufficiency']})")

    no_backup = build(cap=20, initial=1, external_backup_h=0)
    no_backup.devices["up-1"].set_coil("run_enable", False)
    run(no_backup, 1200)
    lk2 = no_backup.supply.links[0]
    check(lk2.purchased == 0, "沒備援的鏈不會憑空生出料")
    check(lk2.stock == 0 and lk2.view()["starving"], "它就真的一直餓著(誠實)")


def test_impact_view() -> None:
    print("\n[6] 教師面的連鎖反應視圖")
    world = build(cap=20, initial=1, external_backup_h=0)
    world.devices["up-1"].set_coil("run_enable", False)
    run(world, 400)
    rows = world.supply.impact()
    check(any(r["kind"] == "starving" and r["from"] == "c01" and r["to"] == "c02" for r in rows),
          f"點出「誰在等誰」({rows})")
    view = world.supply.for_company("c02")
    check(len(view["inbound"]) == 1 and not view["outbound"], "公司視圖分得清上游與下游")


def main() -> int:
    print("跨公司供應鏈驗證")
    test_upstream_stop_starves_downstream()
    test_downstream_stop_blocks_upstream()
    test_conservation()
    test_starvation_does_not_hurt_availability()
    test_external_backup()
    test_impact_view()
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
