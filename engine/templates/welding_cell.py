"""焊接機器人工作站 template(金屬加工的接合工站)。

焊槍沿焊道直線行走、電弧熔填,一個循環焊一道。三條故障線:
  · wire_feeder_wear(本體,exponential)→ 送絲輪磨損打滑:送絲率下滑、電弧電流不穩
    (振動式波動),最後送絲失效斷弧 → 設備 fault(經典 PdM:趨勢 + 波動雙徵兆)。
  · nozzle_clog(指標,linear)→ 噴嘴飛濺物堆積:保護氣流量下滑 → 飛濺率升(品質題;
    對症動作是清潔,不是換送絲輪 —— 學生要靠 gas_flow 與 wire_feed_rate 分離根因)。
  · torch_cable_aging(指標,linear)→ 導電纜老化:電弧電壓緩升(電阻升),機構訊號正常。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 28.0
SEAM_S = 16.0          # 一道焊道的節拍(sim 秒)
WELD_FRAC = 0.72       # 循環中「電弧開著、沿焊道走」的比例;其餘是回程與定位
SEAM_X = 200.0         # 焊道長度 ±mm
SEAM_Y = 60.0          # 兩條焊道的 Y 位置 ±mm(奇偶道交替)
NOM_CURRENT = 180.0    # 額定焊接電流(A)
NOM_FEED = 8.0         # 額定送絲率(m/min)
NOM_GAS = 15.0         # 保護氣流量(L/min)

_TAG_SPEC = [
    ("state",           "enum",   "int16"),
    ("torch_pos_x",     "mm",     "float32"),   # 焊槍沿焊道位置(±200;電弧段勻速前進)
    ("torch_pos_y",     "mm",     "float32"),   # 焊道別(奇偶道交替 ±60)
    ("arc_current",     "A",      "float32"),    # ★ 電弧電流(送絲輪磨損 → 波動變大)
    ("arc_voltage",     "V",      "float32"),    # 電弧電壓(導電纜老化 → 緩升)
    ("wire_feed_rate",  "m/min",  "float32"),    # ★ 送絲率(wire_feeder_wear → 下滑)
    ("gas_flow",        "L/min",  "float32"),    # ★ 保護氣流量(nozzle_clog → 下滑)
    ("torch_temp",      "degC",   "float32"),
    ("spatter_rate",    "%",      "float32"),     # ★ 飛濺率(品質指標:氣護不足 + 送絲不穩 → 升)
    ("vibration_rms",   "mm/s",   "float32"),
    ("weld_count",      "count",  "int32"),       # 完成焊道數(產線「完成一件」計數)
]
_INDICATORS = {"nozzle_clog", "torch_cable_aging"}
_DEFAULT_DEGRADATION = {
    "wire_feeder_wear": {"rate": 0.0000011, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
    "nozzle_clog": {"rate": 0.0000017, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    "torch_cable_aging": {"rate": 0.0000007, "trajectory": "linear", "sigma": 0.10, "init_health": 1.0, "causes_device_fault": False},
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
    torch_lag = ThermalLag(tau_sim_s=900.0, init_temp=AMBIENT_C)
    st = {"t": 0.0, "welds": 0.0, "ph": 0.0}

    def pre_step(dt_sim, op):
        if op["running"] and not device._fault_latched:
            st["t"] += dt_sim
            # 送絲慢 → 焊速跟著降(焊道要填滿),完成率等比例掉
            st["welds"] += dt_sim / SEAM_S * (0.55 + 0.45 * health_of(comp_map, "wire_feeder_wear"))
        st["ph"] = (st["t"] % SEAM_S) / SEAM_S   # 焊道相位 0..1

    def _arc_on(op) -> bool:
        return bool(op["running"]) and st["ph"] < WELD_FRAC

    def drv_torch_x(op, c, dt):
        if not op["running"]:
            return -SEAM_X                               # 待機停回焊道起點
        if st["ph"] < WELD_FRAC:                         # 電弧段:沿焊道勻速前進
            u = st["ph"] / WELD_FRAC
        else:                                            # 回程:快速退回起點
            u = 1.0 - (st["ph"] - WELD_FRAC) / (1.0 - WELD_FRAC)
        return -SEAM_X + 2.0 * SEAM_X * u + gaussian_noise(nrng, 0.4)

    def drv_torch_y(op, c, dt):
        if not op["running"]:
            return -SEAM_Y
        parity = int(st["t"] / SEAM_S) % 2               # 奇偶道交替
        return (SEAM_Y if parity else -SEAM_Y) + gaussian_noise(nrng, 0.4)

    def drv_current(op, c, dt):
        if not _arc_on(op):
            return abs(gaussian_noise(nrng, 0.3))
        h_feed = health_of(comp_map, "wire_feeder_wear")
        # 送絲打滑 → 弧長忽長忽短 → 電流波動變大(疊在額定值上的低頻晃動)
        wobble = 30.0 * (1.0 - h_feed) * math.sin(st["t"] * 2.7)
        return NOM_CURRENT * (0.92 + 0.08 * h_feed) + wobble + gaussian_noise(nrng, 2.0)

    def drv_voltage(op, c, dt):
        if not _arc_on(op):
            return 0.0 + abs(gaussian_noise(nrng, 0.05))
        h_cable = health_of(comp_map, "torch_cable_aging")
        return 24.0 + 6.0 * (1.0 - h_cable) + gaussian_noise(nrng, 0.25)

    def drv_feed(op, c, dt):
        if not _arc_on(op):
            return 0.0
        h_feed = health_of(comp_map, "wire_feeder_wear")
        return max(0.0, NOM_FEED * (0.55 + 0.45 * h_feed) + gaussian_noise(nrng, 0.08))

    def drv_gas(op, c, dt):
        if not _arc_on(op):
            return 0.5 + abs(gaussian_noise(nrng, 0.05))   # 保持微流防倒吸
        h_noz = health_of(comp_map, "nozzle_clog")
        return max(0.0, NOM_GAS * (0.55 + 0.45 * h_noz) + gaussian_noise(nrng, 0.15))

    def drv_torch_temp(op, c, dt):
        target = (330.0 if _arc_on(op) else 60.0) if op["running"] else AMBIENT_C
        return torch_lag.update(target, dt) + gaussian_noise(nrng, 1.0)

    def drv_spatter(op, c, dt):
        if not _arc_on(op):
            return 0.0
        h_noz = health_of(comp_map, "nozzle_clog")
        h_feed = health_of(comp_map, "wire_feeder_wear")
        return max(0.0, 0.8 + 12.0 * (1.0 - h_noz) ** 1.3 + 6.0 * (1.0 - h_feed) ** 1.5
                   + abs(gaussian_noise(nrng, 0.15)))

    def drv_vibration(op, c, dt):
        if not op["running"]:
            return 0.1 + abs(gaussian_noise(nrng, 0.02))
        h_feed = health_of(comp_map, "wire_feeder_wear")
        return 0.4 + 10.0 * (1.0 - h_feed) ** 1.8 + abs(gaussian_noise(nrng, 0.08))

    def drv_count(op, c, dt):
        return int(st["welds"])

    tag_by_name["torch_pos_x"].driver = drv_torch_x
    tag_by_name["torch_pos_y"].driver = drv_torch_y
    tag_by_name["arc_current"].driver = drv_current
    tag_by_name["arc_voltage"].driver = drv_voltage
    tag_by_name["wire_feed_rate"].driver = drv_feed
    tag_by_name["gas_flow"].driver = drv_gas
    tag_by_name["torch_temp"].driver = drv_torch_temp
    tag_by_name["spatter_rate"].driver = drv_spatter
    tag_by_name["vibration_rms"].driver = drv_vibration
    tag_by_name["weld_count"].driver = drv_count

    def oee_fn(op, comps):
        h_feed = health_of(comps, "wire_feeder_wear")
        perf = 0.55 + 0.45 * h_feed
        sp = 0.8 + 12.0 * (1.0 - health_of(comps, "nozzle_clog")) ** 1.3 \
             + 6.0 * (1.0 - h_feed) ** 1.5
        return perf, float(np.clip(1.0 - sp / 30.0, 0.5, 1.0))

    def quality_fn(op, comps, tag_by):
        """飛濺率即不良機率(同一支 driver 重算,不吃感測器層汙染)。"""
        return min(0.95, max(0.0, drv_spatter(op, comps, 0.0) / 100.0)), "spatter"

    device = Device(
        device_id=device_id, template="welding_cell", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
