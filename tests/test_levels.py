"""資料的一生九關的判定驗證(api/levels.py + scenarios/levels.yaml)。

關卡系統唯一的價值是「進度是真的」。所以這裡守四件事:

  1. 定義檔載得起來,而且每一關的判定方式都是 api/levels.py 認得的。
  2. 自動關卡查的是平台手上的事實(認領 / 通過的作業 / 告警 F1),學生說了不算。
  3. 人工關卡只能由教師勾,而且**不能**拿去勾自動關卡(不然關卡就變成人情)。
  4. 教師看板的「瓶頸關」算的是「前一關過了、這一關沒過」的人數 ——
     若改成「沒過的人最多」,答案永遠是最後一關,那張看板就沒有用。

用法:
    python3 tests/test_levels.py
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api.levels import LevelManager  # noqa: E402

FAIL: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {msg}")
    if not cond:
        FAIL.append(msg)


# ── 假的各 store:只提供 LevelManager 用得到的介面 ──────────────
class FakeClock:
    def now(self) -> float:
        return 0.0


class FakeWorld:
    def __init__(self, owners: dict) -> None:
        self.clock = FakeClock()
        self.devices = {}
        self.park = {"companies": [
            {"id": cid, "name": cid, "owner": owner, "device_ids": [f"{cid}-dev1"]}
            for cid, owner in owners.items()
        ]}


class FakeSubmissions:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows

    def list(self, student=None, week=None, type=None):
        out = self.rows
        if student:
            out = [r for r in out if r["student"] == student]
        if type:
            out = [r for r in out if r["type"] == type]
        return out


class FakeTickets:
    def __init__(self, tickets: dict) -> None:
        self.tickets = tickets


class FakeMaintenance:
    def __init__(self, log: list[dict]) -> None:
        self.log = log


class FakeAlarms:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows

    def scores(self):
        return {"ranking": self.rows}


class FakePredictions:
    def __init__(self, rows: list[dict]) -> None:
        self.rows = rows

    def scores(self):
        return {"ranking": self.rows}


def build(owners=None, subs=None, tickets=None, maint=None, alarms=None, preds=None,
          roster=None) -> LevelManager:
    return LevelManager(
        FakeWorld(owners or {}),
        FakeSubmissions(subs or []),
        FakeTickets(tickets or {}),
        FakeMaintenance(maint or []),
        FakeAlarms(alarms or []),
        FakePredictions(preds or []),
        roster=(lambda: roster) if roster is not None else None,
        path=str(ROOT / "scenarios" / "levels.yaml"),
    )


KNOWN_KINDS = {"claim", "submission", "access", "tickets", "maintenance",
               "alarm", "prediction", "manual", "any", "all"}


def test_definition_loads() -> None:
    print("\n[1] 關卡定義")
    m = build()
    check(len(m.levels) == 9, f"九關(實際 {len(m.levels)} 關)")
    check(len(m.badges) >= 1, f"有支線徽章(實際 {len(m.badges)} 個)")
    names = [l["name"] for l in m.levels]
    check(names == ["產生", "接取", "串流", "儲存", "統計", "視覺化", "KPI", "預警", "報告"],
          f"順序就是資料的一生:{names}")

    def kinds(spec):
        k = spec.get("kind")
        yield k
        for sub in spec.get("of", []) or []:
            yield from kinds(sub)

    bad = [k for item in m.levels + m.badges for k in kinds(item.get("check") or {})
           if k not in KNOWN_KINDS]
    check(not bad, f"所有判定方式都是引擎認得的(不認得的:{bad})")


def test_auto_checks_use_platform_facts() -> None:
    print("\n[2] 自動關卡查的是平台手上的事實")
    m = build(owners={"c01": "S001"},
              subs=[{"student": "S001", "type": "connect", "passed": True, "score": 88.0}])
    st = m.status("S001")
    by = {l["id"]: l for l in st["levels"]}
    check(by["L1_generate"]["done"], "認領了公司 → 產生關過")
    check(by["L2_ingest"]["done"], "有通過的 connect 作業 → 接取關過")
    check("88" in by["L2_ingest"]["evidence"], f"佐證帶出分數:{by['L2_ingest']['evidence']}")
    check(not by["L5_stats"]["done"], "沒交 stats → 統計關沒過")
    check(st["next"]["id"] == "L3_stream", f"下一關是串流(實際 {st['next']['id']})")

    # 沒通過的作業不算過(passed=False)
    m2 = build(owners={"c01": "S002"},
               subs=[{"student": "S002", "type": "connect", "passed": False, "score": 30.0}])
    by2 = {l["id"]: l for l in m2.status("S002")["levels"]}
    check(not by2["L2_ingest"]["done"], "作業沒通過就不算過關")

    # 別人的作業不算你的
    by3 = {l["id"]: l for l in m2.status("S003")["levels"]}
    check(not by3["L2_ingest"]["done"], "別人的作業不會算到你頭上")


def test_any_composition() -> None:
    print("\n[3] 預警關:告警 F1 或 預測命中,兩條路任一即可")
    alarm_path = build(alarms=[{"student": "S001", "f1": 0.7, "hits": 3, "false_alarms": 1}])
    check(next(l for l in alarm_path.status("S001")["levels"] if l["id"] == "L8_warn")["done"],
          "告警規則 F1 0.7 → 過")

    pred_path = build(preds=[{"student": "S001", "hits": 2}])
    check(next(l for l in pred_path.status("S001")["levels"] if l["id"] == "L8_warn")["done"],
          "預測命中 2 次 → 過")

    weak = build(alarms=[{"student": "S001", "f1": 0.2, "hits": 1, "false_alarms": 9}],
                 preds=[{"student": "S001", "hits": 0}])
    check(not next(l for l in weak.status("S001")["levels"] if l["id"] == "L8_warn")["done"],
          "F1 0.2 且沒有預測命中 → 沒過")


def test_manual_only_for_manual_levels() -> None:
    print("\n[4] 人工勾選只能用在人工關卡")
    m = build(owners={"c01": "S001"})
    ok = m.mark("S001", "L6_visualize", True, by="teacher-a")
    check(ok["ok"], "視覺化關可以勾")
    by = {l["id"]: l for l in m.status("S001")["levels"]}
    check(by["L6_visualize"]["done"], "勾完就算過")
    check("teacher-a" in by["L6_visualize"]["evidence"], "佐證留下是誰認可的")

    bad = m.mark("S001", "L2_ingest", True)
    check(not bad["ok"], f"自動關卡不能用勾的({bad.get('error')})")

    m.mark("S001", "L6_visualize", False)
    check(not m.status("S001")["levels"][5]["done"], "可以取消勾選")


def test_badges() -> None:
    print("\n[5] 支線徽章")
    m = build(owners={"c01": "S001"},
              tickets={"T1": {"owner": "S001", "status": "resolved", "wrong_attempts": 0}},
              maint=[{"actor": "S001", "effective": True} for _ in range(3)],
              alarms=[{"student": "S001", "f1": 1.0, "hits": 2, "false_alarms": 0}])
    got = {b["id"]: b["done"] for b in m.status("S001")["badges"]}
    check(got.get("B_first_try"), "結案且零誤修 → 一次修好")
    check(got.get("B_prevention"), "三次有效保養 → 防患未然")
    check(got.get("B_no_false_alarm"), "有命中且零誤報 → 零誤報")

    m2 = build(owners={"c01": "S001"},
               tickets={"T1": {"owner": "S001", "status": "resolved", "wrong_attempts": 2}},
               maint=[{"actor": "S001", "effective": False} for _ in range(5)])
    got2 = {b["id"]: b["done"] for b in m2.status("S001")["badges"]}
    check(not got2.get("B_first_try"), "誤修過就拿不到「一次修好」")
    check(not got2.get("B_prevention"), "白花的保養不算「有效」")


def test_bottleneck_is_at_the_door() -> None:
    print("\n[6] 瓶頸關 = 走到門口卻進不去的人最多的那一關")
    # 三個人都過了產生關(認領),都沒過接取關 → 瓶頸該是接取,不是最後一關
    m = build(owners={"c01": "S001", "c02": "S002", "c03": "S003"},
              roster=["S001", "S002", "S003"])
    b = m.board()
    check(b["count"] == 3, f"名冊 3 人(實際 {b['count']})")
    check(b["bottleneck"]["id"] == "L2_ingest",
          f"瓶頸是接取關而不是最後一關(實際 {b['bottleneck']})")
    check(b["bottleneck"]["count"] == 3, f"三個人都卡在那(實際 {b['bottleneck']['count']})")
    check(b["levels"][0]["done"] == 3 and b["levels"][1]["done"] == 0,
          "每關的過關人數統計正確")

    # 名冊來源:帳號 + 有認領的 + 交過作業的,自動聯集
    m2 = build(owners={"c01": "S001"}, roster=["S009"],
               subs=[{"student": "S050", "type": "stats", "passed": True, "score": 90}])
    check(m2.roster() == ["S001", "S009", "S050"], f"名冊聯集(實際 {m2.roster()})")


def main() -> int:
    print("資料的一生九關驗證")
    test_definition_loads()
    test_auto_checks_use_platform_facts()
    test_any_composition()
    test_manual_only_for_manual_levels()
    test_badges()
    test_bottleneck_is_at_the_door()
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
