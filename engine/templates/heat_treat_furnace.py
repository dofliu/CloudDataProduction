"""熱處理爐 template(docs/03,製程 / 廠務熱設備)。

金屬熱處理(退火 / 淬火 / 滲碳)常見設備,連續運轉、熱慣性大。三條故障線:
  · heating_element_aging(本體,exponential)→ 加熱元件電流升、供熱不足,最後燒斷 → 設備 fault。
  · insulation_degradation(指標,linear)→ 爐體保溫劣化 → 爐溫均勻性變差 + 能耗升(良率 / 能耗題)。
  · seal_leak(指標)→ 爐門密封洩漏 → 殘氧 oxygen_ppm 上升(保護氣氛失效 → 良率掉)。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 30.0
SETPOINT_C = 900.0      # 製程爐溫設定點
NOM_FLOW = 40.0         # 保護氣氛流量(L/min)

_TAG_SPEC = [
    ("state",            "enum",   "int16"),
    ("furnace_temp",     "degC",   "float32"),   # 爐溫(元件老化 → 供熱不足會偏離設定點)
    ("temp_uniformity",  "degC",   "float32"),    # ★ 爐內溫差(insulation 劣化 → 變大,良率指標)
    ("chamber_pressure", "mbar",   "float32"),
    ("heating_power",    "kW",     "float32"),
    ("element_current",  "A",      "float32"),    # ★ heating_element_aging 退化主指標(升高)
    ("atmosphere_flow",  "L/min",  "float32"),
    ("oxygen_ppm",       "ppm",    "float32"),     # ★ seal_leak → 殘氧上升(良率指標)
    ("energy_kwh",       "kWh",    "int32"),       # 累積能耗
]
_INDICATORS = {"insulation_degradation", "seal_leak"}
_DEFAULT_DEGRADATION = {
    "heating_element_aging": {"rate": 0.0000009, "trajectory": "exponential", "k": 2.6, "sigma": 0.1, "init_health": 0.94},
    "insulation_degradation": {"rate": 0.0000013, "trajectory": "linear", "sigma": 0.12, "init_health": 1.0, "causes_device_fault": False},
    "seal_leak": {"rate": 0.0000011, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "continuous"),
                       load_nom=duty_cfg.get("load_nom", 100.0))

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
    # 爐溫熱慣性很大(τ 長);元件老化 → 能達到的溫度略降
    furnace_lag = ThermalLag(tau_sim_s=6000.0, init_temp=AMBIENT_C)
    st = {"energy": 0.0}

    def pre_step(dt_sim, op):
        if dt_sim > 0.0 and op["running"]:
            st["energy"] += drv_power_val(op) * dt_sim / 3600.0   # kWh(對 sim 時間)

    def drv_power_val(op):
        if not op["running"]:
            return 5.0
        h_elem = health_of(comp_map, "heating_element_aging")
        h_ins = health_of(comp_map, "insulation_degradation")
        # 保溫劣化 → 需更多功率維持爐溫;元件老化 → 效率降(同功率產熱少)
        return 60.0 + 25.0 * (1.0 - h_ins) + 8.0 * (1.0 - h_elem)

    def drv_furnace_temp(op, c, dt):
        h_elem = health_of(comp_map, "heating_element_aging")
        target = (SETPOINT_C - 60.0 * (1.0 - h_elem)) if op["running"] else AMBIENT_C  # 元件弱 → 到不了設定點
        return furnace_lag.update(target, dt) + gaussian_noise(nrng, 1.5)

    def drv_uniformity(op, c, dt):
        h_ins = health_of(comp_map, "insulation_degradation")
        base = 4.0 if op["running"] else 1.0
        return max(0.0, base + 35.0 * (1.0 - h_ins) ** 1.3 + gaussian_noise(nrng, 0.4))

    def drv_pressure(op, c, dt):
        return (1013.0 + 6.0 if op["running"] else 1013.0) + gaussian_noise(nrng, 0.5)

    def drv_power(op, c, dt):
        return drv_power_val(op) + gaussian_noise(nrng, 0.6)

    def drv_element_current(op, c, dt):
        h_elem = health_of(comp_map, "heating_element_aging")
        base = 120.0 if op["running"] else 8.0
        return base + 40.0 * (1.0 - h_elem) ** 1.5 + gaussian_noise(nrng, 0.5)   # 元件老化 → 電流升(電阻升)

    def drv_flow(op, c, dt):
        return (NOM_FLOW if op["running"] else 2.0) + gaussian_noise(nrng, 0.3)

    def drv_oxygen(op, c, dt):
        h_seal = health_of(comp_map, "seal_leak")
        base = 8.0 if op["running"] else 30.0
        return max(0.0, base + 220.0 * (1.0 - h_seal) ** 1.4 + gaussian_noise(nrng, 1.0))

    def drv_energy(op, c, dt):
        return int(st["energy"])

    tag_by_name["furnace_temp"].driver = drv_furnace_temp
    tag_by_name["temp_uniformity"].driver = drv_uniformity
    tag_by_name["chamber_pressure"].driver = drv_pressure
    tag_by_name["heating_power"].driver = drv_power
    tag_by_name["element_current"].driver = drv_element_current
    tag_by_name["atmosphere_flow"].driver = drv_flow
    tag_by_name["oxygen_ppm"].driver = drv_oxygen
    tag_by_name["energy_kwh"].driver = drv_energy

    def oee_fn(op, comps):
        h_elem = health_of(comps, "heating_element_aging")
        # 表現:元件弱 → 升溫慢、產能降;良率:溫度均勻性差或殘氧高 → 熱處理品質掉
        perf = 0.8 + 0.2 * h_elem
        uni = 4.0 + 35.0 * (1.0 - health_of(comps, "insulation_degradation"))
        q_uni = np.clip(1.0 - (uni - 4.0) / 60.0, 0.5, 1.0)
        q_o2 = max(0.6, health_of(comps, "seal_leak"))
        return perf, float(min(q_uni, q_o2))

    device = Device(
        device_id=device_id, template="heat_treat_furnace", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
