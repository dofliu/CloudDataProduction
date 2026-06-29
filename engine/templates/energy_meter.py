"""電表 / 能源節點 template(docs/03,園區動力 / 能耗分析）。

與其他設備不同:這台「不生產、(幾乎)不退化」,主要當**能耗與異常偵測**素材:
  · 三相電壓 / 電流 / 功率 / 功因隨班表起伏 → 學生畫負載曲線、估能耗、算尖峰。
  · capacitor_aging(指標型,極緩)→ 功因緩慢下滑,給一條輕量、可訓練的退化線索。
  · 「異常耗電」不需新機制:老師對 active_power 注 sensor_bias / drift 即可(見 engine/sensor_faults）。

duty=two_shift:班內高載、離峰待機、週末低載 —— 日 / 週負載結構本身就是好教材。
功率 / 功因 / 電壓在 pre_step 一次算定,三相電流由功率反推,確保三相彼此自洽。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import Device, DutyProfile
from ..signals import gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

NOM_V = 380.0           # 三相線電壓(V)
STANDBY_KW = 30.0       # 待機基載(照明 / 待機設備)
PEAK_KW = 220.0         # 滿載概估(kW)

_TAG_SPEC = [
    ("active_power",  "kW",  "float32"),   # ★ 即時有效功率(異常耗電注在這支）
    ("voltage_l1",    "V",   "float32"),
    ("voltage_l2",    "V",   "float32"),
    ("voltage_l3",    "V",   "float32"),
    ("current_l1",    "A",   "float32"),
    ("current_l2",    "A",   "float32"),
    ("current_l3",    "A",   "float32"),
    ("power_factor",  "",    "float32"),    # capacitor_aging → 緩降
    ("energy_total",  "kWh", "int32"),      # 累積電能(只增)
]
# capacitor_aging 是指標型(不讓電表「故障」);電表本身不會 fault
_INDICATORS = {"capacitor_aging"}
_DEFAULT_DEGRADATION = {
    "capacitor_aging": {"rate": 0.0000006, "trajectory": "linear", "sigma": 0.1, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
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
    st = {"power": STANDBY_KW, "pf": 0.93, "v": NOM_V, "energy": 0.0}

    def pre_step(dt_sim, op):
        h_cap = health_of(comp_map, "capacitor_aging")
        if op["running"]:
            lf = op["load"] / max(1e-6, op["load_nom"])               # 班內負載率
            power = STANDBY_KW + lf * (PEAK_KW - STANDBY_KW)
        else:
            lf = 0.0
            power = STANDBY_KW                                         # 離峰 / 週末待機基載
        # 功因:電容老化拉低,輕載時感性負載也較差
        pf = float(np.clip(0.95 - 0.18 * (1.0 - h_cap) - 0.06 * (1.0 - min(1.0, lf)), 0.60, 0.99))
        st["power"] = power
        st["pf"] = pf
        st["v"] = NOM_V - 5.0 * (power / PEAK_KW)                      # 重載時電壓略降
        if dt_sim > 0.0:
            st["energy"] += power * dt_sim / 3600.0                    # kWh 累積(對 sim 時間)

    def drv_power(op, c, dt):
        return max(0.0, st["power"] + gaussian_noise(nrng, 0.8))

    def mk_voltage(off):
        return lambda op, c, dt: st["v"] + off + gaussian_noise(nrng, 0.4)   # 三相輕微不平衡

    def mk_current(imb):
        def drv(op, c, dt):
            i = (st["power"] * 1000.0) / (math.sqrt(3.0) * st["v"] * max(0.5, st["pf"]))
            return max(0.0, i * imb + gaussian_noise(nrng, 0.3))
        return drv

    def drv_pf(op, c, dt):
        return float(np.clip(st["pf"] + gaussian_noise(nrng, 0.003), 0.5, 1.0))

    def drv_energy(op, c, dt):
        return int(st["energy"])

    tag_by_name["active_power"].driver = drv_power
    for ph, off in zip((1, 2, 3), (0.0, -1.5, 1.2)):
        tag_by_name[f"voltage_l{ph}"].driver = mk_voltage(off)
    for ph, imb in zip((1, 2, 3), (1.0, 0.98, 1.03)):
        tag_by_name[f"current_l{ph}"].driver = mk_current(imb)
    tag_by_name["power_factor"].driver = drv_pf
    tag_by_name["energy_total"].driver = drv_energy

    def oee_fn(op, comps):
        # 能源節點沒有「生產 OEE」;這裡借同一欄位呈現用電效率:負載率 × 功因品質。
        perf = op["load"] / max(1e-6, op["load_nom"])
        qual = float(np.clip(st["pf"] / 0.95, 0.6, 1.0))
        return min(1.0, perf), qual

    device = Device(
        device_id=device_id, template="energy_meter", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, pre_step_fn=pre_step,
    )
    return device
