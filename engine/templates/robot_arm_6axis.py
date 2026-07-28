"""6 軸機械手臂 template(docs/03,離散製造)。

headline:諧波減速機(reducer_wear)退化 → 振動上升、各軸電流/溫度跟漲。
encoder_drift 是感測器型(只汙染某軸角度讀值)。pre_step 讓六軸做 pick-and-place 擺動,
tcp_x/y/z 由 forward_kinematics() 從同一組角度算出 —— 學生從 Modbus 讀六軸角度自己算
正運動學,答案必須與 tcp 對得起來。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
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
          "tcp": list(forward_kinematics(_JOINT_CENTER)), "running": False}

    _KEYFRAMES = [
        [-45.0, -20.0, 30.0, 0.0, 80.0, 0.0],  # 0: Above Pick (Left)
        [-45.0,  15.0, 50.0, 0.0, 25.0, 0.0],  # 1: Pick (Down)
        [-45.0, -20.0, 30.0, 0.0, 80.0, 0.0],  # 2: Above Pick
        [ 45.0, -20.0, 30.0, 0.0, 80.0, 0.0],  # 3: Above Place (Right)
        [ 45.0,  15.0, 50.0, 0.0, 25.0, 0.0],  # 4: Place (Down)
        [ 45.0, -20.0, 30.0, 0.0, 80.0, 0.0],  # 5: Above Place
    ]

    def pre_step(dt_sim, op):
        st["running"] = op["running"] and not device._fault_latched
        if not st["running"]:
            return
        st["t"] += dt_sim
        st["cycles"] += dt_sim / CYCLE_PERIOD
        
        ph = ((st["t"] / CYCLE_PERIOD) + (phase0 / (2 * math.pi))) % 1.0
        idx = int(ph * 6)
        t_interp = (ph * 6) - idx
        t_interp = t_interp * t_interp * (3 - 2 * t_interp) # Smoothstep
        
        k1 = _KEYFRAMES[idx % 6]
        k2 = _KEYFRAMES[(idx + 1) % 6]
        for i in range(6):
            st["angles"][i] = k1[i] + (k2[i] - k1[i]) * t_interp

        # 末端位置由同一組角度算出來 —— 不是另外編一條擺動曲線
        st["tcp"][0], st["tcp"][1], st["tcp"][2] = forward_kinematics(st["angles"])

    def state_fn(op, comps):
        return "running" if st["running"] else "idle"

    def mk_angle(i):
        # encoder_drift 注入時,第 i 軸角度讀值會被感測器層額外汙染(此處給乾淨值)
        return lambda op, c, dt: st["angles"][i] + gaussian_noise(nrng, 0.15)

    def mk_current(i):
        def drv(op, c, dt):
            if not st["running"]:
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
            load_heat = 12.0 if st["running"] else 0.0
            return AMBIENT_C + load_heat + 14.0 * (1.0 - h_red) + i * 0.6 + gaussian_noise(nrng, 0.25)
        return drv

    def drv_vibration(op, c, dt):
        h_red = health_of(comp_map, "reducer_wear")
        base = 0.8 if st["running"] else 0.1
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

    device = Device(
        device_id=device_id, template="robot_arm_6axis", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        state_fn=state_fn, pre_step_fn=pre_step, oee_fn=oee_fn,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
