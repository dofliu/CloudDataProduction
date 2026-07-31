"""課堂即時互動驗證:倒數截止 / 首答留名 / 全班投票真的動到引擎。

一般教室 + 學生只有手機的情境下,這三件事是參與感的來源。要守住的是:

  1. 倒數用 **wall clock**,不是 sim clock —— 學生盯的是教室裡的鐘。時間到就不收答案。
  2. 首答只認「本輪佈題之後」的作答;重佈同一題要重新開放首殺,不然第二個班永遠沒有首答。
  3. 投票**真的動到引擎**(保養就真的停機),而且平票時傾向「什麼都不做」——
     現場真的平手時,不該由平台幫全班決定去動機器。
  4. 投票一定要有「維持現況」那一票可投,不然那叫佈題不叫投票。

用法:
    python3 tests/test_classroom_live.py
"""
from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from api.classroom import ClassroomManager  # noqa: E402
from api.polls import PollManager  # noqa: E402
from engine.world import World  # noqa: E402

FAIL: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {msg}")
    if not cond:
        FAIL.append(msg)


PARK = {
    "name": "classroom-test",
    "sim": {"time_multiplier": 600, "tick_hz": 10, "seed": 11},
    "companies": [{
        "id": "c01", "name": "課堂測試", "industry": "test", "product": "測試件",
        "devices": [
            {"id": "cnc-1", "template": "cnc_machining_center",
             "duty_cycle": {"profile": "continuous", "load_nom": 70}},
        ],
    }],
}


class FakeSubmissions:
    """課堂練習只有 kind=submission 的題目會用到它;本測試用的是 static / target。"""

    async def grade(self, payload):
        return {"score": 0.0, "passed": False, "feedback": "(測試用)"}


def build_world() -> World:
    import copy
    world = World(copy.deepcopy(PARK))
    for _ in range(20):
        dt = world.clock.advance(1.0 / world.clock.tick_hz)
        world.step(dt)
    return world


def test_countdown() -> None:
    print("\n[1] 倒數與截止")
    world = build_world()
    cm = ClassroomManager(world, FakeSubmissions(), path=str(ROOT / "scenarios" / "classroom_exercises.yaml"))
    check(len(cm.order) > 0, f"練習庫載入 {len(cm.order)} 題")

    eid = cm.order[0]
    cm.launch(eid, duration_s=60.0)
    v = cm.active_view()["active"]
    check(v["remain_s"] is not None and 55 <= v["remain_s"] <= 60, f"倒數 60s(實際 {v['remain_s']})")
    check(not v["closed"], "還沒截止")

    cm.extend(60.0)
    check(cm.active_view()["active"]["remain_s"] > 100, "延長 60 秒生效")

    # 不給 duration → 沒有倒數(舊行為,教師想慢慢講時用)
    cm.launch(eid)
    check(cm.active_view()["active"]["remain_s"] is None, "不給倒數就沒有截止")


def test_deadline_rejects_answers() -> None:
    print("\n[2] 截止之後不收答案")
    world = build_world()
    cm = ClassroomManager(world, FakeSubmissions(), path=str(ROOT / "scenarios" / "classroom_exercises.yaml"))
    eid = cm.order[0]
    qid = (cm.exercises[eid].get("questions") or [])[0]["id"]

    cm.launch(eid, duration_s=60.0)
    r = asyncio.run(cm.answer(eid, qid, "S001", "running"))
    check(r["score"] >= 0, "截止前收得到答案")

    cm.active["deadline_wall"] = time.time() - 1        # 讓它過期
    try:
        asyncio.run(cm.answer(eid, qid, "S002", "running"))
        check(False, "截止後應該拒收")
    except ValueError as e:
        check("截止" in str(e), f"截止後拒收並說明原因({e})")


def test_first_solver() -> None:
    print("\n[3] 首答留名")
    world = build_world()
    cm = ClassroomManager(world, FakeSubmissions(), path=str(ROOT / "scenarios" / "classroom_exercises.yaml"))
    eid = cm.order[0]
    q = (cm.exercises[eid].get("questions") or [])[0]
    right = q["grade"]["answer"]

    cm.launch(eid)
    wrong = next(c for c in q["choices"] if c != right)
    r0 = asyncio.run(cm.answer(eid, q["id"], "S000", wrong))
    check(not r0["first"], "答錯的人不算首答")

    r1 = asyncio.run(cm.answer(eid, q["id"], "S001", right))
    check(r1["correct"] and r1["first"], "第一個答對的人拿到首答")
    check("🥇" in r1["feedback"], "回饋有講他是第一個")

    r2 = asyncio.run(cm.answer(eid, q["id"], "S002", right))
    check(r2["correct"] and not r2["first"], "第二個答對的沒有首答")

    board = cm.board(eid)
    row = next(x for x in board["questions"] if x["question"] == q["id"])
    check(row["first_solver"] == "S001", f"看板顯示首答者(實際 {row['first_solver']})")

    # 重佈 → 首殺重新開放(下一個班不該永遠沒有首答)
    time.sleep(0.01)
    cm.launch(eid)
    r3 = asyncio.run(cm.answer(eid, q["id"], "S009", right))
    check(r3["first"], "重佈之後首答重新開放")


def test_poll_executes_on_engine() -> None:
    print("\n[4] 全班投票真的動到引擎")
    world = build_world()
    pm = PollManager(world, path=str(ROOT / "scenarios" / "classroom_polls.yaml"))
    check(len(pm.order) >= 3, f"投票題庫載入 {len(pm.order)} 題")

    # 每一題都要有「維持現況」可投,不然那叫佈題不叫投票
    for pid in pm.order:
        kinds = [(o.get("effect") or {}).get("kind") for o in pm.polls[pid].get("options", [])]
        check("none" in kinds, f"{pid} 有『維持現況』選項")

    dev = world.devices["cnc-1"]
    before_down = dev.oee()["down_h"]

    r = pm.open("maintain_now", duration_s=120.0)
    check(r["ok"] and r["active"]["device"] == "cnc-1", "開票並綁定設備")
    check(pm.vote("maintain_now", "maintain", "S001")["ok"], "投票成功")
    pm.vote("maintain_now", "maintain", "S002")
    pm.vote("maintain_now", "wait", "S003")
    check(pm.view()["active"]["tally"] == {"maintain": 2, "wait": 1}, "票數即時可見")

    # 可以改票,以最後一次為準
    pm.vote("maintain_now", "wait", "S002")
    check(pm.view()["active"]["tally"] == {"maintain": 1, "wait": 2}, "改票以最後一次為準")
    pm.vote("maintain_now", "maintain", "S002")

    closed = pm.close()["closed"]
    check(closed["winner"] == "maintain", f"多數決勝出(實際 {closed['winner']})")
    check(closed["result"]["kind"] == "maintenance" and closed["result"]["ok"],
          f"引擎真的執行了保養({closed['result']['detail']})")
    check(dev.in_maintenance, "設備真的進入維修停機")

    for _ in range(400):                       # 走完維修工時
        dt = world.clock.advance(1.0 / world.clock.tick_hz)
        world.step(dt)
    check(dev.oee()["down_h"] > before_down, "投票造成的停機真的計入可用率損失")
    check(len(pm.history) == 1 and pm.active is None, "收票後留下歷史紀錄")


def test_poll_tie_prefers_doing_nothing() -> None:
    print("\n[5] 平票時傾向什麼都不做")
    world = build_world()
    pm = PollManager(world, path=str(ROOT / "scenarios" / "classroom_polls.yaml"))
    pm.open("maintain_now", duration_s=120.0)
    pm.vote("maintain_now", "maintain", "S001")
    pm.vote("maintain_now", "wait", "S002")
    closed = pm.close()["closed"]
    check(closed["winner"] == "wait", f"平票取『維持現況』(實際 {closed['winner']})")
    check(closed["result"]["kind"] == "none", "引擎不動")
    check(not world.devices["cnc-1"].in_maintenance, "設備沒有被動到")


def test_poll_deadline() -> None:
    print("\n[6] 投票截止後不收票")
    world = build_world()
    pm = PollManager(world, path=str(ROOT / "scenarios" / "classroom_polls.yaml"))
    pm.open("push_output", duration_s=60.0)
    check(pm.vote("push_output", "push", "S001")["ok"], "截止前收得到票")
    pm.active["deadline_wall"] = time.time() - 1
    r = pm.vote("push_output", "push", "S002")
    check(not r["ok"] and "截止" in r["error"], f"截止後拒收({r.get('error')})")


def main() -> int:
    print("課堂即時互動驗證(倒數 / 首答 / 全班投票)")
    test_countdown()
    test_deadline_rejects_answers()
    test_first_solver()
    test_poll_executes_on_engine()
    test_poll_tie_prefers_doing_nothing()
    test_poll_deadline()
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
