"""研磨拋光機 template(手工具製程第 5 站:切邊後的胚體 → 磨掉分模線、拋出表面)。

鍛造 + 切邊出來的胚體表面粗糙、還留著分模線,要靠砂輪 / 拋光輪修出來。
這一站的教學價值在於**「消耗品磨耗」與「機構磨耗」長得完全不一樣**:

  · spindle_bearing_wear(本體,exponential)→ 主軸軸承磨耗 → 振動升、溫度升,
    最後咬死 → 設備 fault。這是「機構」的病。
  · abrasive_wear(指標,linear)→ 砂輪 / 拋光輪磨耗 → 切削效率掉,操作員為了維持
    節拍就壓更大的力,結果**表面粗糙度反而變差**(品質題)。這是「消耗品」的病。
  · dust_extraction_clog(指標,linear)→ 集塵管路堵 → 抽風壓差升、風量掉,磨屑
    回附在工件上 → 表面刮傷(品質題)。這是「通道」的病,清一清就好。

三條線在振動上都會有一點反應,但**只有軸承那條會走到 fault**。學生要學會分辨
「振動升」到底來自哪一條 —— 看它有沒有伴隨主軸溫度、看粗糙度、看抽風壓差。
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

CYCLE_S = 18.0            # 一件研磨拋光的循環(sim 秒)
AMBIENT_C = 26.0
NOM_SPINDLE_RPM = 2850.0
RA_SPEC_UM = 0.80         # 表面粗糙度規格上限(µm Ra,超過即不良)

_TAG_SPEC = [
    ("state",             "enum",  "int16"),
    ("spindle_rpm",       "rpm",   "float32"),   # ★ 主軸轉速(砂輪磨耗 → 負載重 → 掉速)
    ("grind_force",       "N",     "float32"),   # ★ 研磨壓力(砂輪鈍 → 要壓更大)
    ("surface_ra",        "um",    "float32"),   # ★ 表面粗糙度(品質指標,越小越好)
    ("wheel_diameter",    "mm",    "float32"),   # ★ 砂輪剩餘直徑(消耗品餘命,看得見的壽命)
    ("extraction_dp",     "kPa",   "float32"),   # ★ 集塵壓差(堵 → 升)
    ("extraction_flow",   "m3/h",  "float32"),   # ★ 抽風量(堵 → 掉)
    ("spindle_temp",      "C",     "float32"),
    ("motor_current",     "A",     "float32"),
    ("cycle_time",        "s",     "float32"),
    ("vibration_rms",     "mm/s",  "float32"),
    ("ground_count",      "count", "int32"),
]
_INDICATORS = {"abrasive_wear", "dust_extraction_clog"}
_DEFAULT_DEGRADATION = {
    "spindle_bearing_wear": {"rate": 0.0000011, "trajectory": "exponential", "k": 2.9, "sigma": 0.1, "init_health": 0.95},
    "abrasive_wear": {"rate": 0.0000026, "trajectory": "linear", "sigma": 0.16, "init_health": 1.0, "causes_device_fault": False},
    "dust_extraction_clog": {"rate": 0.0000014, "trajectory": "linear", "sigma": 0.12, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 72.0))

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
    spindle_lag = ThermalLag(tau_sim_s=420.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "ph": 0.0, "parts": 0.0}

    def _cycle(h_abr: float, h_bear: float) -> float:
        # 砂輪鈍 → 同樣的量要磨久一點;軸承壞 → 也拖節拍
        return CYCLE_S * (1.0 + 0.30 * (1.0 - h_abr) + 0.18 * (1.0 - h_bear))

    def pre_step(dt_sim, op):
        h_a = health_of(comp_map, "abrasive_wear")
        h_b = health_of(comp_map, "spindle_bearing_wear")
        cyc = _cycle(h_a, h_b)
        if op["running"] and not device._fault_latched and dt_sim > 0.0:
            st["t"] += dt_sim
            st["parts"] += dt_sim / cyc
        st["ph"] = (st["t"] % cyc) / cyc

    def _contact() -> float:
        """接觸率:一個循環裡大約 62% 的時間砂輪真的貼在工件上(其餘是進退刀 / 換件)。"""
        return 1.0 if st["ph"] < 0.62 else 0.0

    def _force(comps) -> float:
        h_a = health_of(comp_map, "abrasive_wear")
        # 砂輪鈍 → 切削效率掉 → 要壓更大的力才磨得動(這是操作端的補償行為)
        return 85.0 * (1.0 + 0.85 * (1.0 - h_a) ** 1.2)

    def drv_force(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.3)
        return _force(c) * _contact() + gaussian_noise(nrng, 1.6)

    def drv_rpm(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 1.0)
        h_a = health_of(comp_map, "abrasive_wear")
        h_b = health_of(comp_map, "spindle_bearing_wear")
        # 負載越重 → 掉速越多(接觸時才掉)
        droop = (0.055 * (1.0 - h_a) + 0.030 * (1.0 - h_b)) * _contact()
        return NOM_SPINDLE_RPM * (1.0 - droop) + gaussian_noise(nrng, 4.0)

    def _ra_um(comps) -> float:
        """表面粗糙度:砂輪鈍 → 變差;集塵堵 → 磨屑回附刮傷 → 也變差。
        兩條路都推高同一支訊號,但**伴隨的訊號不同**(壓力 vs 壓差)—— 這就是要教的鑑別診斷。"""
        h_a = health_of(comp_map, "abrasive_wear")
        h_d = health_of(comp_map, "dust_extraction_clog")
        return 0.34 + 0.95 * (1.0 - h_a) ** 1.7 + 0.55 * (1.0 - h_d) ** 2.0

    def drv_ra(op, c, dt):
        return max(0.02, _ra_um(c) + gaussian_noise(nrng, 0.012)) if op["running"] else 0.0

    def drv_wheel(op, c, dt):
        h_a = health_of(comp_map, "abrasive_wear")
        # 砂輪從 Ø350 磨到 Ø260 就該換(消耗品餘命直接看得見)
        return 260.0 + 90.0 * h_a + gaussian_noise(nrng, 0.05)

    def _dp_kpa(comps) -> float:
        h_d = health_of(comp_map, "dust_extraction_clog")
        return 0.9 + 4.6 * (1.0 - h_d) ** 1.5

    def drv_dp(op, c, dt):
        return max(0.0, _dp_kpa(c) + gaussian_noise(nrng, 0.03)) if op["running"] else 0.05

    def drv_flow(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 2.0)
        h_d = health_of(comp_map, "dust_extraction_clog")
        # 壓差升 → 風量掉(同一個堵塞的兩面,學生可以驗證兩支訊號相關)
        return 2400.0 * (0.42 + 0.58 * h_d) + gaussian_noise(nrng, 12.0)

    def drv_temp(op, c, dt):
        h_b = health_of(comp_map, "spindle_bearing_wear")
        h_a = health_of(comp_map, "abrasive_wear")
        if not op["running"]:
            target = AMBIENT_C
        else:
            # 軸承磨耗 → 摩擦生熱;研磨力大 → 也生熱
            target = AMBIENT_C + 26.0 + 44.0 * (1.0 - h_b) ** 1.6 + 11.0 * (1.0 - h_a)
        return spindle_lag.update(target, dt) + gaussian_noise(nrng, 0.35)

    def drv_current(op, c, dt):
        if not op["running"]:
            return 1.6 + gaussian_noise(nrng, 0.05)
        h_b = health_of(comp_map, "spindle_bearing_wear")
        load = _force(c) / 85.0
        return 7.5 + 12.5 * load * _contact() + 5.5 * (1.0 - h_b) ** 1.7 + gaussian_noise(nrng, 0.14)

    def drv_cycle(op, c, dt):
        return _cycle(health_of(comp_map, "abrasive_wear"),
                      health_of(comp_map, "spindle_bearing_wear")) + gaussian_noise(nrng, 0.08)

    def drv_vib(op, c, dt):
        h_b = health_of(comp_map, "spindle_bearing_wear")
        h_a = health_of(comp_map, "abrasive_wear")
        base = 1.1 if op["running"] else 0.10
        # 軸承那條是主導(指數 1.8),砂輪只是輕微加成 —— 振動獨大時要想到軸承
        return max(0.0, base + 8.8 * (1.0 - h_b) ** 1.8 + 1.5 * (1.0 - h_a) * _contact()
                   + gaussian_noise(nrng, 0.05))

    def drv_parts(op, c, dt):
        return int(st["parts"])

    tag_by_name["spindle_rpm"].driver = drv_rpm
    tag_by_name["grind_force"].driver = drv_force
    tag_by_name["surface_ra"].driver = drv_ra
    tag_by_name["wheel_diameter"].driver = drv_wheel
    tag_by_name["extraction_dp"].driver = drv_dp
    tag_by_name["extraction_flow"].driver = drv_flow
    tag_by_name["spindle_temp"].driver = drv_temp
    tag_by_name["motor_current"].driver = drv_current
    tag_by_name["cycle_time"].driver = drv_cycle
    tag_by_name["vibration_rms"].driver = drv_vib
    tag_by_name["ground_count"].driver = drv_parts

    def oee_fn(op, comps):
        h_a = health_of(comps, "abrasive_wear")
        h_b = health_of(comps, "spindle_bearing_wear")
        perf = CYCLE_S / _cycle(h_a, h_b)
        over = max(0.0, _ra_um(comps) - RA_SPEC_UM)
        return perf, float(np.clip(1.0 - over / 0.9, 0.5, 1.0))

    def quality_fn(op, comps, tag_by):
        """粗糙度超規即不良。與 surface_ra 同一條式子重算 —— 學生量到 Ra 就能推不良率。
        defect_type 分兩種,對應兩種**不同的處置**:砂輪鈍要換砂輪,集塵堵要清管路。"""
        if not op["running"]:
            return 0.0, "roughness_over_spec"
        h_a = health_of(comps, "abrasive_wear")
        h_d = health_of(comps, "dust_extraction_clog")
        over = max(0.0, _ra_um(comps) - RA_SPEC_UM * 0.85)
        p = min(0.90, over / (RA_SPEC_UM * 1.1))
        # 誰貢獻得多就標誰(讓 ground-truth 對得上實際主因)
        dtype = "roughness_over_spec" if (1.0 - h_a) >= (1.0 - h_d) else "swarf_scratch"
        return max(0.004, p), dtype

    device = Device(
        device_id=device_id, template="grinding_polisher", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
