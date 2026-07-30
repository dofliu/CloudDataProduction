"""輸入控制端到端驗證:CNC 刻字文字 / 手臂取放點,寫進 setpoint 後引擎輸出真的跟著變。

驗的是「學生寫得進去、且訊號誠實反映」這條線,不是動畫:
  1. CNC 預設刻「NCUT」的刀路與升級前逐點相同(零回歸)。
  2. 寫 engrave_char_* 換文字 → pos_x/y 走的是新文字的筆畫、且在 ±220 行程內。
  3. 手臂寫 pick_x/y、place_x/y → 下探時 tcp_x/y/z 真的落在指定座標(±2 mm,
     角度雜訊另計),且「方位角 ≡ J1」不變量保持成立。
  4. IK↔FK 往返:任意可達點解出角度再正解回去,誤差 < 1e-6 mm。

用法:
    python3 tests/test_input_control.py
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from engine.templates import cnc_machining_center as cnc  # noqa: E402
from engine.templates import robot_arm_6axis as arm  # noqa: E402
from engine.templates._stroke_font import GLYPHS, codes_to_text, text_strokes  # noqa: E402

FAIL: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {msg}")
    if not cond:
        FAIL.append(msg)


# ── 1. CNC 預設 NCUT 刀路零回歸 ──────────────────────────
def check_cnc_default() -> None:
    legacy = [   # 升級前 _ncut_strokes() 的輸出,寫死當基準
        [(-180.0, 60.0), (-180.0, -60.0)], [(-180.0, -60.0), (-120.0, 60.0)],
        [(-120.0, 60.0), (-120.0, -60.0)],
        [(-20.0, -60.0), (-80.0, -60.0), (-80.0, 60.0), (-20.0, 60.0)],
        [(20.0, -60.0), (20.0, 60.0), (80.0, 60.0), (80.0, -60.0)],
        [(120.0, -60.0), (180.0, -60.0)], [(150.0, -60.0), (150.0, 60.0)],
    ]
    now = [[(round(x, 6), round(y, 6)) for x, y in s] for s in text_strokes("NCUT")]
    check(now == legacy, "CNC 預設「NCUT」筆畫與升級前逐點相同")


# ── 2. CNC 寫文字 → 刀路跟著變 ───────────────────────────
def check_cnc_text_input() -> None:
    dev = cnc.build("cnc-t1", {}, "c01")
    for i, ch in enumerate("AI"):
        dev.set_setpoint(f"engrave_char_{i + 1}", ord(ch))
    for i in range(2, 8):
        dev.set_setpoint(f"engrave_char_{i + 1}", 0)

    # 逐步推進,收集下刀中(pos_z<0)的座標
    dev.set_sim_t(10 * 3600)          # 讓 duty cycle 在上班時段
    pts = []
    for k in range(1200):
        dev.set_sim_t(10 * 3600 + k * 0.5)
        dev.step(0.5)
        tags = {t.name: t.value for t in dev.tags}
        if tags["pos_z"] < 0:
            pts.append((tags["pos_x"], tags["pos_y"]))
    check(len(pts) > 50, f"寫入「AI」後有切削點({len(pts)} 點)")

    strokes = text_strokes("AI")
    seg_pts = [p for s in strokes for p in s]

    def dist_to_strokes(x: float, y: float) -> float:
        best = math.inf
        for s in strokes:
            for (x1, y1), (x2, y2) in zip(s, s[1:]):
                dx, dy = x2 - x1, y2 - y1
                L2 = dx * dx + dy * dy
                t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / L2))
                best = min(best, math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)))
        return best

    worst = max(dist_to_strokes(x, y) for x, y in pts)
    check(worst < 1.0, f"切削點全部落在「AI」筆畫上(最大偏距 {worst:.3f} mm)")
    inb = all(abs(x) <= 220 and abs(y) <= 220 for x, y in pts)
    check(inb, "切削點都在 ±220 mm 行程內")
    # 「AI」有字、seg_pts 非空,防呆
    check(len(seg_pts) > 0, "筆畫字型有生成「AI」的筆畫")

    # 全空白 → 停刀在原點上方,不切削
    for i in range(8):
        dev.set_setpoint(f"engrave_char_{i + 1}", 32)
    cut = 0
    for k in range(200):
        dev.set_sim_t(10 * 3600 + 600 + k * 0.5)
        dev.step(0.5)
        if {t.name: t.value for t in dev.tags}["pos_z"] < 0:
            cut += 1
    check(cut == 0, "全空白文字 → 停刀不切削")


# ── 3. 手臂 IK↔FK 往返 ───────────────────────────────────
def check_arm_ik_roundtrip() -> None:
    worst = 0.0
    for x, y in [(820, -820), (820, 820), (500, 0), (-300, 900), (1100, 300), (0, -1200)]:
        for z in (150.0, 600.0):
            ang = arm.inverse_kinematics(x, y, z)
            fx, fy, fz = arm.forward_kinematics(ang)
            r_req = math.hypot(x, y)
            r_cl = max(300.0, min(1250.0, r_req))
            ex, ey = r_cl * x / r_req, r_cl * y / r_req
            worst = max(worst, math.hypot(math.hypot(fx - ex, fy - ey), fz - z))
    check(worst < 1e-6, f"IK↔FK 往返誤差 {worst:.2e} mm(< 1e-6)")


# ── 4. 手臂寫取放點 → tcp 真的到 ─────────────────────────
def check_arm_pick_place_input() -> None:
    dev = arm.build("arm-t1", {"duty_cycle": {"profile": "continuous"}}, "c01")
    pick, place = (600.0, 300.0), (-400.0, 700.0)
    dev.set_setpoint("pick_x", pick[0]); dev.set_setpoint("pick_y", pick[1])
    dev.set_setpoint("place_x", place[0]); dev.set_setpoint("place_y", place[1])

    reached_pick = math.inf
    reached_place = math.inf
    worst_bearing = 0.0
    for k in range(400):                      # 一循環 8 sim 秒,0.1s tick → 涵蓋 5 圈
        dev.set_sim_t(10 * 3600 + k * 0.1)
        dev.step(0.1)
        t = {tg.name: tg.value for tg in dev.tags}
        if dev.state != "running":
            continue
        reached_pick = min(reached_pick, math.hypot(t["tcp_x"] - pick[0], t["tcp_y"] - pick[1]))
        reached_place = min(reached_place, math.hypot(t["tcp_x"] - place[0], t["tcp_y"] - place[1]))
        bearing = math.degrees(math.atan2(t["tcp_y"], t["tcp_x"]))
        dev_b = abs((bearing - t["joint_angle_1"] + 180) % 360 - 180)
        worst_bearing = max(worst_bearing, dev_b)
    check(reached_pick < 2.0, f"tcp 曾抵達指定取件點(最近 {reached_pick:.2f} mm)")
    check(reached_place < 2.0, f"tcp 曾抵達指定放件點(最近 {reached_place:.2f} mm)")
    check(worst_bearing < 2.0, f"方位角 ≡ J1 不變量保持(最大偏差 {worst_bearing:.2f}°,含讀值雜訊)")


def main() -> None:
    print("輸入控制驗證(CNC 刻字 / 手臂取放)")
    check_cnc_default()
    check_cnc_text_input()
    check_arm_ik_roundtrip()
    check_arm_pick_place_input()
    print(f"\n失敗 {len(FAIL)} 項")
    for f in FAIL:
        print(f"  - {f}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
