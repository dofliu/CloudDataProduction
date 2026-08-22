"""清洗乾燥機 template(手工具製程第 6 站:研磨後的油污 / 磨屑 → 脫脂清洗 → 烘乾)。

電鍍前一定要洗乾淨。這一站洗不乾淨,後面鍍層就附不住 —— 但**不良品要到電鍍站
才看得出來**,清洗站自己的儀表看起來一切正常。這正是它的教學價值:

  · pump_bearing_wear(本體,exponential)→ 循環泵軸承磨耗 → 振動升、揚程掉,
    最後咬死 → 設備 fault。
  · bath_contamination(指標,linear)→ 清洗液累積油污 → 導電度升、清潔力掉
    → 殘留污染度升(品質題)。換液就恢復。
  · nozzle_clog(指標,linear)→ 噴嘴堵 → 噴淋壓力「升」但覆蓋率掉(壓力升是因為
    出口變小,不是洗得更用力)—— 這個反直覺的組合是本站最值得教的一課。
  · heater_aging(指標,linear)→ 烘乾加熱器老化 → 烘乾溫度不足 → 殘留水分(品質題)。

四支品質相關訊號裡,只有 `residue_level` 是「結果」,其餘三支是「原因」。
學生要練的是從結果回推到底是哪一個原因,因為**三種原因的處置完全不同**
(換液 / 清噴嘴 / 換加熱器),選錯照樣扣工時。
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

# 連續網帶式清洗機:工件躺在網帶上連續穿過噴淋區 → 風刀區 → 烘乾區,
# **三區同時都有工件**。因此出料節拍(CYCLE_S)遠短於單件穿越全機的時間(TRANSIT_S)。
CYCLE_S = 15.0            # 出料節拍:每 15 sim 秒出一件
TRANSIT_S = 90.0          # 單件穿越全機(噴淋 + 風刀 + 烘乾)的時間
AMBIENT_C = 26.0
BATH_SET_C = 62.0         # 清洗槽設定溫度
DRY_SET_C = 105.0         # 烘乾設定溫度
RESIDUE_SPEC = 2.0        # 殘留污染度規格上限(mg/m²,超過即不良)

_TAG_SPEC = [
    ("state",            "enum",  "int16"),
    ("bath_temp",        "C",     "float32"),
    ("bath_conductivity", "uS/cm", "float32"),  # ★ 清洗液導電度(油污累積 → 升,換液指標)
    ("spray_pressure",   "bar",   "float32"),   # ★ 噴淋壓力(噴嘴堵 → 反而升)
    ("spray_flow",       "L/min", "float32"),   # ★ 噴淋流量(噴嘴堵 → 掉,與壓力反向)
    ("dry_temp",         "C",     "float32"),   # ★ 烘乾溫度(加熱器老化 → 到不了設定值)
    ("residue_level",    "mg/m2", "float32"),   # ★ 殘留污染度(品質結果指標)
    ("moisture_ppm",     "ppm",   "float32"),   # ★ 出料殘留水分(烘乾不足 → 升)
    ("pump_current",     "A",     "float32"),
    ("cycle_time",       "s",     "float32"),   # 出料節拍(多久出一件)
    ("transit_time",     "s",     "float32"),   # ★ 單件穿越全機的時間(≠ 節拍)
    ("vibration_rms",    "mm/s",  "float32"),
    ("washed_count",     "count", "int32"),
]
_INDICATORS = {"bath_contamination", "nozzle_clog", "heater_aging"}
_DEFAULT_DEGRADATION = {
    "pump_bearing_wear": {"rate": 0.0000010, "trajectory": "exponential", "k": 2.7, "sigma": 0.1, "init_health": 0.95},
    "bath_contamination": {"rate": 0.0000030, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    "nozzle_clog": {"rate": 0.0000016, "trajectory": "linear", "sigma": 0.13, "init_health": 1.0, "causes_device_fault": False},
    "heater_aging": {"rate": 0.0000013, "trajectory": "linear", "sigma": 0.12, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 70.0))

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
    bath_lag = ThermalLag(tau_sim_s=900.0, init_temp=AMBIENT_C)
    dry_lag = ThermalLag(tau_sim_s=520.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "ph": 0.0, "pieces": 0.0}

    def _cycle(h_pump: float) -> float:
        return CYCLE_S * (1.0 + 0.22 * (1.0 - h_pump))

    def pre_step(dt_sim, op):
        h_p = health_of(comp_map, "pump_bearing_wear")
        cyc = _cycle(h_p)
        if op["running"] and not device._fault_latched and dt_sim > 0.0:
            st["t"] += dt_sim
            st["pieces"] += dt_sim / cyc
        st["ph"] = (st["t"] % cyc) / cyc

    # 連續機:噴淋區與烘乾區**同時都在運作**(各自都有工件在裡面),
    # 所以兩區的訊號只看 running,不像批次機那樣有「這段在洗、那段在烘」的相位切換。
    # st["ph"] 在這台只驅動網帶行進位置(動畫與 belt_position),不 gating 製程訊號。

    def drv_bath_temp(op, c, dt):
        target = BATH_SET_C if op["running"] else AMBIENT_C
        return bath_lag.update(target, dt) + gaussian_noise(nrng, 0.25)

    def _conductivity(comps) -> float:
        h_c = health_of(comp_map, "bath_contamination")
        # 油污與金屬離子累積 → 導電度單調上升(換液才會掉回去)
        return 320.0 + 2450.0 * (1.0 - h_c) ** 1.25

    def drv_conductivity(op, c, dt):
        return max(0.0, _conductivity(c) + gaussian_noise(nrng, 4.0))

    def drv_spray_p(op, c, dt):
        if not op["running"]:
            return 0.15 + gaussian_noise(nrng, 0.02)
        h_n = health_of(comp_map, "nozzle_clog")
        h_p = health_of(comp_map, "pump_bearing_wear")
        # 噴嘴堵 → 出口變小 → 泵前壓力**升**;泵磨耗 → 揚程掉 → 壓力降(兩者反向)
        return (3.2 * (1.0 + 0.62 * (1.0 - h_n) ** 1.3) * (0.80 + 0.20 * h_p)
                + gaussian_noise(nrng, 0.035))

    def _flow_lpm(comps) -> float:
        h_n = health_of(comp_map, "nozzle_clog")
        h_p = health_of(comp_map, "pump_bearing_wear")
        return 180.0 * (0.38 + 0.62 * h_n) * (0.85 + 0.15 * h_p)

    def drv_spray_f(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.4)
        return max(0.0, _flow_lpm(c) + gaussian_noise(nrng, 1.1))

    def drv_dry_temp(op, c, dt):
        h_h = health_of(comp_map, "heater_aging")
        if not op["running"]:
            target = AMBIENT_C
        else:
            # 加熱器老化 → 到不了設定溫度(功率掉,不是設定值改了)
            target = AMBIENT_C + (DRY_SET_C - AMBIENT_C) * (0.62 + 0.38 * h_h)
        return dry_lag.update(target, dt) + gaussian_noise(nrng, 0.6)

    def _residue(comps) -> float:
        """殘留污染度 = 清潔力不足的總和。清潔力被兩件事拉低:
        液髒了(bath_contamination)與洗不到(nozzle_clog 讓流量掉)。"""
        h_c = health_of(comp_map, "bath_contamination")
        h_n = health_of(comp_map, "nozzle_clog")
        return 0.35 + 3.1 * (1.0 - h_c) ** 1.5 + 2.4 * (1.0 - h_n) ** 1.7

    def drv_residue(op, c, dt):
        return max(0.0, _residue(c) + gaussian_noise(nrng, 0.03)) if op["running"] else 0.0

    def _moisture(comps) -> float:
        h_h = health_of(comp_map, "heater_aging")
        return 40.0 + 760.0 * (1.0 - h_h) ** 1.8

    def drv_moisture(op, c, dt):
        return max(0.0, _moisture(c) + gaussian_noise(nrng, 3.0)) if op["running"] else 0.0

    def drv_pump_current(op, c, dt):
        if not op["running"]:
            return 0.8 + gaussian_noise(nrng, 0.04)
        h_p = health_of(comp_map, "pump_bearing_wear")
        h_n = health_of(comp_map, "nozzle_clog")
        # 泵磨耗 → 電流升;噴嘴堵 → 流量掉 → 電流其實**略降**(離心泵特性)
        base = 11.5
        return (base * (1.0 + 0.42 * (1.0 - h_p) ** 1.6) * (0.88 + 0.12 * h_n)
                + gaussian_noise(nrng, 0.1))

    def drv_cycle(op, c, dt):
        return _cycle(health_of(comp_map, "pump_bearing_wear")) + gaussian_noise(nrng, 0.12)

    def drv_vib(op, c, dt):
        h_p = health_of(comp_map, "pump_bearing_wear")
        base = 0.9 if op["running"] else 0.12
        return max(0.0, base + 7.6 * (1.0 - h_p) ** 1.85 + gaussian_noise(nrng, 0.05))

    def drv_transit(op, c, dt):
        # 泵揚程掉 → 網帶連動放慢(讓清洗時間補回來),穿越時間與節拍同比例拉長
        return TRANSIT_S * (_cycle(health_of(comp_map, "pump_bearing_wear")) / CYCLE_S) \
            + gaussian_noise(nrng, 0.3)

    def drv_pieces(op, c, dt):
        return int(st["pieces"])

    tag_by_name["bath_temp"].driver = drv_bath_temp
    tag_by_name["bath_conductivity"].driver = drv_conductivity
    tag_by_name["spray_pressure"].driver = drv_spray_p
    tag_by_name["spray_flow"].driver = drv_spray_f
    tag_by_name["dry_temp"].driver = drv_dry_temp
    tag_by_name["residue_level"].driver = drv_residue
    tag_by_name["moisture_ppm"].driver = drv_moisture
    tag_by_name["pump_current"].driver = drv_pump_current
    tag_by_name["cycle_time"].driver = drv_cycle
    tag_by_name["transit_time"].driver = drv_transit
    tag_by_name["vibration_rms"].driver = drv_vib
    tag_by_name["washed_count"].driver = drv_pieces

    def oee_fn(op, comps):
        h_p = health_of(comps, "pump_bearing_wear")
        perf = CYCLE_S / _cycle(h_p)
        over = max(0.0, _residue(comps) - RESIDUE_SPEC)
        q_res = np.clip(1.0 - over / 2.6, 0.5, 1.0)
        q_moi = np.clip(1.0 - _moisture(comps) / 2400.0, 0.5, 1.0)
        return perf, float(min(q_res, q_moi))

    def quality_fn(op, comps, tag_by):
        """兩種不良:洗不乾淨(殘留污染)與烘不乾(殘留水分)。兩者都與同名觀測訊號
        同一條式子重算。defect_type 對應三種不同處置 —— 換液 / 清噴嘴 / 換加熱器。"""
        if not op["running"]:
            return 0.0, "residue_contamination"
        h_c = health_of(comps, "bath_contamination")
        h_n = health_of(comps, "nozzle_clog")
        over = max(0.0, _residue(comps) - RESIDUE_SPEC * 0.8)
        p_res = min(0.88, over / (RESIDUE_SPEC * 1.5))
        p_moi = min(0.5, max(0.0, _moisture(comps) - 220.0) / 1600.0)
        p = p_res + (1.0 - p_res) * p_moi
        if p_moi > p_res:
            dtype = "moisture_carryover"
        else:
            dtype = "residue_contamination" if (1.0 - h_c) >= (1.0 - h_n) else "spray_coverage_gap"
        return max(0.004, p), dtype

    device = Device(
        device_id=device_id, template="cleaning_dryer", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
