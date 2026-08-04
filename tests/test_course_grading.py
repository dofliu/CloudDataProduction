"""課程教材端契約驗證(2026-08-01 教材事實查核後訂下的行為)。

  1. course_weeks.yaml 週次對齊《18週教學大綱 v2.1》且 18 週全定義(2026-08-04 T2):
     W4/W6/W7 乾淨(W7 尤其不能是 keep —— 學生本週存的「正常基線」是 W8 的比較對象)、
     W8 = equipment gradual 0.85、W10 = sensor_drift 0.6、W11 keep、W12 clear、W14 gradual 0.5;
     停課 / 不動平台的週(W3/W5/W13/W16/W17/W18)必須是 keep(尤其 W5:學生在家抓
     整合②的一週正常資料,W4 的乾淨基線絕不能被動);W9 期中乾淨;W15 clear + high。
     另驗「週次 ↔ 作業 ↔ 練習題」綁定:exercises 的 id 必須存在於 classroom_exercises.yaml、
     submissions 的 type 必須是 api/submissions.py 真的有的 grader。
  2. _grade_correlation 依 sim_t 時間戳對齊:任一序列缺值不得讓「做對的學生」被扣分
     (舊的索引截齊法會在缺值後整體位移,r 悄悄錯掉且不報錯)。
  3. 教材刻意保留的教具**不可修好**:目錄不補「合理範圍/更新頻率/版本日期」欄、
     count_over 需學生自帶 threshold(W4 §4.3 / W9 第 6 題的教學點)。

用法:
    python3 tests/test_course_grading.py
"""
from __future__ import annotations

import asyncio
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import yaml  # noqa: E402

FAIL: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {msg}")
    if not cond:
        FAIL.append(msg)


# ── 1. 週次對齊大綱 v2.1 ─────────────────────────────────
def check_course_weeks() -> None:
    data = yaml.safe_load((ROOT / "scenarios" / "course_weeks.yaml").read_text(encoding="utf-8"))
    weeks = {w["week"]: w for w in data["course"]["weeks"]}
    check(sorted(weeks) == list(range(1, 19)),
          f"18 週全定義、週次編號對齊大綱 v2.1(實際 {sorted(weeks)})")
    check(weeks.get(1, {}).get("faults") == "clear", "W1 乾淨(導覽 demo 健康園區)")
    check(weeks.get(2, {}).get("faults") == "clear", "W2 乾淨(第一次連線)")
    for w in (3, 5, 13, 16, 17, 18):
        check(weeks.get(w, {}).get("faults") == "keep", f"W{w} = keep(停課 / 不動平台)")
    # 停課週不設 order_density:教師誤按「套用」也不會改變稼動率
    for w in (3, 5, 16, 17):
        check("order_density" not in weeks.get(w, {}), f"W{w} 不設 order_density(停課不動)")
    check(weeks.get(9, {}).get("faults") == "clear", "W9 乾淨(期中現場 demo 不出意外)")
    check(weeks.get(15, {}).get("faults") == "clear"
          and weeks.get(15, {}).get("order_density") == "high",
          "W15 = clear + high(期末專題期資料要豐富)")
    check(weeks.get(4, {}).get("faults") == "clear", "W4 乾淨(平台啟用)")
    check(weeks.get(6, {}).get("faults") == "clear", "W6 乾淨(正常運轉統計 —— 整合作業②基準)")
    check(weeks.get(7, {}).get("faults") == "clear", "W7 乾淨(時序聚合 —— 學生存正常基線給 W8 用)★")
    w8 = weeks.get(8, {}).get("faults") or {}
    check(isinstance(w8, dict) and w8.get("kind") == "equipment"
          and w8.get("type") == "gradual" and w8.get("severity") == 0.85,
          "W8 = equipment gradual severity 0.85(講義六張圖以此為準)")
    w10 = weeks.get(10, {}).get("faults") or {}
    check(isinstance(w10, dict) and w10.get("type") == "sensor_drift" and w10.get("severity") == 0.6,
          "W10 = sensor_drift 0.6(感測器資料品質)")
    check(weeks.get(11, {}).get("faults") == "keep", "W11 = keep(即時串流沿用上週)")
    check(weeks.get(12, {}).get("faults") == "clear", "W12 = clear(OEE)")
    w14 = weeks.get(14, {}).get("faults") or {}
    check(isinstance(w14, dict) and w14.get("severity") == 0.5, "W14 = gradual 0.5(趨勢與預警)")


# ── 1b. 週次 ↔ 作業 ↔ 練習題綁定:指到的東西必須真的存在 ──
def check_week_bindings() -> None:
    import re

    data = yaml.safe_load((ROOT / "scenarios" / "course_weeks.yaml").read_text(encoding="utf-8"))
    ex_bank = yaml.safe_load((ROOT / "scenarios" / "classroom_exercises.yaml")
                             .read_text(encoding="utf-8"))
    valid_ex = {e["id"] for e in ex_bank["classroom"]["exercises"]}
    # grader 清單直接從 api/submissions.py 的 dispatch 表撈(不用起 SubmissionStore)
    src = (ROOT / "api" / "submissions.py").read_text(encoding="utf-8")
    valid_types = set(re.findall(r'"(\w+)":\s*self\._grade_\w+', src))

    bad_ex, bad_ty, bound = [], [], 0
    for w in data["course"]["weeks"]:
        for ex in w.get("exercises", []) or []:
            bound += 1
            if ex not in valid_ex:
                bad_ex.append(f"W{w['week']}:{ex}")
        for ty in w.get("submissions", []) or []:
            bound += 1
            if ty not in valid_types:
                bad_ty.append(f"W{w['week']}:{ty}")
    check(not bad_ex, f"週次綁定的練習題 id 都存在於題庫({bound} 筆綁定)"
          if not bad_ex else f"綁定了不存在的練習題:{bad_ex}")
    check(not bad_ty, "週次綁定的作業 type 都是真的 grader"
          if not bad_ty else f"綁定了不存在的作業 type:{bad_ty}")


# ── 2. correlation 時間戳對齊 ────────────────────────────
class _FakeHist:
    def __init__(self, series):
        self.series = series

    async def query(self, device, tag, t_from, t_to, limit=0):
        return self.series[tag]


class _FakeCourse:
    default_tolerance = 0.10
    window_start_wall = None
    window_start_sim = None


def check_correlation_alignment() -> None:
    from api.submissions import SubmissionStore

    # 快速振盪訊號(週期 ~6 樣本):索引位移一格會讓 r 大幅偏離;b = 2a 完全正相關。
    a_rows = [{"sim_t": float(t), "value": math.sin(t * 1.1)} for t in range(120)]
    b_rows = [{"sim_t": float(t), "value": 2.0 * math.sin(t * 1.1)} for t in range(120) if t != 7]

    store = SubmissionStore.__new__(SubmissionStore)
    store.historian = _FakeHist({"a": a_rows, "b": b_rows})
    store.course = _FakeCourse()
    store.world = None
    res = asyncio.run(store._grade_correlation(
        {"device": "d", "tag_a": "a", "tag_b": "b", "value": 1.0}))
    check(res["score"] == 100.0,
          f"tag_b 缺 1 點時,交正解 r=1.0 仍得滿分(實得 {res['score']};時間戳對齊)")

    # 證明修的是真問題:同樣資料用「索引截齊」會算出嚴重偏離的 r
    from api.submissions import _pearson
    a = [r["value"] for r in a_rows]
    b = [r["value"] for r in b_rows]
    n = min(len(a), len(b))
    r_old = _pearson(a[:n], b[:n])
    check(r_old is not None and abs(1.0 - r_old) > 0.2,
          f"對照:舊索引對齊在缺值後 r={r_old:.3f}(嚴重偏離 1.000)—— 不可回退成索引對齊")


# ── 3. 教材刻意保留的教具不可修好 ─────────────────────────
def check_teaching_props_untouched() -> None:
    # W4 §4.3:目錄「不完整」是教學點 —— tag 條目不得出現 合理範圍/更新頻率/版本日期 這類欄位
    from engine.world import World
    world = World.from_yaml(str(ROOT / "scenarios" / "p0_single_cnc.yaml"))
    entry = next(iter(world.devices.values())).catalog_entry()
    tag0 = entry["tags"][0]
    forbidden = {"valid_range", "range", "update_rate", "update_hz", "version", "revision_date", "updated_at"}
    check(not (forbidden & set(tag0.keys())),
          "目錄 tag 條目維持「不完整」(無 合理範圍/更新頻率/版本日期 —— W4 §4.3 教學點)")

    # W9 第 6 題:count_over 必須要求學生自帶 threshold
    from api.submissions import SubmissionStore
    store = SubmissionStore.__new__(SubmissionStore)
    store.course = _FakeCourse()
    try:
        asyncio.run(store._grade_count({"device": "d", "tag": "t", "value": 1}))
        needed = False
    except (ValueError, KeyError, TypeError):
        needed = True
    check(needed, "count_over 不帶 threshold 必須被拒(學生要用 μ+3σ 自訂 —— W9 第 6 題教學點)")


# ── 4. production 作業型別(W12 進階:準交率 / WIP)──────────
def check_production_grader() -> None:
    from api.submissions import SubmissionStore
    from engine.world import World

    world = World.from_yaml(str(ROOT / "scenarios" / "p0_single_cnc.yaml"))
    # 快轉 12 sim 小時讓 MES 產生數張完工單(dt=60s;白天時段設備會運轉)
    for _ in range(720):
        world.clock._sim_t += 60.0
        world.step(60.0)
    mes = world.mes
    did = next(iter(mes._managed))
    done = [o for o in mes.done.get(did, []) if o.done_t is not None]
    check(len(done) >= 3, f"觀測窗內有 ≥3 張完工單(實際 {len(done)})")

    store = SubmissionStore.__new__(SubmissionStore)
    store.world = world
    store.course = _FakeCourse()

    truth_rate = sum(1 for o in done if o.done_t <= o.due_t) / len(done)
    res = asyncio.run(store._grade_production(
        {"metric": "on_time_rate", "device": did, "value": truth_rate}))
    check(res["score"] == 100.0, f"準交率交正解得滿分(真值 {truth_rate:.3f})")
    res_bad = asyncio.run(store._grade_production(
        {"metric": "on_time_rate", "device": did, "value": max(0.0, truth_rate - 0.5)}))
    check(res_bad["score"] < 60.0, "準交率差 0.5 不及格")

    truth_wip = len(mes.queues.get(did, []))
    res_w = asyncio.run(store._grade_production({"metric": "wip", "device": did, "value": truth_wip}))
    check(res_w["score"] == 100.0, f"WIP 交正解得滿分(真值 {truth_wip})")
    res_w2 = asyncio.run(store._grade_production({"metric": "wip", "device": did, "value": truth_wip + 1}))
    check(res_w2["score"] == 75.0, "WIP 差 1 張得 75(與 events 同曲線)")


def main() -> None:
    print("課程教材端契約驗證")
    check_course_weeks()
    check_week_bindings()
    check_correlation_alignment()
    check_teaching_props_untouched()
    check_production_grader()
    print(f"\n失敗 {len(FAIL)} 項")
    for f in FAIL:
        print(f"  - {f}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
