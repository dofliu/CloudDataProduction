"""毛胚整修機 template(手工具製程第 4 站:鍛胚 → 切邊去飛邊)。

鍛造出來的胚料四周有一圈飛邊(flash),要用切邊模沖掉。看似簡單的一站,卻是
**刀口狀態直接寫在產品上**的典型:刀口一鈍,切不斷的飛邊就變成毛刺留在工件上。
三條退化線:

  · slide_bearing_wear(本體,exponential)→ 滑塊軸承磨耗 → 振動升、行程不穩,
    最後咬死 → 設備 fault。
  · trim_die_edge(指標,linear)→ 切邊刀口鈍化 → 切斷力上升、殘毛刺高度變高(品質題)。
  · ejector_wear(指標,linear)→ 頂出機構磨耗 → 工件頂不乾淨、偶發變形(品質題)。

刀口鈍化的可觀測性刻意做成**兩支相關訊號**:切斷力(trim_force)先升,
殘毛刺(burr_height)後升 —— 學生可以練「哪個指標先動」。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

CYCLE_S = 9.0             # 一次切邊循環(sim 秒)
STROKE_MM = 90.0
NOM_TRIM_FORCE = 220.0    # 額定切斷力(ton)
BURR_SPEC_MM = 0.15       # 殘毛刺規格上限(超過即不良)

_TAG_SPEC = [
    ("state",          "enum",  "int16"),
    ("slide_position", "mm",    "float32"),   # ★ 滑塊位置(0 上死點 → -90 下死點)
    ("trim_force",     "ton",   "float32"),   # ★ 切斷力(刀口鈍 → 升,先動的指標)
    ("burr_height",    "mm",    "float32"),   # ★ 殘毛刺高度(刀口鈍 → 升,後動的指標)
    ("ejector_stroke", "mm",    "float32"),   # 頂出行程(磨耗 → 頂不到位)
    ("motor_current",  "A",     "float32"),
    ("cycle_time",     "s",     "float32"),
    ("deform_rate",    "%",     "float32"),   # ★ 變形不良率(頂出磨耗 → 升)
    ("vibration_rms",  "mm/s",  "float32"),
    ("trim_count",     "count", "int32"),
]
_INDICATORS = {"trim_die_edge", "ejector_wear"}
_DEFAULT_DEGRADATION = {
    "slide_bearing_wear": {"rate": 0.0000012, "trajectory": "exponential", "k": 2.8, "sigma": 0.1, "init_health": 0.94},
    "trim_die_edge": {"rate": 0.0000018, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    "ejector_wear": {"rate": 0.0000012, "trajectory": "linear", "sigma": 0.13, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 75.0))

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
    st = {"t": 0.0, "ph": 0.0, "trims": 0.0}

    def _cycle(h_bear: float) -> float:
        return CYCLE_S + (1.0 - h_bear) * 3.0

    def pre_step(dt_sim, op):
        h_b = health_of(comp_map, "slide_bearing_wear")
        if op["running"] and not device._fault_latched and dt_sim > 0.0:
            st["t"] += dt_sim
            st["trims"] += dt_sim / _cycle(h_b)
        st["ph"] = (st["t"] % _cycle(h_b)) / _cycle(h_b)

    def _slide_mm() -> float:
        return -STROKE_MM * 0.5 * (1.0 - math.cos(st["ph"] * 2.0 * math.pi))

    def drv_slide(op, c, dt):
        return (_slide_mm() if op["running"] else 0.0) + gaussian_noise(nrng, 0.08)

    def _force_peak(comps) -> float:
        h_edge = health_of(comp_map, "trim_die_edge")
        # 刀口鈍 → 切斷力上升(這是**先動**的指標,比毛刺早看得出來)
        return NOM_TRIM_FORCE * (1.0 + 0.55 * (1.0 - h_edge) ** 1.15)

    def drv_force(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.4)
        depth = max(0.0, -_slide_mm() / STROKE_MM)
        return _force_peak(c) * (depth ** 3.0) + gaussian_noise(nrng, 0.8)

    def _burr_mm(comps) -> float:
        h_edge = health_of(comp_map, "trim_die_edge")
        # 毛刺是**後動**的:刀口鈍到一定程度才開始留下切不斷的殘料(指數 1.9 → 前期平緩)
        return 0.02 + 0.42 * (1.0 - h_edge) ** 1.9

    def drv_burr(op, c, dt):
        return max(0.0, _burr_mm(c) + gaussian_noise(nrng, 0.004)) if op["running"] else 0.0

    def drv_ejector(op, c, dt):
        h_ej = health_of(comp_map, "ejector_wear")
        nom = 25.0
        return (nom * (0.72 + 0.28 * h_ej) if op["running"] else 0.0) + gaussian_noise(nrng, 0.06)

    def drv_current(op, c, dt):
        if not op["running"]:
            return 1.1 + gaussian_noise(nrng, 0.05)
        depth = max(0.0, -_slide_mm() / STROKE_MM)
        h_edge = health_of(comp_map, "trim_die_edge")
        return 6.0 + 26.0 * (depth ** 2.6) * (1.0 + 0.5 * (1.0 - h_edge)) + gaussian_noise(nrng, 0.12)

    def drv_cycle(op, c, dt):
        return _cycle(health_of(comp_map, "slide_bearing_wear")) + gaussian_noise(nrng, 0.05)

    def _deform(comps) -> float:
        h_ej = health_of(comp_map, "ejector_wear")
        return 0.25 + 6.0 * (1.0 - h_ej) ** 1.4

    def drv_deform(op, c, dt):
        return max(0.0, _deform(c) + gaussian_noise(nrng, 0.05)) if op["running"] else 0.0

    def drv_vib(op, c, dt):
        h_b = health_of(comp_map, "slide_bearing_wear")
        base = 1.4 if op["running"] else 0.12
        return max(0.0, base + 9.5 * (1.0 - h_b) ** 1.8 + gaussian_noise(nrng, 0.06))

    def drv_trims(op, c, dt):
        return int(st["trims"])

    tag_by_name["slide_position"].driver = drv_slide
    tag_by_name["trim_force"].driver = drv_force
    tag_by_name["burr_height"].driver = drv_burr
    tag_by_name["ejector_stroke"].driver = drv_ejector
    tag_by_name["motor_current"].driver = drv_current
    tag_by_name["cycle_time"].driver = drv_cycle
    tag_by_name["deform_rate"].driver = drv_deform
    tag_by_name["vibration_rms"].driver = drv_vib
    tag_by_name["trim_count"].driver = drv_trims

    def oee_fn(op, comps):
        h_b = health_of(comps, "slide_bearing_wear")
        perf = CYCLE_S / _cycle(h_b)
        over = max(0.0, _burr_mm(comps) - BURR_SPEC_MM)
        q_burr = np.clip(1.0 - over / 0.35, 0.5, 1.0)
        q_def = np.clip(1.0 - _deform(comps) / 22.0, 0.5, 1.0)
        return perf, float(min(q_burr, q_def))

    def quality_fn(op, comps, tag_by):
        """殘毛刺超規 + 頂出變形。毛刺超規的判定與 burr_height 同一條式子重算 ——
        學生量到 burr_height 就能推不良率,不必猜。"""
        if not op["running"]:
            return 0.0, "burr_over_spec"
        over = max(0.0, _burr_mm(comps) - BURR_SPEC_MM * 0.8)
        p_burr = min(0.92, over / (BURR_SPEC_MM * 1.4))
        p_def = min(0.6, _deform(comps) / 100.0)
        p = p_burr + (1.0 - p_burr) * p_def
        return max(0.004, p), ("burr_over_spec" if p_burr >= p_def else "ejector_deform")

    device = Device(
        device_id=device_id, template="trimming_press", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
