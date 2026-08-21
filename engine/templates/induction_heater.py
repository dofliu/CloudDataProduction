"""感應加熱爐 template(鍛造廠的第一站:棒料加熱到鍛造溫度)。

手工具鍛造的入口:棒料連續穿過感應線圈,出料端要達到 1180 °C 左右才鍛得動。
與熱處理爐 / 熔煉爐的差別是它**沒有大熱慣性**——工件是流過去的,加熱是即時的,
所以「加熱不足」立刻反映在出料溫度上,不像爐子有幾十分鐘的遲滯。三條退化線:

  · coil_insulation(本體,exponential)→ 線圈絕緣劣化:漏電流升、功率因數掉,
    最後絕緣失效 → 設備 fault。
  · cooling_scale(指標,linear)→ 冷卻水路結垢 → 線圈溫升 → 必須降額運轉(產能題)。
  · coupling_drift(指標,linear)→ 線圈與工件耦合變差 → 加熱不均 → 出料溫度分散變大
    (品質題:溫度不足的棒料鍛出來會有摺疊 / 裂紋)。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 30.0
TARGET_C = 1180.0        # 鍛造溫度目標
BILLET_S = 22.0          # 一支棒料通過線圈的 sim 秒數
TEMP_TOL_C = 55.0        # 出料溫度容差:低於 TARGET - TOL 就鍛不出好件

_TAG_SPEC = [
    ("state",            "enum",   "int16"),
    ("billet_temp_out",  "degC",   "float32"),   # ★ 出料溫度(耦合劣化 → 偏低且分散)
    ("coil_temp",        "degC",   "float32"),   # ★ 線圈溫度(冷卻結垢 → 升)
    ("coil_current",     "A",      "float32"),
    ("output_power",     "kW",     "float32"),
    ("frequency",        "kHz",    "float32"),
    ("power_factor",     "-",      "float32"),   # ★ coil_insulation → 功因掉
    ("leakage_current",  "mA",     "float32"),   # ★ coil_insulation 主指標(漏電流升)
    ("cooling_flow",     "L/min",  "float32"),
    ("billet_count",     "count",  "int32"),
    ("energy_kwh",       "kWh",    "int32"),
]
_INDICATORS = {"cooling_scale", "coupling_drift"}
_DEFAULT_DEGRADATION = {
    "coil_insulation": {"rate": 0.0000010, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.94},
    "cooling_scale": {"rate": 0.0000014, "trajectory": "linear", "sigma": 0.13, "init_health": 1.0, "causes_device_fault": False},
    "coupling_drift": {"rate": 0.0000013, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 90.0))

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
    coil_lag = ThermalLag(tau_sim_s=420.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "ph": 0.0, "billets": 0.0, "energy": 0.0}

    def _derate() -> float:
        """冷卻水路結垢 → 線圈散熱不良 → 只能降額運轉(輸出功率打折)。"""
        return 0.62 + 0.38 * health_of(comp_map, "cooling_scale")

    def _cycle() -> float:
        return BILLET_S / max(0.4, _derate())       # 降額 → 每支棒料待得更久

    def _power(op) -> float:
        return 260.0 * _derate() if op["running"] else 6.0

    def pre_step(dt_sim, op):
        if op["running"] and not device._fault_latched and dt_sim > 0.0:
            st["t"] += dt_sim
            st["billets"] += dt_sim / _cycle()
            st["energy"] += _power(op) * dt_sim / 3600.0
        st["ph"] = (st["t"] % _cycle()) / _cycle()

    def _temp_out(comps) -> float:
        h_couple = health_of(comp_map, "coupling_drift")
        # 耦合變差 → 同樣功率下棒料吃到的能量少 → 出料溫度往下掉
        return TARGET_C - 95.0 * (1.0 - h_couple) ** 1.25 - 40.0 * (1.0 - _derate())

    def drv_temp_out(op, c, dt):
        if not op["running"]:
            return AMBIENT_C + gaussian_noise(nrng, 1.0)
        h_couple = health_of(comp_map, "coupling_drift")
        # 耦合劣化不只讓均值下降,也讓**分散變大**(每支棒料吃到的能量不一樣)
        spread = 4.0 + 26.0 * (1.0 - h_couple)
        return _temp_out(c) + gaussian_noise(nrng, spread)

    def drv_coil_temp(op, c, dt):
        h_cool = health_of(comp_map, "cooling_scale")
        target = AMBIENT_C + (48.0 + 85.0 * (1.0 - h_cool) ** 1.4 if op["running"] else 4.0)
        return coil_lag.update(target, dt) + gaussian_noise(nrng, 0.8)

    def drv_coil_current(op, c, dt):
        return (1450.0 * _derate() if op["running"] else 0.0) + gaussian_noise(nrng, 8.0)

    def drv_power(op, c, dt):
        return _power(op) + gaussian_noise(nrng, 2.5)

    def drv_freq(op, c, dt):
        # 感應頻率隨負載微調(工件在 / 不在線圈內)
        base = 8.0 if op["running"] else 0.0
        return base + 0.25 * math.sin(st["ph"] * 2 * math.pi) + gaussian_noise(nrng, 0.02)

    def drv_pf(op, c, dt):
        h_ins = health_of(comp_map, "coil_insulation")
        return float(np.clip(0.96 - 0.22 * (1.0 - h_ins) ** 1.2 + gaussian_noise(nrng, 0.004),
                             0.5, 1.0)) if op["running"] else 0.0

    def drv_leakage(op, c, dt):
        h_ins = health_of(comp_map, "coil_insulation")
        base = 1.2 if op["running"] else 0.2
        return max(0.0, base + 46.0 * (1.0 - h_ins) ** 1.8 + gaussian_noise(nrng, 0.08))

    def drv_flow(op, c, dt):
        h_cool = health_of(comp_map, "cooling_scale")
        return max(0.0, (95.0 * (0.55 + 0.45 * h_cool) if op["running"] else 8.0)
                   + gaussian_noise(nrng, 0.5))

    def drv_billets(op, c, dt):
        return int(st["billets"])

    def drv_energy(op, c, dt):
        return int(st["energy"])

    tag_by_name["billet_temp_out"].driver = drv_temp_out
    tag_by_name["coil_temp"].driver = drv_coil_temp
    tag_by_name["coil_current"].driver = drv_coil_current
    tag_by_name["output_power"].driver = drv_power
    tag_by_name["frequency"].driver = drv_freq
    tag_by_name["power_factor"].driver = drv_pf
    tag_by_name["leakage_current"].driver = drv_leakage
    tag_by_name["cooling_flow"].driver = drv_flow
    tag_by_name["billet_count"].driver = drv_billets
    tag_by_name["energy_kwh"].driver = drv_energy

    def oee_fn(op, comps):
        perf = _derate()
        deficit = max(0.0, TARGET_C - _temp_out(comps))
        return perf, float(np.clip(1.0 - deficit / (TEMP_TOL_C * 3.2), 0.5, 1.0))

    def quality_fn(op, comps, tag_by):
        """出料溫度不足的棒料鍛不出好件(摺疊 / 裂紋)。用溫度**缺口對容差**的比例當機率,
        跟 billet_temp_out 同一條式子重算 —— 學生看溫度就能預測不良率。"""
        if not op["running"]:
            return 0.0, "underheated_billet"
        deficit = max(0.0, TARGET_C - TEMP_TOL_C - _temp_out(comps))
        p = min(0.92, deficit / (TEMP_TOL_C * 1.6))
        return max(0.004, p), "underheated_billet"

    device = Device(
        device_id=device_id, template="induction_heater", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
