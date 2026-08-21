"""熔煉爐 template(鑄造廠的第一站:金屬熔解 → 逐籃出湯)。

鑄造廠的上游素材設備。與熱處理爐同為「熱設備」但語彙不同尺度:熱處理是 900 °C 保溫,
熔煉是 1450 °C 熔解並**週期性出湯**(每一爐 = 一批,不是連續流)。三條退化線:

  · refractory_wear(本體,exponential)→ 耐火爐襯磨蝕:爐壁溫升、熱損increase,
    最後爐襯破損 → 設備 fault(真實鑄造廠最貴的一次停機)。
  · electrode_wear(指標,linear)→ 電極消耗 → 電流不穩、熔解時間拉長(產能題)。
  · slag_buildup(指標,linear)→ 爐渣堆積 → 熔湯純度下降(含渣量升)→ 鑄件夾渣不良(品質題)。

節拍 melt_cycle_time = 出一籃湯的秒數;tap_count = 出湯籃數(產線帳本用的累積量)。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 30.0
MELT_SETPOINT_C = 1450.0    # 熔湯目標溫度(鋁合金 / 中碳鋼視配方,此處取通用中溫)
# 一次「出湯」的 sim 秒數。計量單位刻意取**一料籃(一模份)**而不是「一整爐」:
# 產線帳本是 1:1 傳遞的(engine/line.py),若一爐出湯只算一件,下游壓鑄機就會被
# 餓到利用率 2%,看起來像壞掉 —— 那不是誠實的產線,是模型單位選錯。
# 真實鑄造廠也是連續保溫 + 逐籃取湯供機,不是一爐等一模。
MELT_CYCLE_S = 72.0
TAP_FRAC = 0.88             # 循環中 88% 之後進入出湯段(爐體傾轉)

_TAG_SPEC = [
    ("state",             "enum",   "int16"),
    ("melt_temp",         "degC",   "float32"),   # 熔湯溫度(爐襯劣化 → 到不了設定點)
    ("shell_temp",        "degC",   "float32"),   # ★ 爐殼外壁溫(refractory_wear 主指標:爐襯薄 → 外壁燙)
    ("power_input",       "kW",     "float32"),
    ("electrode_current", "A",      "float32"),   # ★ electrode_wear → 電流波動變大
    ("tilt_angle",        "deg",    "float32"),   # 出湯傾轉角(0 = 直立,-45 = 出湯中)
    ("bath_level",        "%",      "float32"),   # 爐內熔湯液位(出湯時下降)
    ("slag_ratio",        "%",      "float32"),   # ★ slag_buildup → 含渣量(品質指標)
    ("melt_cycle_time",   "s",      "float32"),
    ("energy_kwh",        "kWh",    "int32"),
    ("tap_count",         "count",  "int32"),     # 出湯爐次(產線累積量)
]
_INDICATORS = {"electrode_wear", "slag_buildup"}
_DEFAULT_DEGRADATION = {
    "refractory_wear": {"rate": 0.0000008, "trajectory": "exponential", "k": 2.8, "sigma": 0.09, "init_health": 0.93},
    "electrode_wear": {"rate": 0.0000015, "trajectory": "linear", "sigma": 0.14, "init_health": 1.0, "causes_device_fault": False},
    "slag_buildup": {"rate": 0.0000012, "trajectory": "linear", "sigma": 0.13, "init_health": 1.0, "causes_device_fault": False},
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
    melt_lag = ThermalLag(tau_sim_s=2200.0, init_temp=AMBIENT_C)
    shell_lag = ThermalLag(tau_sim_s=3000.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "ph": 0.0, "taps": 0.0, "energy": 0.0}

    def _cycle(h_elec: float) -> float:
        # 電極消耗 → 輸入功率打折 → 熔解時間拉長
        return MELT_CYCLE_S + (1.0 - h_elec) * 260.0

    def _power(op) -> float:
        if not op["running"]:
            return 12.0
        h_ref = health_of(comp_map, "refractory_wear")
        # 爐襯薄 → 熱損大 → 要更多功率才維持得住熔湯溫度
        return 520.0 + 180.0 * (1.0 - h_ref)

    def pre_step(dt_sim, op):
        if op["running"] and not device._fault_latched and dt_sim > 0.0:
            st["t"] += dt_sim
            st["taps"] += dt_sim / _cycle(health_of(comp_map, "electrode_wear"))
            st["energy"] += _power(op) * dt_sim / 3600.0
        st["ph"] = (st["t"] % _cycle(health_of(comp_map, "electrode_wear"))) / \
            _cycle(health_of(comp_map, "electrode_wear"))

    def drv_melt_temp(op, c, dt):
        h_ref = health_of(comp_map, "refractory_wear")
        target = (MELT_SETPOINT_C - 70.0 * (1.0 - h_ref)) if op["running"] else AMBIENT_C
        return melt_lag.update(target, dt) + gaussian_noise(nrng, 3.0)

    def drv_shell_temp(op, c, dt):
        # 爐襯磨蝕 = 隔熱層變薄 → 外壁溫度上升。這是現場最直接的「爐襯該換了」指標。
        h_ref = health_of(comp_map, "refractory_wear")
        target = AMBIENT_C + (95.0 + 130.0 * (1.0 - h_ref) ** 1.4 if op["running"] else 8.0)
        return shell_lag.update(target, dt) + gaussian_noise(nrng, 1.2)

    def drv_power(op, c, dt):
        return _power(op) + gaussian_noise(nrng, 4.0)

    def drv_electrode_current(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 2.0)
        h_e = health_of(comp_map, "electrode_wear")
        # 電極磨耗 → 弧長不穩 → 電流在額定附近震盪幅度變大(不是均值偏移,是變異數變大)
        ripple = (6.0 + 55.0 * (1.0 - h_e) ** 1.3) * math.sin(st["t"] / 7.0)
        return max(0.0, 780.0 + ripple + gaussian_noise(nrng, 3.0))

    def drv_tilt(op, c, dt):
        # 出湯段爐體傾轉:相位 >= TAP_FRAC 時線性倒到 -45°,倒完回正
        if not op["running"]:
            return 0.0
        if st["ph"] < TAP_FRAC:
            return 0.0 + gaussian_noise(nrng, 0.05)
        u = (st["ph"] - TAP_FRAC) / (1.0 - TAP_FRAC)          # 0..1
        return -45.0 * math.sin(u * math.pi) + gaussian_noise(nrng, 0.1)

    def drv_bath_level(op, c, dt):
        if not op["running"]:
            return 0.0
        if st["ph"] < TAP_FRAC:                                # 熔解中:液位緩升(續料)
            return 55.0 + 40.0 * (st["ph"] / TAP_FRAC) + gaussian_noise(nrng, 0.4)
        u = (st["ph"] - TAP_FRAC) / (1.0 - TAP_FRAC)
        return max(0.0, 95.0 * (1.0 - u)) + gaussian_noise(nrng, 0.4)   # 出湯:倒空

    def _slag_pct(comps) -> float:
        h_slag = health_of(comp_map, "slag_buildup")
        return 0.6 + 7.5 * (1.0 - h_slag) ** 1.35

    def drv_slag(op, c, dt):
        if not op["running"]:
            return 0.0
        return max(0.0, _slag_pct(c) + gaussian_noise(nrng, 0.06))

    def drv_cycle(op, c, dt):
        return _cycle(health_of(comp_map, "electrode_wear")) + gaussian_noise(nrng, 2.0)

    def drv_energy(op, c, dt):
        return int(st["energy"])

    def drv_taps(op, c, dt):
        return int(st["taps"])

    tag_by_name["melt_temp"].driver = drv_melt_temp
    tag_by_name["shell_temp"].driver = drv_shell_temp
    tag_by_name["power_input"].driver = drv_power
    tag_by_name["electrode_current"].driver = drv_electrode_current
    tag_by_name["tilt_angle"].driver = drv_tilt
    tag_by_name["bath_level"].driver = drv_bath_level
    tag_by_name["slag_ratio"].driver = drv_slag
    tag_by_name["melt_cycle_time"].driver = drv_cycle
    tag_by_name["energy_kwh"].driver = drv_energy
    tag_by_name["tap_count"].driver = drv_taps

    def oee_fn(op, comps):
        h_e = health_of(comps, "electrode_wear")
        perf = MELT_CYCLE_S / _cycle(h_e)
        # 良率:含渣量越高,下游鑄件夾渣越多
        return perf, float(np.clip(1.0 - _slag_pct(comps) / 22.0, 0.5, 1.0))

    def quality_fn(op, comps, tag_by):
        """一爐熔湯的品質:含渣量即夾渣不良機率(與 slag_ratio 同一條式子重算)。"""
        if not op["running"]:
            return 0.0, "slag_inclusion"
        return min(0.9, max(0.0, _slag_pct(comps) / 100.0)), "slag_inclusion"

    device = Device(
        device_id=device_id, template="melting_furnace", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
