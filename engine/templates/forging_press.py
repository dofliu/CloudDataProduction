"""鍛造壓機 template(手工具製程的成形站:熱棒料 → 鍛胚)。

熱模鍛:加熱好的棒料放進模具,壓機一擊成形。與沖壓機(stamping_press)的差別在於
**溫度是主角**:模具要預熱、鍛件出模是紅熱的,而模具在高溫下會磨損得比冷沖快得多。
三條退化線:

  · ram_guide_wear(本體,exponential)→ 滑塊導軌磨耗:偏擺變大、振動升,
    最後咬死 → 設備 fault。
  · die_wear(指標,linear)→ 鍛模磨耗 → 鍛件尺寸長高(充填不足)→ 欠肉不良(品質題)。
  · descaler_clog(指標,linear)→ 高壓除鱗噴嘴堵塞 → 氧化皮沒除乾淨被壓進表面 →
    壓入氧化皮不良(品質題,對症是**清洗噴嘴**不是換模具)。

兩條品質線的分辨點:欠肉跟**鍛造噸位**走(壓不足),壓入氧化皮跟**除鱗壓力**走。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 30.0
STROKE_S = 12.0             # 一次鍛打循環(sim 秒)
NOM_TONNAGE = 1600.0        # 額定鍛造噸位
DIE_PREHEAT_C = 260.0       # 鍛模預熱溫度
DESCALE_NOM_BAR = 180.0     # 除鱗水壓

_TAG_SPEC = [
    ("state",            "enum",   "int16"),
    ("ram_position",     "mm",     "float32"),   # ★ 滑塊位置(0 = 上死點,-180 = 下死點)
    ("forging_tonnage",  "ton",    "float32"),   # ★ 鍛造噸位(與 ram 下死點同相)
    ("die_temp",         "degC",   "float32"),   # 鍛模溫度
    ("billet_temp_in",   "degC",   "float32"),   # 入料棒料溫度(上游感應加熱爐給的)
    ("descale_pressure", "bar",    "float32"),   # ★ 除鱗水壓(噴嘴堵 → 掉)
    ("ram_deviation",    "mm",     "float32"),   # ★ 滑塊偏擺(導軌磨耗主指標)
    ("stroke_rate",      "spm",    "float32"),
    ("underfill_rate",   "%",      "float32"),   # ★ 欠肉率(模具磨耗 → 升)
    ("scale_defect_rate", "%",     "float32"),   # ★ 壓入氧化皮率(除鱗不良 → 升)
    ("vibration_rms",    "mm/s",   "float32"),
    ("forge_count",      "count",  "int32"),
]
_INDICATORS = {"die_wear", "descaler_clog"}
_DEFAULT_DEGRADATION = {
    "ram_guide_wear": {"rate": 0.0000011, "trajectory": "exponential", "k": 2.9, "sigma": 0.1, "init_health": 0.93},
    "die_wear": {"rate": 0.0000017, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    "descaler_clog": {"rate": 0.0000015, "trajectory": "linear", "sigma": 0.14, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 88.0))
    rated = float(cfg.get("tonnage", NOM_TONNAGE))

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
    die_lag = ThermalLag(tau_sim_s=1500.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "ph": 0.0, "forges": 0.0}

    STROKE_MM = 180.0

    def _cycle(h_guide: float) -> float:
        return STROKE_S + (1.0 - h_guide) * 4.5     # 導軌磨耗 → 節拍變慢

    def pre_step(dt_sim, op):
        h_g = health_of(comp_map, "ram_guide_wear")
        if op["running"] and not device._fault_latched and dt_sim > 0.0:
            st["t"] += dt_sim
            st["forges"] += dt_sim / _cycle(h_g)
        st["ph"] = (st["t"] % _cycle(h_g)) / _cycle(h_g)

    def _ram_mm() -> float:
        """滑塊行程:0(上死點)→ -180(下死點)→ 0。cos 曲線,下死點在相位 0.5。"""
        return -STROKE_MM * 0.5 * (1.0 - math.cos(st["ph"] * 2.0 * math.pi))

    def drv_ram(op, c, dt):
        return (_ram_mm() if op["running"] else 0.0) + gaussian_noise(nrng, 0.15)

    def drv_tonnage(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 1.5)
        # 噸位尖峰**與下死點同相**(相位 0.5 附近才吃力)。模具磨耗 → 充填不足 → 尖峰略降。
        h_die = health_of(comp_map, "die_wear")
        depth = max(0.0, -_ram_mm() / STROKE_MM)          # 0..1
        peak = rated * (0.88 + 0.12 * h_die)
        return peak * (depth ** 3.2) + gaussian_noise(nrng, 4.0)

    def drv_die_temp(op, c, dt):
        target = (DIE_PREHEAT_C + 95.0) if op["running"] else DIE_PREHEAT_C * 0.35
        return die_lag.update(target, dt) + gaussian_noise(nrng, 1.5)

    def drv_billet_in(op, c, dt):
        # 入料棒料溫度:上游感應加熱爐的出料。單機時給額定值 + 雜訊(接了產線由情境決定分散)
        return (1175.0 if op["running"] else AMBIENT_C) + gaussian_noise(nrng, 12.0)

    def _descale_bar(comps) -> float:
        h_noz = health_of(comp_map, "descaler_clog")
        return DESCALE_NOM_BAR * (0.42 + 0.58 * h_noz)      # 堵塞 → 壓力掉

    def drv_descale(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.5)
        # 除鱗只在合模前的短暫相位噴(0.1~0.22)
        if 0.10 <= st["ph"] < 0.22:
            return max(0.0, _descale_bar(c) + gaussian_noise(nrng, 1.5))
        return 6.0 + gaussian_noise(nrng, 0.4)

    def drv_deviation(op, c, dt):
        h_g = health_of(comp_map, "ram_guide_wear")
        base = 0.04 if op["running"] else 0.01
        return max(0.0, base + 1.6 * (1.0 - h_g) ** 1.7 + gaussian_noise(nrng, 0.006))

    def drv_stroke_rate(op, c, dt):
        h_g = health_of(comp_map, "ram_guide_wear")
        # spm = 每分鐘打擊次數 = 60 / 單次循環秒數(12 s → 5 spm,熱模鍛的合理量級)
        return (60.0 / _cycle(h_g) if op["running"] else 0.0) + gaussian_noise(nrng, 0.02)

    def _underfill(comps) -> float:
        h_die = health_of(comp_map, "die_wear")
        return 0.4 + 8.5 * (1.0 - h_die) ** 1.3

    def _scale_defect(comps) -> float:
        h_noz = health_of(comp_map, "descaler_clog")
        return 0.3 + 9.5 * (1.0 - h_noz) ** 1.35

    def drv_underfill(op, c, dt):
        return max(0.0, _underfill(c) + gaussian_noise(nrng, 0.06)) if op["running"] else 0.0

    def drv_scale_defect(op, c, dt):
        return max(0.0, _scale_defect(c) + gaussian_noise(nrng, 0.06)) if op["running"] else 0.0

    def drv_vib(op, c, dt):
        h_g = health_of(comp_map, "ram_guide_wear")
        base = 2.4 if op["running"] else 0.2
        return max(0.0, base + 11.0 * (1.0 - h_g) ** 1.8 + gaussian_noise(nrng, 0.08))

    def drv_forges(op, c, dt):
        return int(st["forges"])

    tag_by_name["ram_position"].driver = drv_ram
    tag_by_name["forging_tonnage"].driver = drv_tonnage
    tag_by_name["die_temp"].driver = drv_die_temp
    tag_by_name["billet_temp_in"].driver = drv_billet_in
    tag_by_name["descale_pressure"].driver = drv_descale
    tag_by_name["ram_deviation"].driver = drv_deviation
    tag_by_name["stroke_rate"].driver = drv_stroke_rate
    tag_by_name["underfill_rate"].driver = drv_underfill
    tag_by_name["scale_defect_rate"].driver = drv_scale_defect
    tag_by_name["vibration_rms"].driver = drv_vib
    tag_by_name["forge_count"].driver = drv_forges

    def oee_fn(op, comps):
        h_g = health_of(comps, "ram_guide_wear")
        perf = STROKE_S / _cycle(h_g)
        bad = _underfill(comps) + _scale_defect(comps)
        return perf, float(np.clip(1.0 - bad / 34.0, 0.5, 1.0))

    def quality_fn(op, comps, tag_by):
        """欠肉與壓入氧化皮兩種不良獨立疊加,對症不同:
        欠肉 → 換 / 修鍛模;壓入氧化皮 → 清除鱗噴嘴(不是換模具)。"""
        if not op["running"]:
            return 0.0, "underfill"
        p_uf = min(0.9, _underfill(comps) / 100.0)
        p_sc = min(0.9, _scale_defect(comps) / 100.0)
        p = p_uf + (1.0 - p_uf) * p_sc
        return p, ("underfill" if p_uf >= p_sc else "scale_pressed_in")

    device = Device(
        device_id=device_id, template="forging_press", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
