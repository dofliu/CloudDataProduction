"""風力發電機 template(額外加碼;雖然風場不會在工業區內,但教學假設有)。

含真實風能特性:風速隨機起伏、功率曲線(cut-in/rated/cut-out)、轉子轉速、
gearbox / generator 退化推升振動與溫度。對風能 SCADA 教學特別合適。
pre_step 整合風速與功率,各 tag 共讀。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags

AMBIENT_C = 18.0
RATED_KW = 2000.0
CUT_IN, RATED_WS, CUT_OUT = 3.0, 12.0, 25.0   # m/s

_TAG_SPEC = [
    ("state",          "enum",  "int16"),
    ("wind_speed",     "m/s",   "float32"),
    ("rotor_rpm",      "rpm",   "float32"),
    ("power_output",   "kW",    "float32"),
    ("pitch_angle",    "deg",   "float32"),
    ("generator_temp", "degC",  "float32"),
    ("gearbox_temp",   "degC",  "float32"),
    ("nacelle_temp",   "degC",  "float32"),
    ("vibration_rms",  "mm/s",  "float32"),   # ★ gearbox 退化主指標
    ("total_energy",   "kWh",   "float32"),
]
_INDICATORS = {"blade_erosion", "generator_bearing"}
_DEFAULT_DEGRADATION = {
    "gearbox_wear": {"rate": 0.0000010, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
    "generator_bearing": {"rate": 0.0000008, "trajectory": "exponential", "k": 2.5, "sigma": 0.12, "init_health": 0.95, "causes_device_fault": False},
    "blade_erosion": {"rate": 0.0000012, "trajectory": "linear", "sigma": 0.1, "init_health": 1.0, "causes_device_fault": False},
}


def _power_curve(ws: float) -> float:
    """功率曲線:cut-in 以下 0、額定以上飽和、cut-out 以上停機。回傳 0..1。"""
    if ws < CUT_IN or ws > CUT_OUT:
        return 0.0
    if ws >= RATED_WS:
        return 1.0
    return ((ws - CUT_IN) / (RATED_WS - CUT_IN)) ** 3      # 約略三次方


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty = DutyProfile(profile="continuous", load_nom=100.0)
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

    gen_lag = ThermalLag(tau_sim_s=1800.0, init_temp=AMBIENT_C)
    gbx_lag = ThermalLag(tau_sim_s=2400.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "ws": 9.0, "energy": 0.0, "pf": 0.0, "ph": float(rng.uniform(0, 6.28))}

    def pre_step(dt_sim, op):
        st["t"] += dt_sim
        # 風速是「環境」量測,風一直吹(感測器照讀),與停機/故障無關
        gust = 2.5 * math.sin(st["t"] / 600.0 + st["ph"]) + 1.2 * math.sin(st["t"] / 130.0)
        st["ws"] = float(np.clip(8.5 + gust + gaussian_noise(nrng, 0.4), 0.0, 28.0))
        # 但「發電」要看機組是否運轉:停機(run_enable=0 → op.running=False)或故障 → 變槳停轉,pf=0。
        # 否則 rotor_rpm / power 不會歸零,資料與命令脫鉤(學生模型會被誤導)。
        generating = op["running"] and not device._fault_latched
        st["pf"] = _power_curve(st["ws"]) if generating else 0.0
        if st["pf"] > 0:
            st["energy"] += RATED_KW * st["pf"] * dt_sim / 3600.0  # kWh

    def state_fn(op, comps):
        if not op["running"]:           # 教師停機 → 機組停轉(idle),即使有風
            return "idle"
        return "running" if st["pf"] > 0.02 else "idle"

    def drv_ws(op, c, dt): return st["ws"]
    def drv_power(op, c, dt):
        if device._fault_latched:
            return 0.0
        return RATED_KW * st["pf"] + gaussian_noise(nrng, 8.0)
    def drv_rpm(op, c, dt):
        return (6.0 + 9.0 * st["pf"]) + gaussian_noise(nrng, 0.2) if st["pf"] > 0 else gaussian_noise(nrng, 0.05)
    def drv_pitch(op, c, dt):
        if not op["running"]:           # 停機:葉片順槳停轉(~88°)
            return 88.0 + gaussian_noise(nrng, 0.3)
        # 額定以上靠變槳限制功率
        return max(0.0, (st["ws"] - RATED_WS) * 3.0) if st["ws"] > RATED_WS else gaussian_noise(nrng, 0.2)
    def drv_gen_temp(op, c, dt):
        h = health_of(comp_map, "generator_bearing")
        return gen_lag.update(AMBIENT_C + 45.0 * st["pf"] + 18.0 * (1.0 - h), dt) + gaussian_noise(nrng, 0.3)
    def drv_gbx_temp(op, c, dt):
        h = health_of(comp_map, "gearbox_wear")
        return gbx_lag.update(AMBIENT_C + 40.0 * st["pf"] + 22.0 * (1.0 - h), dt) + gaussian_noise(nrng, 0.3)
    def drv_nacelle(op, c, dt):
        return AMBIENT_C + 8.0 * st["pf"] + gaussian_noise(nrng, 0.5)
    def drv_vib(op, c, dt):
        h = health_of(comp_map, "gearbox_wear")
        base = 0.8 + 1.5 * st["pf"]
        return max(0.0, base + 11.0 * (1.0 - h) ** 1.8 + gaussian_noise(nrng, 0.06))
    def drv_energy(op, c, dt): return st["energy"]

    tag_by_name["wind_speed"].driver = drv_ws
    tag_by_name["power_output"].driver = drv_power
    tag_by_name["rotor_rpm"].driver = drv_rpm
    tag_by_name["pitch_angle"].driver = drv_pitch
    tag_by_name["generator_temp"].driver = drv_gen_temp
    tag_by_name["gearbox_temp"].driver = drv_gbx_temp
    tag_by_name["nacelle_temp"].driver = drv_nacelle
    tag_by_name["vibration_rms"].driver = drv_vib
    tag_by_name["total_energy"].driver = drv_energy

    def oee_fn(op, comps):
        h = health_of(comp_map, "gearbox_wear")
        return max(0.0, st["pf"]), max(0.6, 0.95 + 0.05 * h)   # 表現=容量因數;良率≈發電品質

    device = Device(
        device_id=device_id, template="wind_turbine", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        state_fn=state_fn, pre_step_fn=pre_step, oee_fn=oee_fn,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
