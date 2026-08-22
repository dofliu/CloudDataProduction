"""零件組裝機 template(手工具製程第 8 站:鍍好的本體 + 外購件 → 壓入 / 鎖付成成品)。

棘輪扳手要壓入棘輪組、鎖上背蓋;起子要壓入握把。這一站是整條產線上**唯一
會「缺件」的站** —— 它同時吃兩種料:自家上游來的本體,與外購的小零件。

  · press_actuator_wear(本體,exponential)→ 壓入伺服機構磨耗 → 振動升、
    壓入行程不穩,最後咬死 → 設備 fault。
  · feeder_jam(指標,linear)→ 振動盤 / 給料軌卡料 → 給料成功率掉 → 缺件
    (品質題)。清一清就好,不是換件。
  · screwdriver_torque_drift(指標,linear)→ 電動起子扭力衰退 → 鎖付扭力不足
    → 背蓋鬆動(品質題)。

壓入曲線是本站的教學核心:`press_force` 與 `press_depth` 兩支一起看才有意義 ——
**同樣的最終深度,力的曲線不一樣就代表壓錯了**(零件歪了 / 少一個墊片)。
只看單一支訊號永遠看不出來,這是「多變量」比「單變量」強的最直觀例子。
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

CYCLE_S = 14.0            # 一件組裝循環(sim 秒)
PRESS_DEPTH_MM = 24.0     # 壓入行程(mm)
NOM_PRESS_FORCE = 18.5    # 額定壓入力峰值(kN)
NOM_SCREW_NM = 9.0        # 背蓋鎖付標稱扭力(N·m)
SCREW_SPEC_MIN_NM = 7.2   # 鎖付扭力下限(低於即不良)

_TAG_SPEC = [
    ("state",            "enum",  "int16"),
    ("press_depth",      "mm",    "float32"),   # ★ 壓入位移(0 → 24,機構位置)
    ("press_force",      "kN",    "float32"),   # ★ 壓入力(與位移合看才判得出壓錯)
    ("screw_torque",     "Nm",    "float32"),   # ★ 鎖付扭力(起子衰退 → 掉)
    ("feed_success",     "%",     "float32"),   # ★ 給料成功率(卡料 → 掉)
    ("feeder_level",     "%",     "float32"),   # ★ 料倉存量(消耗與補料看得見)
    ("missing_rate",     "%",     "float32"),   # ★ 缺件率(品質結果)
    ("actuator_current", "A",     "float32"),
    ("cycle_time",       "s",     "float32"),
    ("vibration_rms",    "mm/s",  "float32"),
    ("assembled_count",  "count", "int32"),
]
_INDICATORS = {"feeder_jam", "screwdriver_torque_drift"}
_DEFAULT_DEGRADATION = {
    "press_actuator_wear": {"rate": 0.0000011, "trajectory": "exponential", "k": 2.8, "sigma": 0.1, "init_health": 0.95},
    "feeder_jam": {"rate": 0.0000024, "trajectory": "linear", "sigma": 0.16, "init_health": 1.0, "causes_device_fault": False},
    "screwdriver_torque_drift": {"rate": 0.0000018, "trajectory": "linear", "sigma": 0.13, "init_health": 1.0, "causes_device_fault": False},
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
    st = {"t": 0.0, "ph": 0.0, "parts": 0.0}

    def _cycle(h_act: float, h_feed: float) -> float:
        # 機構磨耗 → 動作變慢;卡料 → 要重試 → 節拍也拉長
        return CYCLE_S * (1.0 + 0.24 * (1.0 - h_act) + 0.20 * (1.0 - h_feed))

    def pre_step(dt_sim, op):
        h_a = health_of(comp_map, "press_actuator_wear")
        h_f = health_of(comp_map, "feeder_jam")
        cyc = _cycle(h_a, h_f)
        if op["running"] and not device._fault_latched and dt_sim > 0.0:
            st["t"] += dt_sim
            st["parts"] += dt_sim / cyc
        st["ph"] = (st["t"] % cyc) / cyc

    def _depth_mm() -> float:
        """壓入相位:0–45% 下壓、45–60% 保壓、60–75% 回程、之後換件。
        用 smoothstep 而非線性 —— 伺服壓機的實際速度曲線是有加減速的。"""
        p = st["ph"]
        if p < 0.45:
            x = p / 0.45
            return PRESS_DEPTH_MM * (x * x * (3.0 - 2.0 * x))
        if p < 0.60:
            return PRESS_DEPTH_MM
        if p < 0.75:
            x = (p - 0.60) / 0.15
            return PRESS_DEPTH_MM * (1.0 - x * x * (3.0 - 2.0 * x))
        return 0.0

    def drv_depth(op, c, dt):
        return (_depth_mm() if op["running"] else 0.0) + gaussian_noise(nrng, 0.02)

    def _force_peak(comps) -> float:
        h_a = health_of(comp_map, "press_actuator_wear")
        # 機構磨耗 → 導引不正 → 同樣的壓入要更大的力(摩擦增加)
        return NOM_PRESS_FORCE * (1.0 + 0.38 * (1.0 - h_a) ** 1.3)

    def drv_force(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.03)
        d = _depth_mm() / PRESS_DEPTH_MM
        # 壓入力隨深度非線性上升(壓配的干涉量越壓越緊),保壓段維持峰值
        return _force_peak(c) * (d ** 2.2) + gaussian_noise(nrng, 0.09)

    def _screw_nm(comps) -> float:
        h_s = health_of(comp_map, "screwdriver_torque_drift")
        return NOM_SCREW_NM * (0.68 + 0.32 * h_s)

    def drv_screw(op, c, dt):
        if not op["running"] or st["ph"] < 0.60 or st["ph"] > 0.88:
            return 0.0
        return max(0.0, _screw_nm(c) + gaussian_noise(nrng, 0.06))

    def _feed_pct(comps) -> float:
        h_f = health_of(comp_map, "feeder_jam")
        return 100.0 * (0.55 + 0.45 * h_f) if h_f < 1.0 else 99.6

    def drv_feed(op, c, dt):
        return float(np.clip(_feed_pct(c) + gaussian_noise(nrng, 0.25), 0.0, 100.0)) if op["running"] else 0.0

    def drv_level(op, c, dt):
        # 料倉:每 400 件補一次(鋸齒),讓學生看得到「補料」這件事在資料上長什麼樣
        cycle_parts = st["parts"] % 400.0
        return float(np.clip(100.0 - cycle_parts / 4.0, 6.0, 100.0)) + gaussian_noise(nrng, 0.15)

    def _missing_pct(comps) -> float:
        h_f = health_of(comp_map, "feeder_jam")
        return 0.15 + 8.5 * (1.0 - h_f) ** 1.6

    def drv_missing(op, c, dt):
        return max(0.0, _missing_pct(c) + gaussian_noise(nrng, 0.05)) if op["running"] else 0.0

    def drv_current(op, c, dt):
        if not op["running"]:
            return 0.6 + gaussian_noise(nrng, 0.03)
        d = _depth_mm() / PRESS_DEPTH_MM
        h_a = health_of(comp_map, "press_actuator_wear")
        return (2.4 + 9.2 * (d ** 2.0) * (1.0 + 0.45 * (1.0 - h_a))
                + gaussian_noise(nrng, 0.08))

    def drv_cycle(op, c, dt):
        return _cycle(health_of(comp_map, "press_actuator_wear"),
                      health_of(comp_map, "feeder_jam")) + gaussian_noise(nrng, 0.07)

    def drv_vib(op, c, dt):
        h_a = health_of(comp_map, "press_actuator_wear")
        base = 0.8 if op["running"] else 0.09
        return max(0.0, base + 7.2 * (1.0 - h_a) ** 1.85 + gaussian_noise(nrng, 0.05))

    def drv_parts(op, c, dt):
        return int(st["parts"])

    tag_by_name["press_depth"].driver = drv_depth
    tag_by_name["press_force"].driver = drv_force
    tag_by_name["screw_torque"].driver = drv_screw
    tag_by_name["feed_success"].driver = drv_feed
    tag_by_name["feeder_level"].driver = drv_level
    tag_by_name["missing_rate"].driver = drv_missing
    tag_by_name["actuator_current"].driver = drv_current
    tag_by_name["cycle_time"].driver = drv_cycle
    tag_by_name["vibration_rms"].driver = drv_vib
    tag_by_name["assembled_count"].driver = drv_parts

    def oee_fn(op, comps):
        h_a = health_of(comps, "press_actuator_wear")
        h_f = health_of(comps, "feeder_jam")
        perf = CYCLE_S / _cycle(h_a, h_f)
        q_miss = np.clip(1.0 - _missing_pct(comps) / 26.0, 0.5, 1.0)
        short = max(0.0, SCREW_SPEC_MIN_NM - _screw_nm(comps))
        q_screw = np.clip(1.0 - short / 2.6, 0.5, 1.0)
        return perf, float(min(q_miss, q_screw))

    def quality_fn(op, comps, tag_by):
        """兩種不良,兩種處置:
          · missing_component:給料卡住 → 少一個零件。對症是**清卡料**,不是換伺服。
          · screw_under_torque:背蓋鎖不緊。對症是**換 / 校電動起子**。
        兩者都與同名觀測訊號(missing_rate / screw_torque)同一條式子重算。"""
        if not op["running"]:
            return 0.0, "missing_component"
        p_miss = min(0.85, _missing_pct(comps) / 100.0)
        short = max(0.0, SCREW_SPEC_MIN_NM - _screw_nm(comps))
        p_screw = min(0.80, short / (NOM_SCREW_NM * 0.30))
        p = p_miss + (1.0 - p_miss) * p_screw
        return max(0.004, p), ("missing_component" if p_miss >= p_screw else "screw_under_torque")

    device = Device(
        device_id=device_id, template="assembly_station", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
