"""包裝機 template(產線終站:封口 / 裝箱出貨)。

封口鉗一開一合封一包,工件進來、成品包出去,天生是產線的最後一站。三條故障線:
  · sealer_heater_aging(本體,exponential)→ 封口加熱器老化:封口溫度到不了設定點
    → 不良率升,元件燒斷 → 設備 fault(與熱處理爐同款「到不了設定點」語彙,不同尺度)。
  · film_feed_wear(指標,linear)→ 膜料進給機構磨損:膜張力波動變大 → 皺摺 / 偏位。
  · cutter_blade_wear(指標,linear)→ 切刀鈍化:切口毛邊 → 不良率的另一條獨立徵兆
    (學生要靠 seal_temp 與 film_tension 分離三個根因)。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 27.0
CYCLE_S = 15.0         # 一包的節拍(sim 秒)。刻意 > 預設 dt_sim(12s):
                       # 產線記帳一拍最多一件完工,入料消耗才對得上(engine/line.py)
JAW_OPEN_MM = 80.0     # 封口鉗全開行程(mm);jaw_gap = 40·(1+cos ph):0 = 閉合封口
SEAL_SET_C = 145.0     # 封口溫度設定點
NOM_TENSION = 45.0     # 膜張力(N)

_TAG_SPEC = [
    ("state",          "enum",  "int16"),
    ("jaw_gap",        "mm",    "float32"),   # 封口鉗開度(80 全開 → 0 閉合封口,循環)
    ("seal_temp",      "degC",  "float32"),    # ★ 封口溫度(heater 老化 → 到不了設定點)
    ("film_tension",   "N",     "float32"),    # ★ 膜張力(film_feed_wear → 波動變大)
    ("index_rate",     "ppm",   "float32"),    # 每分鐘包數(節拍的倒數,學生好讀)
    ("cycle_time",     "s",     "float32"),    # 單包節拍(產線 KPI 用)
    ("reject_rate",    "%",     "float32"),     # ★ 封口不良率(品質指標)
    ("motor_current",  "A",     "float32"),
    ("vibration_rms",  "mm/s",  "float32"),
    ("package_count",  "count", "int32"),
]
_INDICATORS = {"film_feed_wear", "cutter_blade_wear"}
_DEFAULT_DEGRADATION = {
    "sealer_heater_aging": {"rate": 0.0000009, "trajectory": "exponential", "k": 2.8, "sigma": 0.1, "init_health": 0.94},
    "film_feed_wear": {"rate": 0.0000015, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    "cutter_blade_wear": {"rate": 0.0000013, "trajectory": "linear", "sigma": 0.12, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 85.0))

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
    seal_lag = ThermalLag(tau_sim_s=600.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "packs": 0.0, "ph": 0.0}

    def _cycle(h_heater: float) -> float:
        # 加熱器弱 → 封口段要壓久一點才封得牢,節拍變長
        return CYCLE_S + (1.0 - h_heater) * 4.0

    def pre_step(dt_sim, op):
        if op["running"] and not device._fault_latched:
            st["t"] += dt_sim
            st["packs"] += dt_sim / _cycle(health_of(comp_map, "sealer_heater_aging"))
        st["ph"] = (st["t"] % CYCLE_S) / CYCLE_S * 2 * math.pi   # 封口循環相位

    def drv_jaw(op, c, dt):
        if not op["running"]:
            return JAW_OPEN_MM                        # 待機時全開(安全位置)
        # 封口鉗開度 = 40·(1+cos ph):ph=0 全開 80、ph=π 閉合 0(封口壓合點)
        return (JAW_OPEN_MM / 2.0) * (1.0 + math.cos(st["ph"])) + gaussian_noise(nrng, 0.3)

    def drv_seal_temp(op, c, dt):
        h_heat = health_of(comp_map, "sealer_heater_aging")
        target = (SEAL_SET_C - 45.0 * (1.0 - h_heat)) if op["running"] else AMBIENT_C
        return seal_lag.update(target, dt) + gaussian_noise(nrng, 0.6)

    def drv_tension(op, c, dt):
        if not op["running"]:
            return 0.0
        h_feed = health_of(comp_map, "film_feed_wear")
        wobble = 14.0 * (1.0 - h_feed) * math.sin(st["t"] * 2.3)   # 進給打滑 → 張力低頻晃動
        return max(0.0, NOM_TENSION + wobble + gaussian_noise(nrng, 0.6))

    def drv_index(op, c, dt):
        if not op["running"]:
            return 0.0
        return 60.0 / _cycle(health_of(comp_map, "sealer_heater_aging")) + gaussian_noise(nrng, 0.08)

    def drv_cycle(op, c, dt):
        return _cycle(health_of(comp_map, "sealer_heater_aging")) + gaussian_noise(nrng, 0.05)

    def drv_reject(op, c, dt):
        if not op["running"]:
            return 0.0
        h_heat = health_of(comp_map, "sealer_heater_aging")
        h_feed = health_of(comp_map, "film_feed_wear")
        h_blade = health_of(comp_map, "cutter_blade_wear")
        return max(0.0, 0.4 + 9.0 * (1.0 - h_heat) ** 1.4 + 6.0 * (1.0 - h_feed) ** 1.3
                   + 5.0 * (1.0 - h_blade) ** 1.3 + abs(gaussian_noise(nrng, 0.1)))

    def drv_current(op, c, dt):
        if not op["running"]:
            return 0.3 + abs(gaussian_noise(nrng, 0.03))
        h_heat = health_of(comp_map, "sealer_heater_aging")
        # 加熱器老化(電阻升)→ 元件電流升;疊上封口段的功率脈動
        pulse = 1.2 * max(0.0, -math.cos(st["ph"]))   # 閉合壓封時最大
        return 6.5 + 2.5 * (1.0 - h_heat) + pulse + gaussian_noise(nrng, 0.12)

    def drv_vibration(op, c, dt):
        if not op["running"]:
            return 0.1 + abs(gaussian_noise(nrng, 0.02))
        h_feed = health_of(comp_map, "film_feed_wear")
        return 0.4 + 6.0 * (1.0 - h_feed) ** 1.6 + abs(gaussian_noise(nrng, 0.07))

    def drv_count(op, c, dt):
        return int(st["packs"])

    tag_by_name["jaw_gap"].driver = drv_jaw
    tag_by_name["seal_temp"].driver = drv_seal_temp
    tag_by_name["film_tension"].driver = drv_tension
    tag_by_name["index_rate"].driver = drv_index
    tag_by_name["cycle_time"].driver = drv_cycle
    tag_by_name["reject_rate"].driver = drv_reject
    tag_by_name["motor_current"].driver = drv_current
    tag_by_name["vibration_rms"].driver = drv_vibration
    tag_by_name["package_count"].driver = drv_count

    def oee_fn(op, comps):
        h_heat = health_of(comps, "sealer_heater_aging")
        perf = CYCLE_S / _cycle(h_heat)
        rj = 0.4 + 9.0 * (1.0 - h_heat) ** 1.4 \
             + 6.0 * (1.0 - health_of(comps, "film_feed_wear")) ** 1.3 \
             + 5.0 * (1.0 - health_of(comps, "cutter_blade_wear")) ** 1.3
        return perf, float(np.clip(1.0 - rj / 30.0, 0.5, 1.0))

    device = Device(
        device_id=device_id, template="packaging_machine", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
