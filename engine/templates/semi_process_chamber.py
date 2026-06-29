"""半導體製程腔體 template(docs/03,製程設備代表)。

製程機台連續運轉,訊號最細緻。三條故障線各有不同教學意義:
  · vacuum_pump_wear(本體,exponential)→ 真空泵電流 / 溫度升,最後泵失效 → 設備 fault(經典 PdM)。
  · process_drift(指標,wiener)→ 緩慢推高 particle_count → 良率(quality)掉,**設備不會 fault**。
    這是「subtle fault」:沒有單一訊號跳警報,只有良率慢慢爛 —— 比軸承故障更難偵測,正好補製程漂移題型。
  · mfc_drift(指標)→ 氣體流量「讀值」偏移(MFC 校正漂移),教感測器層異常 vs 真實製程異常的分辨。

刻意連續運轉(duty=continuous):製程機台不分班,RUL 隨時定義 —— 對階段二 lead-time 評分友善。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 23.0          # 無塵室環境溫度
BASE_PRESSURE = 5.0       # 抽到底的腔壓(mTorr),真空泵健康時
GAS_SETPOINTS = (50.0, 30.0, 15.0)   # 三支 MFC 製程氣體流量(sccm)
RF_NOM = 1500.0           # 製程 RF 功率(W)
THROUGHPUT_NOM = 25.0     # 額定產出(wafer per hour)
PARTICLE_BASE = 4.0       # 健康基線微粒數(#/wafer)

_TAG_SPEC = [
    ("state",               "enum",    "int16"),
    ("chamber_pressure",    "mTorr",   "float32"),   # 腔壓:氣流負載 + 真空泵退化
    ("chamber_temp",        "degC",    "float32"),
    ("rf_power",            "W",       "float32"),
    ("gas_flow_1",          "sccm",    "float32"),    # MFC 1(讀值受 mfc_drift 汙染)
    ("gas_flow_2",          "sccm",    "float32"),
    ("gas_flow_3",          "sccm",    "float32"),
    ("vacuum_pump_current", "A",       "float32"),    # ★ vacuum_pump_wear 退化主指標
    ("pump_temp",           "degC",    "float32"),
    ("throughput",          "wph",     "float32"),
    ("particle_count",      "1/wafer", "float32"),    # ★ 良率指標:process_drift 推高
    ("wafer_count",         "count",   "int32"),      # 累積處理片數
]
# 指標型元件(不直接判定設備故障):製程漂移只壞良率、MFC 漂移只汙染讀值
_INDICATORS = {"process_drift", "mfc_drift"}
_DEFAULT_DEGRADATION = {
    "vacuum_pump_wear": {"rate": 0.0000009, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
    "process_drift": {"rate": 0.0000016, "trajectory": "wiener", "sigma": 0.35, "init_health": 1.0, "causes_device_fault": False},
    "mfc_drift": {"rate": 0.0000010, "trajectory": "linear", "sigma": 0.12, "init_health": 1.0, "causes_device_fault": False},
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
    chamber_lag = ThermalLag(tau_sim_s=900.0, init_temp=AMBIENT_C)
    pump_lag = ThermalLag(tau_sim_s=3000.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "wafers": 0.0, "ph": 0.0}

    def pre_step(dt_sim, op):
        # 製程連續累積片數;throughput 隨真空泵退化略降(抽氣不穩 → 節拍變慢)
        if op["running"] and not device._fault_latched:
            st["t"] += dt_sim
            wph = THROUGHPUT_NOM * (0.7 + 0.3 * health_of(comp_map, "vacuum_pump_wear"))
            st["wafers"] += dt_sim * wph / 3600.0
        st["ph"] = math.sin(st["t"] / 120.0)   # 製程腔內緩慢起伏(recipe 步進)

    def _gas(i):
        sp = GAS_SETPOINTS[i]
        def drv(op, c, dt):
            if not op["running"]:
                return gaussian_noise(nrng, 0.05)
            # gas_flow_1 的讀值受 MFC 校正漂移影響(讀值偏高,真實製程未必跟著變)
            bias = 0.0 if i != 0 else sp * 0.25 * (1.0 - health_of(comp_map, "mfc_drift"))
            return sp + bias + gaussian_noise(nrng, sp * 0.01)
        return drv

    def drv_pressure(op, c, dt):
        h_pump = health_of(comp_map, "vacuum_pump_wear")
        floor = BASE_PRESSURE + 30.0 * (1.0 - h_pump)        # 泵退化 → 抽不到底,基壓爬升
        if not op["running"]:
            return floor + gaussian_noise(nrng, 0.2)
        gas_load = 0.55 * sum(GAS_SETPOINTS)                  # 製程氣體負載抬高腔壓
        return floor + gas_load * (1.0 + 0.03 * st["ph"]) + gaussian_noise(nrng, 0.6)

    def drv_chamber_temp(op, c, dt):
        rf = RF_NOM if op["running"] else 0.0
        target = AMBIENT_C + 0.022 * rf                       # RF 加熱
        return chamber_lag.update(target, dt) + gaussian_noise(nrng, 0.3)

    def drv_rf(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.5)
        return RF_NOM * (1.0 + 0.015 * st["ph"]) + gaussian_noise(nrng, 6.0)

    def drv_pump_current(op, c, dt):
        h_pump = health_of(comp_map, "vacuum_pump_wear")
        base = 6.0 if op["running"] else 4.0
        return base + 9.0 * (1.0 - h_pump) ** 1.6 + gaussian_noise(nrng, 0.08)

    def drv_pump_temp(op, c, dt):
        h_pump = health_of(comp_map, "vacuum_pump_wear")
        load = 30.0 if op["running"] else 8.0
        return pump_lag.update(AMBIENT_C + load + 22.0 * (1.0 - h_pump), dt) + gaussian_noise(nrng, 0.25)

    def drv_throughput(op, c, dt):
        if not op["running"]:
            return 0.0
        return THROUGHPUT_NOM * (0.7 + 0.3 * health_of(comp_map, "vacuum_pump_wear")) + gaussian_noise(nrng, 0.15)

    def drv_particle(op, c, dt):
        # 製程漂移把微粒數從個位數推到數十:良率殺手,卻沒有任一訊號「跳警報」
        h_drift = health_of(comp_map, "process_drift")
        base = PARTICLE_BASE if op["running"] else PARTICLE_BASE * 0.4
        return max(0.0, base + 70.0 * (1.0 - h_drift) ** 1.4 + gaussian_noise(nrng, 0.8))

    def drv_wafers(op, c, dt):
        return int(st["wafers"])

    tag_by_name["chamber_pressure"].driver = drv_pressure
    tag_by_name["chamber_temp"].driver = drv_chamber_temp
    tag_by_name["rf_power"].driver = drv_rf
    for i in range(3):
        tag_by_name[f"gas_flow_{i+1}"].driver = _gas(i)
    tag_by_name["vacuum_pump_current"].driver = drv_pump_current
    tag_by_name["pump_temp"].driver = drv_pump_temp
    tag_by_name["throughput"].driver = drv_throughput
    tag_by_name["particle_count"].driver = drv_particle
    tag_by_name["wafer_count"].driver = drv_wafers

    def oee_fn(op, comps):
        # 表現:真空泵退化拖慢節拍;良率:微粒數越高、良率越低(製程漂移直接打 quality)
        perf = 0.7 + 0.3 * health_of(comps, "vacuum_pump_wear")
        particle = PARTICLE_BASE + 70.0 * (1.0 - health_of(comps, "process_drift")) ** 1.4
        qual = float(np.clip(1.0 - (particle - PARTICLE_BASE) / 120.0, 0.5, 1.0))
        return perf, qual

    device = Device(
        device_id=device_id, template="semi_process_chamber", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
