"""6 軸機械手臂 template(docs/03,離散製造)。

headline:諧波減速機(reducer_wear)退化 → 振動上升、各軸電流/溫度跟漲。
encoder_drift 是感測器型(只汙染某軸角度讀值)。pre_step 讓六軸做 pick-and-place 擺動,
tcp_x/y/z 由 forward_kinematics() 從同一組角度算出 —— 學生從 Modbus 讀六軸角度自己算
正運動學,答案必須與 tcp 對得起來。

取放兩點**可由學生指定**:setpoints pick_x/pick_y/place_x/place_y(mm,地面座標)。
引擎用 inverse_kinematics() 把目標點解回六軸角度,再照六個 keyframe(上方→下探→上方)
擺動 —— 學生寫進去的座標,從 Modbus 讀 tcp_x/y/z 就能驗證真的到了。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile, SetPoint
from ..signals import gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 25.0
CYCLE_PERIOD = 8.0          # 一次取放循環的秒數(sim 秒)
# 各軸活動中心與擺幅(deg)
_JOINT_CENTER = [0.0, -30.0, 45.0, 0.0, 30.0, 0.0]
_JOINT_AMP = [60.0, 25.0, 35.0, 90.0, 40.0, 120.0]

# ── 機構尺寸與正運動學 ──────────────────────────────────────
# tcp_x/y/z 必須是 joint_angle_1..6 的函數,不能各走各的:學生從 Modbus 讀到六軸角度
# 自己算正運動學,答案要跟 tcp_x/y/z 對得起來,否則就是在教錯的東西(鐵則二)。
_SHOULDER_H = 400.0         # 底座到 J2 肩軸的高度(mm)
_L_UPPER = 640.0            # 上臂 J2→J3
_L_FORE = 680.0             # 前臂 J3→J5
_L_WRIST = 280.0            # 腕部 J5→夾爪端點
# 控制器關節零位 → 機構零位的偏移(deg)。真實手臂也是這樣:controller 的 DH 零位
# 不等於機構的幾何零位。這是換座標系,不改資料 —— 角度變化量與讀值 1:1。
_JOINT_ZERO = {"j2": 40.0, "j3": 15.0, "j5": 25.0}
# 座標系:X = 手臂伸出方向(J1=0 時),Y = 左,Z = 上。原點在底座中心地面。
_MAX_REACH = _L_UPPER + _L_FORE + _L_WRIST


def forward_kinematics(angles: list[float]) -> tuple[float, float, float]:
    """由六軸角度(deg,控制器讀值)算夾爪端點座標(mm)。

    J1 是基座偏擺,J2/J3/J5 是同一垂直平面內的俯仰軸,J4/J6 只轉腕不移動端點。
    因此端點的水平方位角恆等於 J1 —— 這是驗證資料一致性最直接的不變量。
    """
    d = math.radians
    c2 = d(angles[1] + _JOINT_ZERO["j2"])
    c3 = c2 + d(angles[2] + _JOINT_ZERO["j3"])
    c5 = c3 + d(angles[4] + _JOINT_ZERO["j5"])
    reach = math.sin(c2) * _L_UPPER + math.sin(c3) * _L_FORE + math.sin(c5) * _L_WRIST
    z = _SHOULDER_H + math.cos(c2) * _L_UPPER + math.cos(c3) * _L_FORE + math.cos(c5) * _L_WRIST
    a1 = d(angles[0])
    return reach * math.cos(a1), reach * math.sin(a1), z


# ── 逆運動學(取放點 → 六軸角度)──────────────────────────
# 腕部絕對俯仰固定在 170°(工具幾乎朝下,與原 keyframe 下探姿態相同),剩下 J2/J3
# 就是標準的兩連桿平面 IK。J1 = atan2(y, x) —— 「方位角 ≡ J1」的不變量因此保持成立。
_WRIST_PITCH_DEG = 170.0
_Z_DOWN = 150.0            # 下探(夾取 / 放置)時的 TCP 高度(mm),即料檯面高度
_Z_UP = 600.0              # 移動段抬升高度(mm)
_R_MIN, _R_MAX = 300.0, 1250.0   # 水平距離可解範圍;超出就夾限(tcp 誠實回報實際位置)


def inverse_kinematics(x: float, y: float, z: float) -> list[float]:
    """目標 TCP(mm)→ [j1..j6](deg,控制器讀值)。

    水平距離會夾限到 [_R_MIN, _R_MAX](兩連桿在 _Z_UP 高度仍可達的範圍);
    夾限後的實際位置由 forward_kinematics 誠實反映在 tcp_x/y/z。
    回傳的角度餵回 forward_kinematics 即還原目標點(engine 端測試驗證)。
    """
    j1 = math.degrees(math.atan2(y, x))
    r = max(_R_MIN, min(_R_MAX, math.hypot(x, y)))
    c5 = math.radians(_WRIST_PITCH_DEG)
    # 腕心(J5 軸)位置:從 TCP 退掉腕段
    rw = r - math.sin(c5) * _L_WRIST
    zw = (z - math.cos(c5) * _L_WRIST) - _SHOULDER_H
    d = math.hypot(rw, zw)
    d = min(d, (_L_UPPER + _L_FORE) * 0.9999)          # 數值保險:不超過全伸
    phi = math.atan2(rw, zw)                            # 腕心方向(自垂直軸起算)
    cos_a = (_L_UPPER ** 2 + d ** 2 - _L_FORE ** 2) / (2.0 * _L_UPPER * d)
    alpha = math.acos(max(-1.0, min(1.0, cos_a)))
    c2 = phi - alpha                                    # 肘上解(與原 keyframe 同分支)
    c3 = math.atan2(rw - math.sin(c2) * _L_UPPER, zw - math.cos(c2) * _L_UPPER)
    j2 = math.degrees(c2) - _JOINT_ZERO["j2"]
    j3 = math.degrees(c3 - c2) - _JOINT_ZERO["j3"]
    j5 = math.degrees(c5 - c3) - _JOINT_ZERO["j5"]
    return [j1, j2, j3, 0.0, j5, 0.0]


# 預設取放點:與升級前 _KEYFRAMES 的下探姿態幾乎同位(J1=∓45°、reach≈1160 mm),
# 預設行為與畫面佈局(processFlow 取放對位)因此不變。
_DEFAULT_PICK = (820.0, -820.0)
_DEFAULT_PLACE = (820.0, 820.0)


def build_keyframes(pick_xy: tuple[float, float], place_xy: tuple[float, float]) -> list[list[float]]:
    """由取放兩點組出六個 keyframe:上方(pick)→ 下探(pick)→ 上方 → 上方(place)→ 下探(place)→ 上方。"""
    up_p = inverse_kinematics(pick_xy[0], pick_xy[1], _Z_UP)
    dn_p = inverse_kinematics(pick_xy[0], pick_xy[1], _Z_DOWN)
    up_q = inverse_kinematics(place_xy[0], place_xy[1], _Z_UP)
    dn_q = inverse_kinematics(place_xy[0], place_xy[1], _Z_DOWN)
    return [up_p, dn_p, up_p, up_q, dn_q, up_q]

_TAG_SPEC = (
    [("state", "enum", "int16")]
    + [(f"joint_angle_{i}", "deg", "float32") for i in range(1, 7)]
    + [(f"joint_current_{i}", "A", "float32") for i in range(1, 7)]
    + [(f"joint_temp_{i}", "degC", "float32") for i in range(1, 7)]
    + [("tcp_x", "mm", "float32"), ("tcp_y", "mm", "float32"), ("tcp_z", "mm", "float32")]
    + [("vibration_rms", "mm/s", "float32"), ("cycle_count", "count", "int32")]
)
_INDICATORS = {"encoder_drift", "joint_bearing"}
_DEFAULT_DEGRADATION = {
    "reducer_wear": {"rate": 0.0000010, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.94},
    "joint_bearing": {"rate": 0.0000009, "trajectory": "exponential", "k": 2.5, "sigma": 0.12, "init_health": 0.96, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty = DutyProfile(profile=cfg.get("duty_cycle", {}).get("profile", "continuous"),
                       load_nom=cfg.get("duty_cycle", {}).get("load_nom", 65.0))

    seed = cfg.get("seed", default_seed(device_id))
    rng = np.random.default_rng(seed)
    components = build_components(cfg, _INDICATORS, rng, defaults=_DEFAULT_DEGRADATION)
    comp_map = {c.name: c for c in components}

    protocols = cfg.get("protocols", {}) or {}
    opcua_folder = (protocols.get("opcua", {}) or {}).get("node_folder", f"{company_id}/{device_id}")
    modbus_base = (protocols.get("modbus", {}) or {}).get("register_base", 0)
    tags = build_tags(_TAG_SPEC, modbus_base, opcua_folder)
    tag_by_name = {t.name: t for t in tags}
    nrng = np.random.default_rng(int(rng.integers(0, 2**31)))
    phase0 = float(rng.uniform(0, 2 * math.pi))   # 個體相位差

    st = {"t": 0.0, "cycles": 0.0, "angles": list(_JOINT_CENTER),
          "tcp": list(forward_kinematics(_JOINT_CENTER)), "running": False,
          "ph": 0.0, "waiting": False}   # ph / waiting:產線 handler 模式用(事件驅動取放)

    # keyframe 快取:取放 setpoint 沒變就不重解 IK(每 tick 都會來讀)
    kf_cache: dict = {"key": None, "frames": None}

    def _keyframes() -> list[list[float]]:
        key = (device.setpoint("pick_x", _DEFAULT_PICK[0]), device.setpoint("pick_y", _DEFAULT_PICK[1]),
               device.setpoint("place_x", _DEFAULT_PLACE[0]), device.setpoint("place_y", _DEFAULT_PLACE[1]))
        if key != kf_cache["key"]:
            kf_cache["key"] = key
            kf_cache["frames"] = build_keyframes((key[0], key[1]), (key[2], key[3]))
        return kf_cache["frames"]

    def _pose_at(ph: float) -> None:
        """把相位 ph ∈ [0,1) 對應到六個 keyframe 的插值姿態,寫進 st["angles"]/st["tcp"]。"""
        idx = int(ph * 6)
        t_interp = (ph * 6) - idx
        t_interp = t_interp * t_interp * (3 - 2 * t_interp)  # Smoothstep
        frames = _keyframes()
        k1 = frames[idx % 6]
        k2 = frames[(idx + 1) % 6]
        for i in range(6):
            st["angles"][i] = k1[i] + (k2[i] - k1[i]) * t_interp
        # 末端位置由同一組角度算出來 —— 不是另外編一條擺動曲線
        st["tcp"][0], st["tcp"][1], st["tcp"][2] = forward_kinematics(st["angles"])

    def pre_step(dt_sim, op):
        st["running"] = op["running"] and not device._fault_latched
        if not st["running"]:
            return

        # ── 產線 handler 模式(engine/line.py):事件驅動 ──
        # 被授予搬運(line_carry)才跑一次取放循環;沒料時停在取件點上方待命
        # (待命 = 相位 0 = keyframe「上方(pick)」)。cycle_count 因此等於實際搬運次數,
        # 產線帳本就用它記「工件何時落到下游」。
        if device.line_enabled and device.line_role == "handler":
            quota = int(device.line_carry)          # 在手件數(engine/line.py 依配額授予)
            if quota > 0:
                st["waiting"] = False
                st["t"] += dt_sim
                # 大 dt(高倍速場景)一拍可跑完多個循環:預算 = 殘餘相位 + dt/週期,
                # 完成數以在手件數為上限 —— cycle_count 恆等於實際放下的件數。
                budget = st["ph"] + dt_sim / CYCLE_PERIOD
                done = min(quota, int(budget))
                st["cycles"] += done
                st["ph"] = 0.0 if done >= quota else min(0.999, budget - done)
                _pose_at(st["ph"])
            else:
                st["waiting"] = True
                st["ph"] = 0.0
                _pose_at(0.0)                       # 取件點上方待命
            return

        # ── 自由循環模式(非產線場景,行為與先前相同)──
        st["waiting"] = False
        st["t"] += dt_sim
        st["cycles"] += dt_sim / CYCLE_PERIOD
        ph = ((st["t"] / CYCLE_PERIOD) + (phase0 / (2 * math.pi))) % 1.0
        _pose_at(ph)

    def state_fn(op, comps):
        if not st["running"]:
            return "idle"
        # 產線待命(無料可搬)→ idle:柱燈黃、機構停 —— 學生看得出「手臂在等料」
        return "idle" if st["waiting"] else "running"

    def mk_angle(i):
        # encoder_drift 注入時,第 i 軸角度讀值會被感測器層額外汙染(此處給乾淨值)
        return lambda op, c, dt: st["angles"][i] + gaussian_noise(nrng, 0.15)

    def mk_current(i):
        def drv(op, c, dt):
            if not st["running"] or st["waiting"]:   # 停機或產線待命:只剩保持電流
                return 0.3 + gaussian_noise(nrng, 0.03)
            h_red = health_of(comp_map, "reducer_wear")
            h_brg = health_of(comp_map, "joint_bearing")
            base = 1.5 + 0.02 * op["load"] + 0.6 * abs(math.sin(st["t"] + i))
            friction = 2.0 * (1.0 - h_red) + 1.0 * (1.0 - h_brg)
            return base + friction + gaussian_noise(nrng, 0.06)
        return drv

    def mk_temp(i):
        def drv(op, c, dt):
            h_red = health_of(comp_map, "reducer_wear")
            load_heat = 12.0 if (st["running"] and not st["waiting"]) else 0.0
            return AMBIENT_C + load_heat + 14.0 * (1.0 - h_red) + i * 0.6 + gaussian_noise(nrng, 0.25)
        return drv

    def drv_vibration(op, c, dt):
        h_red = health_of(comp_map, "reducer_wear")
        base = 0.8 if (st["running"] and not st["waiting"]) else 0.1
        return max(0.0, base + 11.0 * (1.0 - h_red) ** 1.8 + gaussian_noise(nrng, 0.05))

    for i in range(6):
        tag_by_name[f"joint_angle_{i+1}"].driver = mk_angle(i)
        tag_by_name[f"joint_current_{i+1}"].driver = mk_current(i)
        tag_by_name[f"joint_temp_{i+1}"].driver = mk_temp(i)
    tag_by_name["tcp_x"].driver = lambda op, c, dt: st["tcp"][0]
    tag_by_name["tcp_y"].driver = lambda op, c, dt: st["tcp"][1]
    tag_by_name["tcp_z"].driver = lambda op, c, dt: st["tcp"][2]
    tag_by_name["vibration_rms"].driver = drv_vibration
    tag_by_name["cycle_count"].driver = lambda op, c, dt: int(st["cycles"])

    def oee_fn(op, comps):
        h_r = health_of(comp_map, "reducer_wear")
        return 0.8 + 0.2 * h_r, max(0.6, 1.0 - (1.0 - h_r) * 0.4)  # 減速機退化降表現與良率

    # 學生可寫取放點(mm,受控範圍)。負值走 int16 二補數(Modbus 轉接層已處理)。
    setpoints = [
        SetPoint(name="pick_x", register=100, unit="mm", min=-_R_MAX, max=_R_MAX,
                 default=_DEFAULT_PICK[0], scale=1.0),
        SetPoint(name="pick_y", register=101, unit="mm", min=-_R_MAX, max=_R_MAX,
                 default=_DEFAULT_PICK[1], scale=1.0),
        SetPoint(name="place_x", register=102, unit="mm", min=-_R_MAX, max=_R_MAX,
                 default=_DEFAULT_PLACE[0], scale=1.0),
        SetPoint(name="place_y", register=103, unit="mm", min=-_R_MAX, max=_R_MAX,
                 default=_DEFAULT_PLACE[1], scale=1.0),
    ]
    device = Device(
        device_id=device_id, template="robot_arm_6axis", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        state_fn=state_fn, pre_step_fn=pre_step, oee_fn=oee_fn, setpoints=setpoints,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
