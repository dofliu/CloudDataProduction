"""6 軸機械手臂 template(docs/03,離散製造)。

headline:諧波減速機(reducer_wear)退化 → 振動上升、各軸電流/溫度跟漲。
encoder_drift 是感測器型(只汙染某軸角度讀值)。pre_step 讓六軸做 pick-and-place 擺動,
tcp 末端位置跟著動 —— 供 2D 世界呈現手臂運轉。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import gaussian_noise, health_of
from ._common import build_components, build_tags

AMBIENT_C = 25.0
CYCLE_PERIOD = 8.0          # 一次取放循環的秒數(sim 秒)
# 各軸活動中心與擺幅(deg)
_JOINT_CENTER = [0.0, -30.0, 45.0, 0.0, 30.0, 0.0]
_JOINT_AMP = [60.0, 25.0, 35.0, 90.0, 40.0, 120.0]

_TAG_SPEC = (
    [("state", "enum", "int16")]
    + [(f"joint_angle_{i}", "deg", "float32") for i in range(1, 7)]
    + [(f"joint_current_{i}", "A", "float32") for i in range(1, 7)]
    + [(f"joint_temp_{i}", "degC", "float32") for i in range(1, 7)]
    + [("tcp_x", "mm", "float32"), ("tcp_y", "mm", "float32"), ("tcp_z", "mm", "float32")]
    + [("vibration_rms", "mm/s", "float32"), ("cycle_count", "count", "int32")]
)
_INDICATORS = {"encoder_drift", "joint_bearing"}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty = DutyProfile(profile=cfg.get("duty_cycle", {}).get("profile", "continuous"),
                       load_nom=cfg.get("duty_cycle", {}).get("load_nom", 65.0))

    seed = cfg.get("seed", abs(hash(device_id)) % (2**31))
    rng = np.random.default_rng(seed)
    components = build_components(cfg, _INDICATORS, rng)
    comp_map = {c.name: c for c in components}

    protocols = cfg.get("protocols", {}) or {}
    opcua_folder = (protocols.get("opcua", {}) or {}).get("node_folder", f"{company_id}/{device_id}")
    modbus_base = (protocols.get("modbus", {}) or {}).get("register_base", 0)
    tags = build_tags(_TAG_SPEC, modbus_base, opcua_folder)
    tag_by_name = {t.name: t for t in tags}
    nrng = np.random.default_rng(int(rng.integers(0, 2**31)))
    phase0 = float(rng.uniform(0, 2 * math.pi))   # 個體相位差

    st = {"t": 0.0, "cycles": 0.0, "angles": list(_JOINT_CENTER), "tcp": [400.0, 0.0, 600.0], "running": False}

    def pre_step(dt_sim, op):
        st["running"] = op["running"] and not device._fault_latched
        if not st["running"]:
            return
        st["t"] += dt_sim
        st["cycles"] += dt_sim / CYCLE_PERIOD
        ph = 2 * math.pi * st["t"] / CYCLE_PERIOD + phase0
        for i in range(6):
            st["angles"][i] = _JOINT_CENTER[i] + _JOINT_AMP[i] * math.sin(ph + i * 0.7)
        # 粗略末端位置(讓 tcp 跟著擺)
        st["tcp"][0] = 450.0 + 180.0 * math.cos(ph)
        st["tcp"][1] = 250.0 * math.sin(ph)
        st["tcp"][2] = 600.0 + 120.0 * math.sin(ph * 2)

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

    device = Device(
        device_id=device_id, template="robot_arm_6axis", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        state_fn=state_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
