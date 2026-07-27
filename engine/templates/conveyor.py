"""輸送帶 template。"""
from __future__ import annotations

import math
from typing import Optional
import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

_TAG_SPEC = (
    ("state", "code", "uint16"),
    ("belt_speed", "m/s", "float"),
    ("motor_current", "A", "float"),
    ("vibration_rms", "mm/s", "float"),
)

_INDICATORS = {"bearing_wear", "tension_loss"}
_DEFAULT_DEGRADATION = {
    "bearing_wear": {"rate": 0.0000010, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.95},
    "tension_loss": {"rate": 0.0000016, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
}

def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty = DutyProfile(profile=cfg.get("duty_cycle", {}).get("profile", "continuous"),
                       load_nom=cfg.get("duty_cycle", {}).get("load_nom", 80.0))
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

    def pre_step(dt_sim, op):
        pass

    def drv_belt_speed(op, comps, dt):
        if not op["running"]:
            return 0.0
        return 1.0 + float(gaussian_noise(nrng, 0.01))

    def drv_motor_current(op, comps, dt):
        if not op["running"]:
            return 0.0
        hlth = health_of(comp_map, "bearing_wear")
        return 5.0 + (1.0 - hlth) * 2.0 + float(gaussian_noise(nrng, 0.2))

    def drv_vibration(op, comps, dt):
        if not op["running"]:
            return 0.0
        hlth = health_of(comp_map, "bearing_wear")
        return 0.5 + (1.0 - hlth) * 1.5 + float(gaussian_noise(nrng, 0.05))

    tag_by_name["belt_speed"].driver = drv_belt_speed
    tag_by_name["motor_current"].driver = drv_motor_current
    tag_by_name["vibration_rms"].driver = drv_vibration

    device = Device(
        device_id=device_id, template="conveyor", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
