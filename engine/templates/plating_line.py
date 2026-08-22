"""電鍍表面處理 template(手工具製程第 7 站:洗淨的工件 → 鍍鎳鉻 → 防鏽與外觀)。

電鍍是整條手工具產線裡**最像化學製程**的一站:控制的不是機構,是電流密度、
鍍液成分與溫度。它也是唯一一站,不良的**根因常常在上一站**(沒洗乾淨 → 鍍層附不住)。

  · rectifier_aging(本體,exponential)→ 整流器老化 → 輸出電流不穩、紋波升,
    最後失效 → 設備 fault。這是唯一會停機的一條。
  · anode_consumption(指標,linear)→ 陽極消耗 → 有效面積掉 → 電流密度不足
    → 鍍層變薄(品質題)。陽極是消耗品,補掛就好。
  · bath_aging(指標,linear)→ 鍍液老化(光澤劑耗盡 / 雜質累積)→ 鍍層孔隙率升
    → 鹽霧測試不過(品質題)。這條要調鍍液,不是換陽極。

鍍層厚度(coating_thickness)是法拉第定律的直接結果:**厚度 ∝ 電流密度 × 通電時間**。
學生可以拿 `current_density × dwell_time` 自己算一次,驗證引擎沒有騙人 ——
這是全園區少數能用課本公式直接驗算的一站。

**注意用哪一個時間**:這是連續掛鍍線,`cycle_time`(多久出一件)與 `dwell_time`
(一件在槽裡泡多久)是兩個不同的數字,兩支都開放讀取。拿 cycle_time 去套法拉第
會算出錯的答案 —— 這個坑是刻意留的,分辨「節拍」與「停留時間」本身就是要教的事。
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

# 連續掛鍍線:掛具在槽列間連續前進,**同時有多掛在不同槽裡**。
# 因此「多久出一件」(CYCLE_S)與「一件在鍍槽裡待多久」(DWELL_S)是兩個不同的數字 ——
# 這正是連續製程與批次製程最容易搞混的地方,鍍層厚度要用 DWELL_S 算,產能要用 CYCLE_S 算。
CYCLE_S = 12.0            # 出料節拍:每 12 sim 秒出一件
DWELL_S = 720.0           # 單件在鍍槽內的通電停留時間(法拉第定律用這個;12 分鐘)
AMBIENT_C = 26.0
BATH_SET_C = 55.0         # 鍍液設定溫度
NOM_CURRENT_DENSITY = 4.0  # 額定電流密度(A/dm²)
THICK_SPEC_MIN_UM = 8.0   # 鍍層厚度規格下限(µm,低於即不良)
POROSITY_SPEC = 3.5       # 孔隙率規格上限(每 cm² 個數)

_TAG_SPEC = [
    ("state",              "enum",   "int16"),
    ("current_density",    "A/dm2",  "float32"),  # ★ 電流密度(陽極消耗 → 掉)
    ("cell_voltage",       "V",      "float32"),  # ★ 槽電壓(陽極少 / 液老 → 升)
    ("rectifier_ripple",   "%",      "float32"),  # ★ 整流器紋波(老化 → 升,本體病徵)
    ("bath_temp",          "C",      "float32"),
    ("bath_ph",            "pH",     "float32"),  # ★ 鍍液 pH(老化 → 漂移)
    ("coating_thickness",  "um",     "float32"),  # ★ 鍍層厚度(品質結果,法拉第定律)
    ("porosity_count",     "1/cm2",  "float32"),  # ★ 孔隙率(鍍液老化 → 升)
    ("anode_mass",         "kg",     "float32"),  # ★ 陽極剩餘質量(消耗品餘命)
    ("rectifier_temp",     "C",      "float32"),
    ("cycle_time",         "s",      "float32"),  # 出料節拍(多久出一件)
    ("dwell_time",         "s",      "float32"),  # ★ 槽內通電停留時間(法拉第定律用這支)
    ("plated_count",       "count",  "int32"),
]
_INDICATORS = {"anode_consumption", "bath_aging"}
_DEFAULT_DEGRADATION = {
    "rectifier_aging": {"rate": 0.0000009, "trajectory": "exponential", "k": 2.6, "sigma": 0.1, "init_health": 0.96},
    "anode_consumption": {"rate": 0.0000028, "trajectory": "linear", "sigma": 0.14, "init_health": 1.0, "causes_device_fault": False},
    "bath_aging": {"rate": 0.0000019, "trajectory": "linear", "sigma": 0.14, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 68.0))

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
    bath_lag = ThermalLag(tau_sim_s=1600.0, init_temp=AMBIENT_C)
    rect_lag = ThermalLag(tau_sim_s=380.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "ph": 0.0, "racks": 0.0}

    def _cycle(h_anode: float) -> float:
        """出料節拍。陽極消耗 → 電流密度不足 → 掛具要走慢一點讓停留時間變長,
        產能因此掉 —— 這是現場真實的補償方式,代價寫在節拍上。"""
        return CYCLE_S * (1.0 + 0.26 * (1.0 - h_anode))

    def _dwell(h_anode: float) -> float:
        """單件通電停留秒數。與節拍同比例放慢(掛具走得慢,泡得久)。"""
        return DWELL_S * (1.0 + 0.26 * (1.0 - h_anode))

    def pre_step(dt_sim, op):
        h_a = health_of(comp_map, "anode_consumption")
        cyc = _cycle(h_a)
        if op["running"] and not device._fault_latched and dt_sim > 0.0:
            st["t"] += dt_sim
            st["racks"] += dt_sim / cyc
        st["ph"] = (st["t"] % cyc) / cyc

    # 連續線的鍍槽**一直是通電的**(隨時有多掛在不同槽裡),所以電氣訊號只看 running,
    # 不像批次機那樣有「進出槽空檔」的相位。st["ph"] 在這台只驅動掛具行走位置(動畫)。

    def _cd(comps) -> float:
        """有效電流密度:陽極消耗 → 有效面積掉 → 電流密度掉。
        整流器老化也會讓輸出略降(但主要表現在紋波上)。"""
        h_an = health_of(comp_map, "anode_consumption")
        h_r = health_of(comp_map, "rectifier_aging")
        return NOM_CURRENT_DENSITY * (0.55 + 0.45 * h_an) * (0.93 + 0.07 * h_r)

    def drv_cd(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.01)
        h_r = health_of(comp_map, "rectifier_aging")
        # 整流器老化 → 輸出不穩(雜訊本身變大,不只是均值掉)
        sigma = 0.035 + 0.16 * (1.0 - h_r) ** 1.5
        return max(0.0, _cd(c) + gaussian_noise(nrng, sigma))

    def drv_voltage(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.02)
        h_an = health_of(comp_map, "anode_consumption")
        h_b = health_of(comp_map, "bath_aging")
        # 陽極少 / 液導電度變差 → 同樣電流要更高的電壓推(槽電阻上升)
        return (5.6 * (1.0 + 0.48 * (1.0 - h_an) ** 1.2 + 0.30 * (1.0 - h_b))
                + gaussian_noise(nrng, 0.04))

    def drv_ripple(op, c, dt):
        h_r = health_of(comp_map, "rectifier_aging")
        base = 1.2 if op["running"] else 0.15
        return max(0.0, base + 13.5 * (1.0 - h_r) ** 1.9 + gaussian_noise(nrng, 0.06))

    def drv_bath_temp(op, c, dt):
        target = BATH_SET_C if op["running"] else AMBIENT_C
        return bath_lag.update(target, dt) + gaussian_noise(nrng, 0.18)

    def drv_ph(op, c, dt):
        h_b = health_of(comp_map, "bath_aging")
        # 鍍液老化 → pH 從 4.4 往上漂(雜質累積);漂移量本身就是換液指標
        return 4.4 + 1.35 * (1.0 - h_b) ** 1.2 + gaussian_noise(nrng, 0.012)

    def _thickness_um(comps) -> float:
        """法拉第定律:厚度 ∝ 電流密度 × 通電時間。
        引擎這裡就是老實照這條算 —— 學生拿 current_density × cycle_time 驗算得出來。"""
        h_an = health_of(comp_map, "anode_consumption")
        t_on = _dwell(h_an) / 60.0                  # 槽內通電分鐘數(**不是**出料節拍)
        # 0.197 µm per (A/dm²·min) = 鎳在 1 A/dm² 下約 11.8 µm/h 的實際沉積率。
        # 額定 4 A/dm² × 12 min ≈ 9.5 µm,對 8 µm 規格留約 18% 餘裕 —— 健康時本來就該過。
        return _cd(comps) * t_on * 0.197

    def drv_thickness(op, c, dt):
        return max(0.0, _thickness_um(c) + gaussian_noise(nrng, 0.07)) if op["running"] else 0.0

    def _porosity(comps) -> float:
        h_b = health_of(comp_map, "bath_aging")
        # 鍍液老化 → 光澤劑耗盡 → 鍍層結晶粗大 → 孔隙變多(鹽霧測試不過的直接前因)
        return 0.7 + 6.8 * (1.0 - h_b) ** 1.7

    def drv_porosity(op, c, dt):
        return max(0.0, _porosity(c) + gaussian_noise(nrng, 0.05)) if op["running"] else 0.0

    def drv_anode_mass(op, c, dt):
        h_an = health_of(comp_map, "anode_consumption")
        # 陽極從 120 kg 消耗到 35 kg 就該補掛(消耗品餘命直接看得見)
        return 35.0 + 85.0 * h_an + gaussian_noise(nrng, 0.03)

    def drv_rect_temp(op, c, dt):
        h_r = health_of(comp_map, "rectifier_aging")
        if not op["running"]:
            target = AMBIENT_C
        else:
            # 整流器老化 → 損耗變大 → 自己發熱(和紋波同源,兩支訊號相關)
            target = AMBIENT_C + 24.0 + 42.0 * (1.0 - h_r) ** 1.7
        return rect_lag.update(target, dt) + gaussian_noise(nrng, 0.3)

    def drv_cycle(op, c, dt):
        return _cycle(health_of(comp_map, "anode_consumption")) + gaussian_noise(nrng, 0.15)

    def drv_dwell(op, c, dt):
        return _dwell(health_of(comp_map, "anode_consumption")) + gaussian_noise(nrng, 0.4)

    def drv_racks(op, c, dt):
        return int(st["racks"])

    tag_by_name["current_density"].driver = drv_cd
    tag_by_name["cell_voltage"].driver = drv_voltage
    tag_by_name["rectifier_ripple"].driver = drv_ripple
    tag_by_name["bath_temp"].driver = drv_bath_temp
    tag_by_name["bath_ph"].driver = drv_ph
    tag_by_name["coating_thickness"].driver = drv_thickness
    tag_by_name["porosity_count"].driver = drv_porosity
    tag_by_name["anode_mass"].driver = drv_anode_mass
    tag_by_name["rectifier_temp"].driver = drv_rect_temp
    tag_by_name["cycle_time"].driver = drv_cycle
    tag_by_name["dwell_time"].driver = drv_dwell
    tag_by_name["plated_count"].driver = drv_racks

    def oee_fn(op, comps):
        h_an = health_of(comps, "anode_consumption")
        perf = CYCLE_S / _cycle(h_an)
        short = max(0.0, THICK_SPEC_MIN_UM - _thickness_um(comps))
        q_th = np.clip(1.0 - short / 4.0, 0.5, 1.0)
        q_po = np.clip(1.0 - max(0.0, _porosity(comps) - POROSITY_SPEC) / 4.5, 0.5, 1.0)
        return perf, float(min(q_th, q_po))

    def quality_fn(op, comps, tag_by):
        """兩種不良,對應兩種完全不同的處置:
          · 鍍層過薄 → 陽極不夠(補掛陽極),coating_thickness 直接看得到
          · 孔隙過多 → 鍍液老化(調 / 換鍍液),厚度可能還在規格內但鹽霧測試會掛
        「厚度夠但孔隙多」是本站最值得教的情境 —— 只看厚度會漏掉一整類不良。"""
        if not op["running"]:
            return 0.0, "coating_too_thin"
        short = max(0.0, THICK_SPEC_MIN_UM * 1.05 - _thickness_um(comps))
        p_th = min(0.90, short / (THICK_SPEC_MIN_UM * 0.42))
        over = max(0.0, _porosity(comps) - POROSITY_SPEC * 0.85)
        p_po = min(0.85, over / (POROSITY_SPEC * 1.1))
        p = p_th + (1.0 - p_th) * p_po
        return max(0.004, p), ("coating_too_thin" if p_th >= p_po else "coating_porosity")

    device = Device(
        device_id=device_id, template="plating_line", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
