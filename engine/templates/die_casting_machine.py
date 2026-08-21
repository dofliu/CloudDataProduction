"""壓鑄機 template(鑄造廠的成形站:熔湯 → 鑄件)。

與射出成型同為「注入 + 保壓 + 頂出」的循環,但材料是金屬熔湯,溫度尺度差一個量級,
而且**缺陷語彙不同**:射出看短射與重量,壓鑄看縮孔與氣孔。三條退化線:

  · hydraulic_accumulator(本體,exponential)→ 蓄壓器失壓:射出速度掉、增壓不足,
    最後壓不動 → 設備 fault。
  · die_thermal_fatigue(指標,linear)→ 模具熱疲勞龜裂 → 模溫分布走樣 → 縮孔率升(品質題)。
  · vacuum_seal_wear(指標,linear)→ 抽真空密封劣化 → 模穴殘氣 → 氣孔率升(品質題)。

兩條品質線刻意分開:縮孔跟**模溫**走、氣孔跟**真空度**走,學生要用兩支不同的製程訊號
分辨「該保養模具」還是「該修真空系統」——只看不良率是分不出來的。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 30.0
CYCLE_S = 65.0            # 一模壓鑄循環(sim 秒)
DIE_SETPOINT_C = 220.0    # 模具工作溫度
SHOT_SPEED_NOM = 4.2      # 射出速度(m/s,壓鑄的關鍵參數)
VACUUM_NOM_MBAR = 60.0    # 模穴真空度(越低越好)

_TAG_SPEC = [
    ("state",            "enum",   "int16"),
    ("clamping_force",   "ton",    "float32"),
    ("shot_speed",       "m/s",    "float32"),   # ★ hydraulic_accumulator 退化 → 掉速
    ("intensify_press",  "bar",    "float32"),   # 增壓壓力(補縮用)
    ("die_temp_fixed",   "degC",   "float32"),   # 固定模側模溫
    ("die_temp_moving",  "degC",   "float32"),   # 移動模側模溫(熱疲勞 → 兩側溫差變大)
    ("vacuum_level",     "mbar",   "float32"),   # ★ vacuum_seal_wear → 抽不下去
    ("cycle_time",       "s",      "float32"),
    ("shrinkage_rate",   "%",      "float32"),   # ★ 縮孔率(跟模溫走)
    ("porosity_rate",    "%",      "float32"),   # ★ 氣孔率(跟真空度走)
    ("vibration_rms",    "mm/s",   "float32"),
    ("cast_count",       "count",  "int32"),
]
_INDICATORS = {"die_thermal_fatigue", "vacuum_seal_wear"}
_DEFAULT_DEGRADATION = {
    "hydraulic_accumulator": {"rate": 0.0000011, "trajectory": "exponential", "k": 2.7, "sigma": 0.1, "init_health": 0.93},
    "die_thermal_fatigue": {"rate": 0.0000014, "trajectory": "linear", "sigma": 0.14, "init_health": 1.0, "causes_device_fault": False},
    "vacuum_seal_wear": {"rate": 0.0000013, "trajectory": "linear", "sigma": 0.13, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 85.0))
    rated = float(cfg.get("clamping_force_ton", 350))

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
    die_lag = ThermalLag(tau_sim_s=900.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "ph": 0.0, "casts": 0.0}

    def _cycle(h_acc: float) -> float:
        return CYCLE_S + (1.0 - h_acc) * 22.0        # 蓄壓器弱 → 循環拉長

    def pre_step(dt_sim, op):
        h_acc = health_of(comp_map, "hydraulic_accumulator")
        if op["running"] and not device._fault_latched and dt_sim > 0.0:
            st["t"] += dt_sim
            st["casts"] += dt_sim / _cycle(h_acc)
        st["ph"] = (st["t"] % _cycle(h_acc)) / _cycle(h_acc)

    def drv_clamp(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.6)
        # 合模 → 保壓 → 開模:相位 0.15~0.75 為鎖模段
        locked = 0.15 <= st["ph"] < 0.75
        return (rated * (0.95 + 0.05 * math.sin(st["ph"] * math.pi)) if locked else rated * 0.1) \
            + gaussian_noise(nrng, 1.2)

    def _shot_speed(comps) -> float:
        h_acc = health_of(comp_map, "hydraulic_accumulator")
        return SHOT_SPEED_NOM * (0.55 + 0.45 * h_acc)

    def drv_shot_speed(op, c, dt):
        if not op["running"]:
            return 0.0
        # 射出段(相位 0.28~0.36)才有速度,其餘為 0 —— 壓鑄的射出是很短的一瞬
        if 0.28 <= st["ph"] < 0.36:
            return max(0.0, _shot_speed(c) + gaussian_noise(nrng, 0.06))
        return gaussian_noise(nrng, 0.01)

    def drv_intensify(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 1.0)
        h_acc = health_of(comp_map, "hydraulic_accumulator")
        if 0.36 <= st["ph"] < 0.62:                   # 增壓補縮段
            return (880.0 * (0.6 + 0.4 * h_acc)) + gaussian_noise(nrng, 6.0)
        return 60.0 + gaussian_noise(nrng, 2.0)

    def _die_temp(comps, moving: bool) -> float:
        h_die = health_of(comp_map, "die_thermal_fatigue")
        # 熱疲勞龜裂 → 導熱路徑走樣:移動模側偏熱、固定模側偏冷 → 兩側溫差拉開
        skew = 26.0 * (1.0 - h_die) ** 1.2
        return DIE_SETPOINT_C + (skew if moving else -skew * 0.7)

    def drv_die_fixed(op, c, dt):
        target = _die_temp(c, moving=False) if op["running"] else AMBIENT_C
        return die_lag.update(target, dt) + gaussian_noise(nrng, 0.8)

    def drv_die_moving(op, c, dt):
        # 用同一個 lag 的當前值當基準,加上兩側偏差 —— 兩支 tag 有共同的熱慣性,不是各走各的
        if not op["running"]:
            return die_lag.T + gaussian_noise(nrng, 0.5)
        delta = _die_temp(c, moving=True) - _die_temp(c, moving=False)
        return die_lag.T + delta + gaussian_noise(nrng, 0.9)

    def _vacuum(comps) -> float:
        h_vac = health_of(comp_map, "vacuum_seal_wear")
        return VACUUM_NOM_MBAR + 210.0 * (1.0 - h_vac) ** 1.35   # 密封壞 → 抽不下去(數字變大)

    def drv_vacuum(op, c, dt):
        if not op["running"]:
            return 1013.0 + gaussian_noise(nrng, 1.0)
        return max(5.0, _vacuum(c) + gaussian_noise(nrng, 2.0))

    def drv_cycle(op, c, dt):
        return _cycle(health_of(comp_map, "hydraulic_accumulator")) + gaussian_noise(nrng, 0.3)

    def _shrinkage(comps) -> float:
        h_die = health_of(comp_map, "die_thermal_fatigue")
        return 0.35 + 6.8 * (1.0 - h_die) ** 1.3

    def _porosity(comps) -> float:
        h_vac = health_of(comp_map, "vacuum_seal_wear")
        return 0.30 + 7.2 * (1.0 - h_vac) ** 1.3

    def drv_shrinkage(op, c, dt):
        return max(0.0, _shrinkage(c) + gaussian_noise(nrng, 0.05)) if op["running"] else 0.0

    def drv_porosity(op, c, dt):
        return max(0.0, _porosity(c) + gaussian_noise(nrng, 0.05)) if op["running"] else 0.0

    def drv_vib(op, c, dt):
        h_acc = health_of(comp_map, "hydraulic_accumulator")
        base = 1.6 if op["running"] else 0.15
        return max(0.0, base + 9.0 * (1.0 - h_acc) ** 1.7 + gaussian_noise(nrng, 0.06))

    def drv_casts(op, c, dt):
        return int(st["casts"])

    tag_by_name["clamping_force"].driver = drv_clamp
    tag_by_name["shot_speed"].driver = drv_shot_speed
    tag_by_name["intensify_press"].driver = drv_intensify
    tag_by_name["die_temp_fixed"].driver = drv_die_fixed
    tag_by_name["die_temp_moving"].driver = drv_die_moving
    tag_by_name["vacuum_level"].driver = drv_vacuum
    tag_by_name["cycle_time"].driver = drv_cycle
    tag_by_name["shrinkage_rate"].driver = drv_shrinkage
    tag_by_name["porosity_rate"].driver = drv_porosity
    tag_by_name["vibration_rms"].driver = drv_vib
    tag_by_name["cast_count"].driver = drv_casts

    def oee_fn(op, comps):
        h_acc = health_of(comps, "hydraulic_accumulator")
        perf = CYCLE_S / _cycle(h_acc)
        bad = _shrinkage(comps) + _porosity(comps)
        return perf, float(np.clip(1.0 - bad / 30.0, 0.5, 1.0))

    def quality_fn(op, comps, tag_by):
        """縮孔與氣孔兩種不良獨立疊加。哪一種佔多數,就指向不同的維修對象:
        縮孔 → 模具熱疲勞(該保養模具);氣孔 → 真空密封劣化(該修真空系統)。"""
        if not op["running"]:
            return 0.0, "shrinkage_void"
        p_shrink = min(0.9, _shrinkage(comps) / 100.0)
        p_poro = min(0.9, _porosity(comps) / 100.0)
        p = p_shrink + (1.0 - p_shrink) * p_poro
        return p, ("shrinkage_void" if p_shrink >= p_poro else "gas_porosity")

    device = Device(
        device_id=device_id, template="die_casting_machine", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
