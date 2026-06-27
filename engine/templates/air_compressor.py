"""空壓機 template(docs/03,廠務動力)。

經典 PdM 目標,訊號乾淨好教。headline:motor_bearing 退化 → 振動上升;
filter_clog 推高電流(濾網阻塞 → 同樣出風要更費力),是另一條獨立線索。
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags

AMBIENT_C = 25.0
NOM_PRESSURE_BAR = 7.5
NOM_FLOW = 8.0   # m³/min

_TAG_SPEC = [
    ("state",           "enum",  "int16"),
    ("outlet_pressure", "bar",   "float32"),
    ("flow",            "m3/min", "float32"),
    ("motor_current",   "A",     "float32"),
    ("motor_temp",      "degC",  "float32"),
    ("vibration_rms",   "mm/s",  "float32"),   # ★ motor_bearing 退化主指標
    ("running_hours",   "h",     "float32"),
]
# 指標型元件(不直接判定設備故障)
_INDICATORS = {"valve_wear", "filter_clog"}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "continuous"),
                       load_nom=duty_cfg.get("load_nom", 80.0))

    seed = cfg.get("seed", abs(hash(device_id)) % (2**31))
    rng = np.random.default_rng(seed)
    components = build_components(cfg, _INDICATORS, rng)

    protocols = cfg.get("protocols", {}) or {}
    opcua_folder = (protocols.get("opcua", {}) or {}).get("node_folder", f"{company_id}/{device_id}")
    modbus_base = (protocols.get("modbus", {}) or {}).get("register_base", 0)
    tags = build_tags(_TAG_SPEC, modbus_base, opcua_folder)
    tag_by_name = {t.name: t for t in tags}

    motor_lag = ThermalLag(tau_sim_s=2400.0, init_temp=AMBIENT_C)
    hours_state = {"h": 0.0}
    nrng = np.random.default_rng(int(rng.integers(0, 2**31)))

    def drv_pressure(op, comps, dt):
        h_valve = health_of(comps, "valve_wear")
        if not op["running"]:                    # unloaded:壓力略降
            return NOM_PRESSURE_BAR - 0.6 + gaussian_noise(nrng, 0.03)
        droop = 0.4 * (1.0 - h_valve)            # 閥件磨耗 → 供壓略降
        return NOM_PRESSURE_BAR - droop + gaussian_noise(nrng, 0.05)

    def drv_flow(op, comps, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.02)
        h_filter = health_of(comps, "filter_clog")
        return NOM_FLOW * (0.85 + 0.15 * (op["load"] / max(1e-6, op["load_nom"]))) * (0.6 + 0.4 * h_filter) \
            + gaussian_noise(nrng, 0.05)

    def drv_motor_current(op, comps, dt):
        if not op["running"]:
            return 2.0 + gaussian_noise(nrng, 0.05)
        h_bearing = health_of(comps, "motor_bearing")
        h_filter = health_of(comps, "filter_clog")
        base = 18.0 + 0.08 * op["load"]
        clog = 6.0 * (1.0 - h_filter)            # 濾網阻塞 → 更費力 → 電流升
        friction = 3.0 * (1.0 - h_bearing)       # 軸承摩擦 → 電流升
        return base + clog + friction + gaussian_noise(nrng, 0.12)

    def drv_motor_temp(op, comps, dt):
        h_bearing = health_of(comps, "motor_bearing")
        load_heat = 0.4 * op["load"] if op["running"] else 0.0
        target = AMBIENT_C + load_heat + 18.0 * (1.0 - h_bearing)
        return motor_lag.update(target, dt) + gaussian_noise(nrng, 0.2)

    def drv_vibration(op, comps, dt):
        h_bearing = health_of(comps, "motor_bearing")
        base = 1.0 if op["running"] else 0.12
        return max(0.0, base + 10.0 * (1.0 - h_bearing) ** 1.8 + gaussian_noise(nrng, 0.05))

    def drv_running_hours(op, comps, dt):
        if op["running"] and dt > 0.0:
            hours_state["h"] += dt / 3600.0
        return hours_state["h"]

    tag_by_name["outlet_pressure"].driver = drv_pressure
    tag_by_name["flow"].driver = drv_flow
    tag_by_name["motor_current"].driver = drv_motor_current
    tag_by_name["motor_temp"].driver = drv_motor_temp
    tag_by_name["vibration_rms"].driver = drv_vibration
    tag_by_name["running_hours"].driver = drv_running_hours

    def oee_fn(op, comps):
        h_filter = health_of(comps, "filter_clog")
        perf = 0.65 + 0.35 * h_filter                     # 濾網阻塞 → 流量降 → 表現降
        qual = max(0.7, 1.0 - (1.0 - health_of(comps, "valve_wear")) * 0.3)
        return perf, qual

    device = Device(
        device_id=device_id, template="air_compressor", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn,
    )
    tag_by_name["state"].driver = lambda op, comps, dt: float(STATE_CODES.get(device.state, 0))
    return device
