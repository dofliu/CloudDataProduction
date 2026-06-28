"""塑膠射出成型機 template(台中招牌產品:台中精機 Vα 系列、Multiplas 等)。

製程設備,訊號細緻:鎖模力、射出壓、多段料管溫、螺桿轉速、循環時間、累積模數。
headline:hydraulic_pump / servo 退化推升振動與油溫;screw_wear 拉長循環、降良率。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags

AMBIENT_C = 25.0
CYCLE_S = 30.0   # 一模循環秒數

_TAG_SPEC = (
    [("state", "enum", "int16"),
     ("clamping_force", "ton", "float32"),
     ("injection_pressure", "bar", "float32"),
     ("screw_speed", "rpm", "float32")]
    + [(f"barrel_temp_{i}", "degC", "float32") for i in range(1, 5)]
    + [("oil_temp", "degC", "float32"),
       ("cycle_time", "s", "float32"),
       ("vibration_rms", "mm/s", "float32"),
       ("shot_count", "count", "int32")]
)
_INDICATORS = {"screw_wear", "heater_drift"}
_DEFAULT_DEGRADATION = {
    "hydraulic_pump": {"rate": 0.0000010, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
    "screw_wear": {"rate": 0.0000016, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    "heater_drift": {"rate": 0.0000010, "trajectory": "linear", "sigma": 0.1, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty = DutyProfile(profile=cfg.get("duty_cycle", {}).get("profile", "continuous"),
                       load_nom=cfg.get("duty_cycle", {}).get("load_nom", 80.0))
    rated = float(cfg.get("clamping_force_ton", 130))
    seed = cfg.get("seed", abs(hash(device_id)) % (2**31))
    rng = np.random.default_rng(seed)
    components = build_components(cfg, _INDICATORS, rng, defaults=_DEFAULT_DEGRADATION)
    comp_map = {c.name: c for c in components}

    protocols = cfg.get("protocols", {}) or {}
    opcua_folder = (protocols.get("opcua", {}) or {}).get("node_folder", f"{company_id}/{device_id}")
    modbus_base = (protocols.get("modbus", {}) or {}).get("register_base", 0)
    tags = build_tags(_TAG_SPEC, modbus_base, opcua_folder)
    tag_by_name = {t.name: t for t in tags}
    nrng = np.random.default_rng(int(rng.integers(0, 2**31)))
    oil_lag = ThermalLag(tau_sim_s=2400.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "shots": 0.0, "ph": 0.0}

    def _cycle(h_screw): return CYCLE_S + (1.0 - h_screw) * 9.0

    def pre_step(dt_sim, op):
        if op["running"] and not device._fault_latched:
            st["t"] += dt_sim
            st["shots"] += dt_sim / _cycle(health_of(comp_map, "screw_wear"))
        st["ph"] = (st["t"] % CYCLE_S) / CYCLE_S * 2 * math.pi   # 模內相位

    def drv_clamp(op, c, dt):
        return (rated * (0.9 + 0.1 * abs(math.sin(st["ph"]))) if op["running"] else 0.0) + gaussian_noise(nrng, 0.5)
    def drv_inj(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 1.0)
        return 90.0 + 70.0 * max(0.0, math.sin(st["ph"])) + gaussian_noise(nrng, 1.5)   # 射出段壓力高
    def drv_screw(op, c, dt):
        return (120.0 + 40.0 * abs(math.cos(st["ph"]))) + gaussian_noise(nrng, 1.0) if op["running"] else 0.0
    def mk_barrel(i):
        target = [225, 235, 240, 230][i]
        def drv(op, c, dt):
            # heater_drift 注入時由感測器層另外汙染;此給乾淨值
            return target + 2.0 * math.sin(st["t"] / 200.0 + i) + gaussian_noise(nrng, 0.4)
        return drv
    def drv_oil(op, c, dt):
        h = health_of(comp_map, "hydraulic_pump")
        load = 35.0 if op["running"] else 0.0
        return oil_lag.update(AMBIENT_C + load + 18.0 * (1.0 - h), dt) + gaussian_noise(nrng, 0.3)
    def drv_cycle(op, c, dt):
        return _cycle(health_of(comp_map, "screw_wear")) + gaussian_noise(nrng, 0.2)
    def drv_vib(op, c, dt):
        h = health_of(comp_map, "hydraulic_pump")
        base = 1.0 if op["running"] else 0.12
        return max(0.0, base + 10.0 * (1.0 - h) ** 1.8 + gaussian_noise(nrng, 0.05))
    def drv_shots(op, c, dt): return int(st["shots"])

    tag_by_name["clamping_force"].driver = drv_clamp
    tag_by_name["injection_pressure"].driver = drv_inj
    tag_by_name["screw_speed"].driver = drv_screw
    for i in range(4):
        tag_by_name[f"barrel_temp_{i+1}"].driver = mk_barrel(i)
    tag_by_name["oil_temp"].driver = drv_oil
    tag_by_name["cycle_time"].driver = drv_cycle
    tag_by_name["vibration_rms"].driver = drv_vib
    tag_by_name["shot_count"].driver = drv_shots

    def oee_fn(op, comps):
        h = health_of(comp_map, "screw_wear")
        return CYCLE_S / _cycle(h), max(0.5, 1.0 - (1.0 - h) * 0.45)

    device = Device(
        device_id=device_id, template="injection_molding", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
