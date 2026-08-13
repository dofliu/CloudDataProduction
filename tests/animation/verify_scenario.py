"""場景健全性驗證:每一間工廠、每一台設備都真的跑得起來、資料合理、且畫得出來。

回答的問題是「**所有**工廠與設備都確認過了嗎」,所以不抽樣 —— 把場景整個載進引擎跑一段,
逐台檢查:

  1. 引擎面:每台設備都有 tag、值不是 NaN/Inf、producer 真的會運轉、
     累積量(part_count / shot_count / …)只增不減。
  2. 前端面:每個 template 都有對應的 3D 模型,而且動畫綁定表(docs/animation_binding.md)
     裡宣告要用的 tag,引擎真的有發 —— 這就是先前 `tank_pressure` / `yaw_angle` 那類
     「讀到 undefined」的缺陷,靜態就能擋掉。
  3. 場景面:公司 / 設備 id 不重複、每廠至少一台 producer、組合有多樣性。
  4. 自洽面:同一台設備的 tag 必須互相印證(11 種 template 每種至少一條物理不變量,
     見 check_tag_invariants)—— 同一份 snapshot 裡出現兩套互相矛盾的資料會直接教錯學生。

用法:
    python3 tests/animation/verify_scenario.py [scenarios/class_park.yaml ...]
"""
from __future__ import annotations

import math
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

import numpy as np  # noqa: E402
import yaml  # noqa: E402

from engine.world import World  # noqa: E402
from engine.templates.robot_arm_6axis import _MAX_REACH as MAX_REACH  # noqa: E402
from engine.templates.robot_arm_6axis import _SHOULDER_H as SHOULDER_H  # noqa: E402
from engine.templates.agv_mobile_robot import NOM_SPEED as AGV_NOM_SPEED  # noqa: E402
from engine.templates.air_compressor import NOM_FLOW as AC_NOM_FLOW  # noqa: E402
from engine.templates.air_compressor import NOM_PRESSURE_BAR as AC_NOM_PRESSURE  # noqa: E402
from engine.templates.semi_process_chamber import BASE_PRESSURE, GAS_SETPOINTS  # noqa: E402
from engine.templates.stamping_press import NOM_TONNAGE  # noqa: E402
from engine.templates.wind_turbine import RATED_KW, _power_curve  # noqa: E402

WEB_WORLD = ROOT / "web" / "src" / "world"
BINDING_DOC = ROOT / "docs" / "animation_binding.md"

# 不生產、不退化的「唯讀量測」型設備 —— 這些不要求 running
NON_PRODUCER = {"energy_meter"}
# 受班表影響的設備允許在非上班時段 idle
MONOTONIC_TAGS = ["part_count", "shot_count", "stroke_count", "cycle_count",
                  "wafer_count", "energy_total", "energy_kwh", "total_energy", "running_hours"]

FAIL: list[str] = []
INFO: list[str] = []


def fail(msg: str) -> None:
    FAIL.append(msg)
    print(f"  FAIL  {msg}")


def ok(msg: str) -> None:
    print(f"  PASS  {msg}")


# ── 1. 場景結構 ───────────────────────────────────────────
def check_structure(path: Path, park: dict) -> None:
    companies = park["companies"]
    cids = [c["id"] for c in companies]
    dids = [d["id"] for c in companies for d in c["devices"]]
    names = [c["name"] for c in companies]

    dup_c = [k for k, v in Counter(cids).items() if v > 1]
    dup_d = [k for k, v in Counter(dids).items() if v > 1]
    dup_n = [k for k, v in Counter(names).items() if v > 1]
    (ok if not dup_c else fail)(f"公司 id 不重複({len(cids)} 間)" if not dup_c else f"公司 id 重複:{dup_c}")
    (ok if not dup_d else fail)(f"設備 id 不重複({len(dids)} 台)" if not dup_d else f"設備 id 重複:{dup_d}")
    (ok if not dup_n else fail)("公司名不重複" if not dup_n else f"公司名重複:{dup_n}")

    empty = [c["id"] for c in companies if not c["devices"]]
    (ok if not empty else fail)("每間公司都有設備" if not empty else f"沒有設備的公司:{empty}")

    no_prod = [c["id"] for c in companies
               if all(d["template"] in NON_PRODUCER for d in c["devices"])]
    (ok if not no_prod else fail)(
        "每間公司都至少有一台 producer(學生才有東西可診斷)" if not no_prod
        else f"只有唯讀量測設備的公司:{no_prod}")

    combos = {tuple(sorted(d["template"] for d in c["devices"])) for c in companies}
    ratio = len(combos) / len(companies)
    (ok if ratio >= 0.3 else fail)(
        f"設備組合多樣性:{len(combos)} 種組合 / {len(companies)} 間公司(比值 {ratio:.2f})")

    used = {d["template"] for c in companies for d in c["devices"]}
    INFO.append(f"{path.name}: 使用 {len(used)} 種 template")
    return used


# ── 2. 每個 template 都有 3D 模型 ─────────────────────────
def _ts_map_keys(src: str, name: str) -> set[str]:
    """撈出 `const <name> ... = { a: ..., b: ... }` 的 key。

    只吃到第一個對齊在行首的 `};` 為止 —— 先前是用「下一段註解的字串」當結尾,
    那段註解一搬家整支測試就 crash。用括號結構當邊界穩得多。
    """
    i = src.index(f"const {name}")
    end = src.index("\n};", i)
    # 一行可能塞好幾筆(`a: 1, b: 2,`),所以不能只抓行首那個 key
    return set(re.findall(r"(?:^|[{,])\s*([A-Za-z_]\w*)\s*:", src[i:end], re.M))


def check_models(used: set[str]) -> None:
    mapped = _ts_map_keys((WEB_WORLD / "FactoryLine3D.tsx").read_text(encoding="utf-8"), "MODELS")
    missing = used - mapped
    (ok if not missing else fail)(
        f"場景用到的 {len(used)} 種 template 都有 3D 模型" if not missing
        else f"沒有 3D 模型的 template:{sorted(missing)}")

    # 產線佈局表也要涵蓋 —— 少一筆就會用預設寬度,機台互相穿模或中間空一段
    flow = (WEB_WORLD / "processFlow.ts").read_text(encoding="utf-8")
    for tbl, why in [("ROLE", "製程角色"), ("LINE_SCALE", "產線縮放"), ("EXTENT_X", "佔地邊界")]:
        miss = used - _ts_map_keys(flow, tbl)
        (ok if not miss else fail)(
            f"{len(used)} 種 template 都有 processFlow.{tbl}({why})" if not miss
            else f"processFlow.{tbl} 缺:{sorted(miss)}")


# ── 3. 綁定表宣告的 tag,引擎真的有發 ─────────────────────
def check_binding_tags(world: World) -> None:
    """把 docs/animation_binding.md §4 表格裡的 `tag` 全撈出來,對照引擎實際發的 tag。

    這正是 tank_pressure / yaw_angle / voltage / current 那批缺陷的靜態防線。
    """
    doc = BINDING_DOC.read_text(encoding="utf-8")
    sec = doc[doc.index("## 4. 逐機種綁定表"):doc.index("## 5. 實作結構")]

    tags_by_tmpl: dict[str, set[str]] = {}
    for d in world.devices.values():
        tags_by_tmpl.setdefault(d.template, set()).update(t.name for t in d.tags)
        tags_by_tmpl[d.template].update(s.name for s in d.setpoints)
        tags_by_tmpl[d.template].update(c.name for c in d.command_coils)
        # 衍生點位也算「引擎有發」:FC04 輸入暫存器(含產線 line_in/out_buffer)與 FC02 DI
        tags_by_tmpl[d.template].update(p.name for p in d.input_registers)
        tags_by_tmpl[d.template].update(p.name for p in d.discrete_inputs)

    cur = None
    bad: list[str] = []
    checked = 0
    for line in sec.splitlines():
        m = re.match(r"### 4\.\d+ `(\w+)`", line)
        if m:
            cur = m.group(1)
            continue
        if cur is None or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.split("|")]
        if len(cells) < 4:
            continue
        # 第 2 欄是「引擎欄位」,裡面的 `xxx` 就是 tag 名
        for name in re.findall(r"`(\w+)`", cells[2]):
            if name in {"state", "coils", "run_enable", "reset_fault"}:
                continue
            checked += 1
            avail = tags_by_tmpl.get(cur, set())
            if avail and name not in avail:
                bad.append(f"{cur}.{name}")
    if bad:
        fail(f"綁定表宣告了引擎沒有的 tag({len(bad)} 個):{sorted(set(bad))}")
    else:
        ok(f"綁定表宣告的 {checked} 個 tag,引擎全部都有發")


# ── 4. 逐台設備跑一段,檢查資料健全 ───────────────────────
def check_runtime(world: World, park: dict, steps: int = 60) -> None:
    mult = park["sim"]["time_multiplier"]
    hz = park["sim"]["tick_hz"]
    dt_sim = mult / hz

    # 先暖機到模擬日 10:00,兩班制設備才在運轉
    for _ in range(200):
        world.clock.advance((10 * 3600 / 200) / mult)
        world.step(10 * 3600 / 200)

    first = {d.id: {t.name: t.value for t in d.tags} for d in world.devices.values()}
    seen_states: dict[str, set[str]] = {did: set() for did in world.devices}
    bad_num: list[str] = []
    for _ in range(steps):
        world.clock.advance(1.0 / hz)
        snap = world.step(dt_sim)
        for did, s in snap["devices"].items():
            seen_states[did].add(s["state"])
            for k, v in s["tags"].items():
                if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
                    bad_num.append(f"{did}.{k}")

    (ok if not bad_num else fail)(
        f"全部 {len(world.devices)} 台設備、{steps} 拍內沒有 NaN / Inf" if not bad_num
        else f"出現 NaN / Inf:{sorted(set(bad_num))[:10]}")

    last = {d.id: {t.name: t.value for t in d.tags} for d in world.devices.values()}

    # producer 必須真的運轉過
    idle_only = [did for did, st in seen_states.items()
                 if world.devices[did].template not in NON_PRODUCER
                 and not (st & {"running", "moving", "charging"})]
    (ok if not idle_only else fail)(
        "所有 producer 在觀測窗內都運轉過" if not idle_only
        else f"整段都沒運轉的 producer:{idle_only[:10]}(共 {len(idle_only)})")

    # 累積量只增不減
    regress = []
    for did in world.devices:
        for tag in MONOTONIC_TAGS:
            if tag in first[did] and tag in last[did] and last[did][tag] < first[did][tag] - 1e-6:
                regress.append(f"{did}.{tag}")
    (ok if not regress else fail)(
        "累積量(件數 / 電能 / 運轉時數)全部只增不減" if not regress
        else f"累積量倒退:{regress[:10]}")

    # 每台至少有一個 tag 在動(不是整台凍住)
    frozen = [did for did in world.devices
              if all(abs(last[did][k] - first[did].get(k, 0)) < 1e-9 for k in last[did])]
    (ok if not frozen else fail)(
        "沒有整台數值凍住的設備" if not frozen else f"數值完全沒變的設備:{frozen[:10]}")


def check_kinematics(world: World, park: dict, steps: int = 80) -> None:
    """末端座標必須是關節角的函數,不能是另一條自走的曲線。

    用的是與連桿長度無關的不變量:J1 是基座偏擺軸,J2/J3/J5 都在同一個垂直平面內,
    所以末端的水平方位角 atan2(tcp_y, tcp_x) 恆等於 joint_angle_1。學生從 Modbus
    讀六軸角度自己算正運動學,對得起來的就是這件事;對不起來就是在教錯的東西。

    (先前 tcp 是一條與角度無關的參數式擺動,方位角與 J1 的相關係數是 -0.82 ——
     手臂往左轉、回報的末端往右跑。)
    """
    arms = [d for d in world.devices.values() if d.template == "robot_arm_6axis"]
    if not arms:
        return
    dt_sim = park["sim"]["time_multiplier"] / park["sim"]["tick_hz"]
    hz = park["sim"]["tick_hz"]
    worst = 0.0
    worst_at = ""
    over_reach: list[str] = []
    samples = 0
    for _ in range(steps):
        world.clock.advance(1.0 / hz)
        snap = world.step(dt_sim)
        for d in arms:
            s = snap["devices"][d.id]
            if s["state"] != "running":
                continue
            t = s["tags"]
            samples += 1
            bearing = math.degrees(math.atan2(t["tcp_y"], t["tcp_x"]))
            dev = abs((bearing - t["joint_angle_1"] + 180) % 360 - 180)
            if dev > worst:
                worst, worst_at = dev, f"{d.id} J1={t['joint_angle_1']:.1f}° 方位={bearing:.1f}°"
            # 肩軸到端點的距離不可能超過三段連桿之和(抓單位寫錯 / 正負號翻掉)
            arm_len = math.hypot(math.hypot(t["tcp_x"], t["tcp_y"]), t["tcp_z"] - SHOULDER_H)
            if arm_len > MAX_REACH + 1.0:
                over_reach.append(f"{d.id} {arm_len:.0f}mm")

    if not samples:
        INFO.append("六軸手臂在觀測窗內都沒運轉,運動學一致性未檢查")
        return
    # 容差 2°:tcp 由乾淨角度算,joint_angle_1 讀值另外帶 ±0.15° 感測雜訊,
    # 殘差就是那個雜訊。真的接錯 / 用錯公式會差到幾十度,擋得住。
    (ok if worst < 2.0 else fail)(
        f"手臂 tcp 與 joint_angle_1 一致({len(arms)} 台 / {samples} 取樣,最大偏差 {worst:.2f}°)"
        if worst < 2.0 else
        f"tcp 與關節角不一致:最大偏差 {worst:.1f}°(容許 2°)@ {worst_at}")
    (ok if not over_reach else fail)(
        "手臂 tcp 都在機構可達範圍內" if not over_reach
        else f"tcp 超出最大伸距 {MAX_REACH:.0f}mm:{over_reach[:5]}")


# ── 5. 跨 tag 資料自洽性:同一台設備的 tag 必須互相印證 ───
def check_tag_invariants(world: World, park: dict, samples: int = 240, dt_step: float = 120.13) -> None:
    """每種 template 至少一條物理不變量;誤差超出容忍就 fail(容忍值都寫了理由)。

    手臂 tcp ↔ 關節角互相矛盾(相關係數 −0.82)就是靠這類不變量抓到的:
    同一份 snapshot 裡兩套互相矛盾的資料,學生自己交叉驗證時會直接學到錯的物理。

    取樣設計(三個刻意的選擇):
      · 引擎是離散推進 —— 班表 / 產線閘門 / 累積量都只在 step 邊界變化,所以
        「第 n 拍的 state / rate tag」就是第 n 步累積量所用的運轉點,累積量核帳
        (Δcount = Σ rate·dt,只加 state=running 的拍)可以逐拍精確對帳。
      · dt_step 帶小數(120.13):沖壓行程週期是 1.0 s,整數 dt 會讓相位完全
        aliasing(每拍落在同一相位)—— 小數部分讓 240 拍掃過整個行程相位。
      · 窗口約 8 模擬小時:班表負載 0.9+0.15·sin(時段) 要有可觀變化,
        「健康時正相關」這類統計檢定才有意義。
    """
    mult = park["sim"]["time_multiplier"]
    by_tmpl: dict[str, list[str]] = {}
    for d in world.devices.values():
        by_tmpl.setdefault(d.template, []).append(d.id)
    h0 = {d.id: {c.name: c.health for c in d.components.values()} for d in world.devices.values()}

    series: dict[str, list[dict]] = {did: [] for did in world.devices}
    for _ in range(samples):
        world.clock.advance(dt_step / mult)
        snap = world.step(dt_step)
        for did, s in snap["devices"].items():
            # 注意:每台設備本來就有名為 state 的 enum tag,狀態「字串」要放保留鍵 _state
            series[did].append({**s["tags"], "_state": s["state"]})
    h1 = {d.id: {c.name: c.health for c in d.components.values()} for d in world.devices.values()}

    def report(what: str, viol: list[str], checked: int) -> None:
        if checked == 0:
            INFO.append(f"不變量未檢查(場景沒有該設備或無有效取樣):{what}")
            return
        (ok if not viol else fail)(
            f"{what}({checked} 台)" if not viol
            else f"{what} 違反:{viol[:3]}(共 {len(viol)} 筆)")

    dt = dt_step
    sqrt3 = math.sqrt(3.0)

    # energy_meter:P ≈ √3·V̄·Ī·pf(三相自洽)且 energy_total 增速 ≈ ∫P dt
    viol, n = [], 0
    for did in by_tmpl.get("energy_meter", []):
        sam = series[did]
        n += 1
        exp_kwh = 0.0
        for i, s in enumerate(sam):
            vavg = (s["voltage_l1"] + s["voltage_l2"] + s["voltage_l3"]) / 3.0
            iavg = (s["current_l1"] + s["current_l2"] + s["current_l3"]) / 3.0
            p_calc = sqrt3 * vavg * iavg * s["power_factor"] / 1000.0
            # 容忍:三相電流不平衡係數平均 1.0033(引擎刻意的 0.3% 偏差)+
            #        P/I/pf 量測雜訊 3σ 合計約 1.2 kW → 3% + 1.5
            if abs(s["active_power"] - p_calc) > 0.03 * max(p_calc, 1.0) + 1.5:
                viol.append(f"{did}: P={s['active_power']:.1f}kW 三相算得 {p_calc:.1f}kW")
                break
            if i > 0:
                exp_kwh += s["active_power"] * dt / 3600.0
        de = sam[-1]["energy_total"] - sam[0]["energy_total"]
        # energy_total 是 int kWh:頭尾截尾各 ±1;P 雜訊零均值、積分近乎消掉 → 2% + 2
        if abs(de - exp_kwh) > 0.02 * exp_kwh + 2.0:
            viol.append(f"{did}: ΔE={de} 積分 {exp_kwh:.1f} kWh")
    report("energy_meter:P ≈ √3·V·I·pf 且 energy_total 增速 ≈ ∫P dt", viol, n)

    # air_compressor:flow ↔ motor_current 的負載耦合(同樣出風,濾網越堵 / 軸承越磨越費力)。
    # 註:不能用整窗相關係數 —— continuous 班表負載近乎常數(±5% ripple),8 小時窗內的
    # 變化被濾網緩堵主導(flow 微降、電流微升),健康機也會量出 r≈−0.3,那是誠實物理不是缺陷。
    # 改逐拍驗:由 flow 反推負載率,motor_current 必須落在物理式上(比相關性更強且不必挑健康機)。
    viol, n = [], 0
    for did in by_tmpl.get("air_compressor", []):
        sam = series[did]
        n += 1
        dev = world.devices[did]
        sp = dev.setpoint("pressure_setpoint", AC_NOM_PRESSURE)

        def _pred_i(flow: float, h: dict) -> float:
            hf, hb = h.get("filter_clog", 1.0), h.get("motor_bearing", 1.0)
            lf = (flow / (AC_NOM_FLOW * (0.6 + 0.4 * hf)) - 0.85) / 0.15   # flow 反推負載率
            return (18.0 + 0.08 * dev.duty.load_nom * lf + 2.2 * (sp - AC_NOM_PRESSURE)
                    + 6.0 * (1.0 - hf) + 3.0 * (1.0 - hb))

        for s in sam:
            if s["_state"] != "running":
                continue
            # 取樣當下的真實健康度落在窗頭 h0 與窗尾 h1 之間(8 小時內濾網會再堵 ~0.05,
            # 經 flow 反推放大後夠成 ~1A 的系統差)→ 用兩端點健康度做包絡帶,
            # 再加雜訊容忍(flow 反推的負載雜訊放大 + 電流雜訊,合成 3σ ≈ 0.9 → 1.0)
            p0, p1 = _pred_i(s["flow"], h0[did]), _pred_i(s["flow"], h1[did])
            if not (min(p0, p1) - 1.0 <= s["motor_current"] <= max(p0, p1) + 1.0):
                viol.append(f"{did}: I={s['motor_current']:.1f}A 由 flow 預測 {p0:.1f}~{p1:.1f}A")
                break
    report("air_compressor:motor_current 與 flow 的負載耦合自洽", viol, n)

    # cnc:spindle_current ≈ 2 + 0.085·load + 摩擦項;part_count 增速 ≈ Σ dt/cycle_time
    viol, n = [], 0
    for did in by_tmpl.get("cnc_machining_center", []):
        sam = series[did]
        n += 1
        drift = 3.0 * max(0.0, h0[did].get("spindle_bearing", 1.0) - h1[did].get("spindle_bearing", 1.0))
        exp_parts = 0.0
        for i, s in enumerate(sam):
            if s["_state"] != "running":
                continue
            pred = 2.0 + 0.085 * s["spindle_load"] + 3.0 * (1.0 - h0[did].get("spindle_bearing", 1.0))
            # 容忍:load/電流量測雜訊 3σ ≈ 0.36 + 窗內軸承退化讓摩擦項再動 drift → 0.5 + drift
            if abs(s["spindle_current"] - pred) > 0.5 + drift:
                viol.append(f"{did}: I={s['spindle_current']:.2f}A 預測 {pred:.2f}A")
                break
            if i > 0:
                exp_parts += dt / max(1.0, s["cycle_time"])
        dp = sam[-1]["part_count"] - sam[0]["part_count"]
        # cycle_time 雜訊 0.3s/45s < 1%、計數頭尾截尾 ±1 → 3% + 2
        if exp_parts > 0 and abs(dp - exp_parts) > 0.03 * exp_parts + 2.0:
            viol.append(f"{did}: Δparts={dp} 預測 {exp_parts:.1f}")
    report("cnc:spindle_current 隨 spindle_load;part_count 增速 ≈ 1/cycle_time", viol, n)

    # heat_treat_furnace:energy_kwh 增速 ≈ ∫heating_power dt(運轉拍)
    viol, n = [], 0
    for did in by_tmpl.get("heat_treat_furnace", []):
        sam = series[did]
        n += 1
        exp_kwh = sum(s["heating_power"] * dt / 3600.0
                      for s in sam[1:] if s["_state"] == "running")
        de = sam[-1]["energy_kwh"] - sam[0]["energy_kwh"]
        # int kWh 頭尾截尾 ±1、功率雜訊 0.6 kW 零均值 → 3% + 3
        if abs(de - exp_kwh) > 0.03 * exp_kwh + 3.0:
            viol.append(f"{did}: ΔE={de} 積分 {exp_kwh:.1f} kWh")
    report("heat_treat_furnace:energy_kwh 增速 ≈ ∫heating_power dt", viol, n)

    # stamping_press:噸位是滑塊位置的同相函數(尖峰在下死點);stroke_count 增速 ≈ stroke_rate
    viol, n = [], 0
    for did in by_tmpl.get("stamping_press", []):
        sam = series[did]
        n += 1
        hc = h1[did].get("clutch_brake_wear", 1.0)   # 取窗尾(較低)健康度 → wobble 上界最保守
        exp_strokes = 0.0
        for i, s in enumerate(sam):
            if s["_state"] != "running":
                continue
            pred = NOM_TONNAGE * (0.9 + 0.1 * s["ram_position"] / 120.0)
            # 容忍:離合器退化的噸位波動上界 12·(1−h) + 量測雜訊 3σ=3 + 餘裕 1
            if abs(s["tonnage"] - pred) > 12.0 * (1.0 - hc) + 4.0:
                viol.append(f"{did}: ram={s['ram_position']:.0f}mm tonnage={s['tonnage']:.0f} 預測 {pred:.0f}")
                break
            if i > 0:
                exp_strokes += s["stroke_rate"] / 60.0 * dt
        ds = sam[-1]["stroke_count"] - sam[0]["stroke_count"]
        # stroke_rate 雜訊 0.3spm(<1%)、計數頭尾截尾 ±1 → 3% + 3
        if exp_strokes > 0 and abs(ds - exp_strokes) > 0.03 * exp_strokes + 3.0:
            viol.append(f"{did}: Δstrokes={ds} 預測 {exp_strokes:.0f}")
    report("stamping_press:tonnage 與 ram_position 同相(尖峰在下死點);stroke_count ≈ ∫rate", viol, n)

    # wind_turbine:power 落在功率曲線上;total_energy 增速 ≈ ∫power dt
    viol, n = [], 0
    for did in by_tmpl.get("wind_turbine", []):
        sam = series[did]
        n += 1
        exp_kwh = sum(s["power_output"] * dt / 3600.0 for s in sam[1:])
        for prev, s in zip(sam, sam[1:]):
            # 引擎的 power 與回報的 wind_speed 出自同一個內部風速 → 殘差只有功率雜訊 σ=8。
            # 容忍取 5σ=40:兩場景 × 240 拍 × 全部風機近萬次抽樣,3σ~4σ 必然出統計離群;
            # 真接錯(曲線平移 / 單位錯)會差上百 kW,5σ 照樣擋得住。
            allow = RATED_KW * _power_curve(s["wind_speed"])
            if s["_state"] == "running":
                if abs(s["power_output"] - allow) > 40.0:
                    viol.append(f"{did}: ws={s['wind_speed']:.1f} P={s['power_output']:.0f} 曲線 {allow:.0f}")
                    break
            elif prev["_state"] != "running":
                # 非運轉拍只驗上界:state_fn 以 pf>0.02 當 running 門檻,cut-in 邊緣的 idle
                # 標籤仍可能有 ≤40kW 的合法輸出;教師停機 / 故障則是 0 —— 兩者都不得超過
                # 風況允許值。要求連續兩拍非運轉:故障閂鎖發生在該拍訊號算完之後,
                # 轉換拍的 tag 與 state 天生有一拍歪斜(引擎推進順序),不是資料在說謊。
                if s["power_output"] > allow + 40.0 or s["power_output"] < -40.0:
                    viol.append(f"{did}: idle 卻 P={s['power_output']:.0f}(風況允許 {allow:.0f})")
                    break
        de = sam[-1]["total_energy"] - sam[0]["total_energy"]
        # 功率雜訊 8kW 零均值,240 拍積分後 ≪ 1% → 2% + 5
        if abs(de - exp_kwh) > 0.02 * exp_kwh + 5.0:
            viol.append(f"{did}: ΔE={de:.0f} 積分 {exp_kwh:.0f} kWh")
    report("wind_turbine:power 落在功率曲線;total_energy 增速 ≈ ∫power dt", viol, n)

    # agv:位移不超過 speed×Δt(不瞬移);SOC 移動只降、充電只升
    viol, n = [], 0
    for did in by_tmpl.get("agv_mobile_robot", []):
        sam = series[did]
        n += 1
        for prev, s in zip(sam, sam[1:]):
            hop = math.hypot(s["pos_x"] - prev["pos_x"], s["pos_y"] - prev["pos_y"])
            dsoc = s["battery_soc"] - prev["battery_soc"]
            if s["_state"] == "moving":
                # 位置無雜訊、弦長 ≤ 弧長 = NOM_SPEED·dt;+0.5m 餘裕(靠站貼齊)
                if hop > AGV_NOM_SPEED * dt + 0.5:
                    viol.append(f"{did}: 一拍位移 {hop:.1f}m > {AGV_NOM_SPEED * dt:.1f}m")
                    break
                # SOC 雜訊 σ=0.05、兩拍差 σ≈0.07;門檻 0.35≈5σ(近萬對取樣,3σ 會出統計離群);
                # 要抓的「移動中充電」是 +0.48/拍,5σ 照樣擋得住
                if dsoc > 0.35:
                    viol.append(f"{did}: 移動中 SOC +{dsoc:.2f}")
                    break
            elif s["_state"] == "charging" and dsoc < -0.35:
                viol.append(f"{did}: 充電中 SOC {dsoc:.2f}")
                break
    report("agv:位移 ≤ speed×Δt;SOC 移動只降、充電只升", viol, n)

    # semi_process_chamber:腔壓 = 基壓(泵健康)+ 氣體負載;wafer_count 增速 ≈ throughput
    viol, n = [], 0
    gas_load = 0.55 * sum(GAS_SETPOINTS)
    for did in by_tmpl.get("semi_process_chamber", []):
        sam = series[did]
        n += 1
        floor_drift = 30.0 * max(0.0, h0[did].get("vacuum_pump_wear", 1.0) - h1[did].get("vacuum_pump_wear", 1.0))
        exp_wafers = 0.0
        for i, s in enumerate(sam):
            if s["_state"] != "running":
                continue
            pred = BASE_PRESSURE + 30.0 * (1.0 - h0[did].get("vacuum_pump_wear", 1.0)) + gas_load
            # 容忍:recipe 步進 ±3% 氣體負載 ≈ 1.6 + 雜訊 3σ=1.8 + 窗內泵退化讓基壓再爬 floor_drift → 5
            if abs(s["chamber_pressure"] - pred) > 5.0 + floor_drift:
                viol.append(f"{did}: P={s['chamber_pressure']:.1f}mTorr 預測 {pred:.1f}")
                break
            if i > 0:
                exp_wafers += s["throughput"] * dt / 3600.0
        dw = sam[-1]["wafer_count"] - sam[0]["wafer_count"]
        # throughput 雜訊 0.15wph(<1%)、計數頭尾截尾 ±1 → 3% + 2
        if exp_wafers > 0 and abs(dw - exp_wafers) > 0.03 * exp_wafers + 2.0:
            viol.append(f"{did}: Δwafers={dw} 預測 {exp_wafers:.1f}")
    report("semi_process_chamber:腔壓自洽(基壓+氣體負載);wafer_count ≈ ∫throughput", viol, n)

    # injection_molding:shot_count 增速 ≈ Σ dt/cycle_time
    viol, n = [], 0
    for did in by_tmpl.get("injection_molding", []):
        sam = series[did]
        n += 1
        exp_shots = sum(dt / max(1.0, s["cycle_time"])
                        for s in sam[1:] if s["_state"] == "running")
        ds = sam[-1]["shot_count"] - sam[0]["shot_count"]
        # cycle_time 雜訊 0.2s/30s < 1%、計數頭尾截尾 ±1 → 3% + 2
        if exp_shots > 0 and abs(ds - exp_shots) > 0.03 * exp_shots + 2.0:
            viol.append(f"{did}: Δshots={ds} 預測 {exp_shots:.1f}")
    report("injection_molding:shot_count 增速 ≈ 1/cycle_time", viol, n)

    # conveyor:待機帶速必為 0;停帶(run_enable=0)時帳上件數不得前進(主動探針)
    viol, n = [], 0
    for did in by_tmpl.get("conveyor", []):
        n += 1
        for prev, s in zip(series[did], series[did][1:]):
            # 連續兩拍非運轉才斷言帶速歸零(轉換拍的 tag/state 有一拍歪斜,見風機註解)
            if s["_state"] != "running" and prev["_state"] != "running" and abs(s["belt_speed"]) > 0.05:
                viol.append(f"{did}: 待機帶速 {s['belt_speed']:.2f} m/s")
                break
    term_lines = [ln for ln in world.lines.lines
                  if ln.stations and ln.stations[-1].role == "terminal"]
    for ln in term_lines[:3]:      # 抽 3 條即可:同一套記帳程式,全跑只是變慢
        conv = ln.stations[-1].device
        conv.set_coil("run_enable", False)
        shipped0 = ln.shipped
        for _ in range(5):
            world.clock.advance(dt_step / mult)
            snap = world.step(dt_step)
            v = snap["devices"][conv.id]["tags"]["belt_speed"]
            if abs(v) > 0.05:
                viol.append(f"{conv.id}: run_enable=0 帶速仍 {v:.2f} m/s")
                break
        if ln.shipped != shipped0:
            viol.append(f"{ln.company_id}:{conv.id} 停帶仍出貨 +{ln.shipped - shipped0}")
        conv.set_coil("run_enable", True)
    if not term_lines:
        INFO.append("conveyor 停帶探針未執行:場景沒有輸送帶終站的產線")
    report("conveyor:待機/停帶時帶速為 0、帳上件數不前進", viol, n)


def verify(path: Path) -> None:
    print(f"\n=== {path} ===")
    park = yaml.safe_load(path.read_text(encoding="utf-8"))["park"]
    used = check_structure(path, park)
    check_models(used)
    world = World(park)
    check_binding_tags(world)
    check_runtime(world, park)
    check_kinematics(world, park)
    check_tag_invariants(world, park)


def main() -> None:
    paths = [Path(p) for p in sys.argv[1:]] or [
        ROOT / "scenarios" / "class_park.yaml",
        ROOT / "scenarios" / "default_park.yaml",
    ]
    print("場景健全性驗證(不抽樣,逐廠逐台)")
    for p in paths:
        verify(p)
    print()
    for i in INFO:
        print(f"  · {i}")
    print(f"\n失敗 {len(FAIL)} 項")
    for f in FAIL:
        print(f"  - {f}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
