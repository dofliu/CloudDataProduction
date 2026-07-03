"""沖壓機 template(docs/03,離散製造,高噸位循環)。

台中鈑金 / 沖壓聚落常見設備。兩條故障線教學意義不同:
  · clutch_brake_wear(本體,exponential)→ 振動升、噸位波動,最後離合器/煞車失效 → 設備 fault(經典 PdM)。
  · die_wear(指標,linear)→ 毛邊率 burr_rate 上升 → 良率掉,**設備不會 fault**(subtle,品質題)。
  · lube_pump_wear(指標)→ 潤滑壓力下滑(潤滑泵退化),是另一條獨立徵兆。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 25.0
NOM_TONNAGE = 200.0     # 額定噸位
NOM_SPM = 60.0          # 每分鐘行程數(strokes per minute)
STROKE_S = 1.0          # 一個行程秒數(60 spm → 1 秒)

_TAG_SPEC = [
    ("state",               "enum",  "int16"),
    ("tonnage",             "ton",   "float32"),   # 沖壓噸位(clutch 退化 → 波動)
    ("stroke_rate",         "spm",   "float32"),
    ("ram_position",        "mm",    "float32"),    # 滑塊位置(循環 0~120)
    ("die_temp",            "degC",  "float32"),
    ("motor_current",       "A",     "float32"),
    ("vibration_rms",       "mm/s",  "float32"),    # ★ clutch_brake_wear 退化主指標
    ("lubrication_pressure","bar",   "float32"),    # lube_pump_wear → 下滑
    ("burr_rate",           "%",     "float32"),    # ★ die_wear → 毛邊率上升(良率指標)
    ("stroke_count",        "count", "int32"),
]
_INDICATORS = {"die_wear", "lube_pump_wear"}
_DEFAULT_DEGRADATION = {
    "clutch_brake_wear": {"rate": 0.0000011, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
    "die_wear": {"rate": 0.0000016, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    "lube_pump_wear": {"rate": 0.0000010, "trajectory": "linear", "sigma": 0.12, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 85.0))

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
    die_lag = ThermalLag(tau_sim_s=1800.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "strokes": 0.0, "ph": 0.0}

    def pre_step(dt_sim, op):
        if op["running"] and not device._fault_latched:
            st["t"] += dt_sim
            st["strokes"] += dt_sim / STROKE_S * (op["load"] / max(1e-6, op["load_nom"]))
        st["ph"] = (st["t"] % STROKE_S) / STROKE_S * 2 * math.pi   # 行程相位

    def drv_tonnage(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.3)
        h = health_of(comp_map, "clutch_brake_wear")
        wobble = 12.0 * (1.0 - h) * math.sin(st["ph"] * 2)   # 離合器退化 → 噸位波動變大
        return NOM_TONNAGE * (0.9 + 0.1 * abs(math.sin(st["ph"]))) + wobble + gaussian_noise(nrng, 1.0)

    def drv_stroke_rate(op, c, dt):
        return (NOM_SPM * (op["load"] / max(1e-6, op["load_nom"])) if op["running"] else 0.0) + gaussian_noise(nrng, 0.3)

    def drv_ram(op, c, dt):
        return 60.0 - 60.0 * math.cos(st["ph"]) if op["running"] else 0.0   # 0~120mm

    def drv_die_temp(op, c, dt):
        load = 40.0 if op["running"] else 0.0
        h = health_of(comp_map, "clutch_brake_wear")
        return die_lag.update(AMBIENT_C + load + 12.0 * (1.0 - h), dt) + gaussian_noise(nrng, 0.3)

    def drv_motor_current(op, c, dt):
        if not op["running"]:
            return 3.0 + gaussian_noise(nrng, 0.05)
        h = health_of(comp_map, "clutch_brake_wear")
        return 30.0 + 0.15 * op["load"] + 12.0 * (1.0 - h) ** 1.5 + gaussian_noise(nrng, 0.15)

    def drv_vibration(op, c, dt):
        h = health_of(comp_map, "clutch_brake_wear")
        base = 1.4 if op["running"] else 0.15
        return max(0.0, base + 11.0 * (1.0 - h) ** 1.7 + gaussian_noise(nrng, 0.06))

    def drv_lube(op, c, dt):
        h = health_of(comp_map, "lube_pump_wear")
        base = 3.0 if op["running"] else 1.2
        return max(0.0, base * (0.5 + 0.5 * h) + gaussian_noise(nrng, 0.03))

    def drv_burr(op, c, dt):
        h = health_of(comp_map, "die_wear")
        return max(0.0, 0.5 + 14.0 * (1.0 - h) ** 1.3 + gaussian_noise(nrng, 0.05))

    def drv_strokes(op, c, dt):
        return int(st["strokes"])

    tag_by_name["tonnage"].driver = drv_tonnage
    tag_by_name["stroke_rate"].driver = drv_stroke_rate
    tag_by_name["ram_position"].driver = drv_ram
    tag_by_name["die_temp"].driver = drv_die_temp
    tag_by_name["motor_current"].driver = drv_motor_current
    tag_by_name["vibration_rms"].driver = drv_vibration
    tag_by_name["lubrication_pressure"].driver = drv_lube
    tag_by_name["burr_rate"].driver = drv_burr
    tag_by_name["stroke_count"].driver = drv_strokes

    def oee_fn(op, comps):
        perf = 0.8 + 0.2 * health_of(comps, "clutch_brake_wear")           # 離合器退化 → 節拍不穩
        qual = max(0.5, 1.0 - (1.0 - health_of(comps, "die_wear")) * 0.5)  # 模具磨耗 → 毛邊 → 良率掉
        return perf, qual

    device = Device(
        device_id=device_id, template="stamping_press", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
