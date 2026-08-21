"""雷射切割機 template(鈑金 / 精密下料工站)。

切割頭沿矩形輪廓走一圈切一件。三條故障線:
  · protective_lens_fouling(本體,exponential)→ 保護鏡片污損:吸收雷射能量發熱
    (lens_temp 升)、有效功率掉 → 切割降速,污損到穿透率不足時切不斷 → 設備 fault。
  · chiller_degradation(指標,linear)→ 冷卻迴路劣化:chiller_temp 緩升 → 雷射源
    降額保護(laser_power 微降)。流體系統題,對症是保養冷卻迴路。
  · nozzle_wear(指標,linear)→ 切割噴嘴磨損:輔助氣壓波動 → 掛渣率 dross_rate 升(品質題)。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

AMBIENT_C = 26.0
CUT_S = 24.0           # 一件的切割節拍(sim 秒)
CUT_FRAC = 0.80        # 循環中「雷射開著、沿輪廓走」的比例;其餘是換料定位
RECT_X = 150.0         # 切割矩形半寬 ±mm
RECT_Y = 100.0         # 半高 ±mm
NOM_POWER = 3000.0     # 額定雷射功率(W)
NOM_GAS = 12.0         # 輔助氣壓(bar)
NOM_SPEED = 35.0       # 額定切割線速度(mm/s)

_TAG_SPEC = [
    ("state",               "enum",  "int16"),
    ("head_pos_x",          "mm",    "float32"),   # 切割頭 X(±150,沿矩形輪廓)
    ("head_pos_y",          "mm",    "float32"),   # 切割頭 Y(±100)
    ("laser_power",         "W",     "float32"),    # 雷射輸出(冷卻劣化 → 降額)
    ("lens_temp",           "degC",  "float32"),    # ★ 保護鏡片溫度(污損吸收 → 升,退化主指標)
    ("chiller_temp",        "degC",  "float32"),    # 冷卻水溫(chiller_degradation → 緩升)
    ("assist_gas_pressure", "bar",   "float32"),    # 輔助氣壓(nozzle_wear → 波動變大)
    ("cut_speed",           "mm/s",  "float32"),    # 切割線速度(鏡片污損 → 降速補償)
    ("dross_rate",          "%",     "float32"),     # ★ 掛渣率(品質指標)
    ("vibration_rms",       "mm/s",  "float32"),
    ("cut_count",           "count", "int32"),
]
_INDICATORS = {"chiller_degradation", "nozzle_wear"}
_DEFAULT_DEGRADATION = {
    "protective_lens_fouling": {"rate": 0.0000010, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
    "chiller_degradation": {"rate": 0.0000012, "trajectory": "linear", "sigma": 0.12, "init_health": 1.0, "causes_device_fault": False},
    "nozzle_wear": {"rate": 0.0000015, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
}

# 矩形輪廓周長參數化用的四段(右→上→左→下,起點在左下角)
_PERIM = 4.0 * (RECT_X + RECT_Y)


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
    lens_lag = ThermalLag(tau_sim_s=1200.0, init_temp=AMBIENT_C)
    chiller_lag = ThermalLag(tau_sim_s=3600.0, init_temp=22.0)
    st = {"t": 0.0, "cuts": 0.0, "ph": 0.0}

    def _speed_factor(h_lens: float) -> float:
        return 0.55 + 0.45 * h_lens            # 鏡片污損 → 降速補償(切得動但變慢)

    def pre_step(dt_sim, op):
        if op["running"] and not device._fault_latched:
            st["t"] += dt_sim
            st["cuts"] += dt_sim / CUT_S * _speed_factor(health_of(comp_map, "protective_lens_fouling"))
        st["ph"] = (st["t"] % CUT_S) / CUT_S   # 切割相位 0..1

    def _laser_on(op) -> bool:
        return bool(op["running"]) and st["ph"] < CUT_FRAC

    # 矩形輪廓座標:相位 → 周長弧長 → 四段折線(左下起逆時針)。
    # 引擎算好座標、前端只做補間 —— 契約鐵則二。
    def _rect_xy(ph: float) -> tuple[float, float]:
        s = (ph / CUT_FRAC) * _PERIM
        if s < 2 * RECT_X:                                  # 底邊:左下 → 右下
            return -RECT_X + s, -RECT_Y
        s -= 2 * RECT_X
        if s < 2 * RECT_Y:                                  # 右邊:右下 → 右上
            return RECT_X, -RECT_Y + s
        s -= 2 * RECT_Y
        if s < 2 * RECT_X:                                  # 頂邊:右上 → 左上
            return RECT_X - s, RECT_Y
        s -= 2 * RECT_X
        return -RECT_X, RECT_Y - s                          # 左邊:左上 → 左下

    def drv_head_x(op, c, dt):
        if not op["running"]:
            return -RECT_X
        if st["ph"] < CUT_FRAC:
            return _rect_xy(st["ph"])[0] + gaussian_noise(nrng, 0.3)
        u = (st["ph"] - CUT_FRAC) / (1.0 - CUT_FRAC)        # 換料段:回到左下起點(輪廓終點就是起點,原地待料)
        return -RECT_X + gaussian_noise(nrng, 0.3) * (1.0 - u)

    def drv_head_y(op, c, dt):
        if not op["running"]:
            return -RECT_Y
        if st["ph"] < CUT_FRAC:
            return _rect_xy(st["ph"])[1] + gaussian_noise(nrng, 0.3)
        return -RECT_Y + gaussian_noise(nrng, 0.3)

    def drv_power(op, c, dt):
        if not _laser_on(op):
            return 0.0 + abs(gaussian_noise(nrng, 2.0))
        # 冷卻水越熱,雷射源降額保護越多(28°C 起每 +1°C 降 1.5%)
        derate = max(0.0, (chiller_lag.T - 28.0) * 0.015)
        return NOM_POWER * max(0.6, 1.0 - derate) + gaussian_noise(nrng, 15.0)

    def drv_lens_temp(op, c, dt):
        h_lens = health_of(comp_map, "protective_lens_fouling")
        # 污損吸收:健康時鏡片僅微溫(45°C),污損越重吸收越多(最高逼近 120°C)
        target = (45.0 + 75.0 * (1.0 - h_lens) ** 1.2) if _laser_on(op) else AMBIENT_C
        return lens_lag.update(target, dt) + gaussian_noise(nrng, 0.5)

    def drv_chiller(op, c, dt):
        h_ch = health_of(comp_map, "chiller_degradation")
        target = (22.0 + 14.0 * (1.0 - h_ch)) if op["running"] else 20.0
        return chiller_lag.update(target, dt) + gaussian_noise(nrng, 0.2)

    def drv_gas(op, c, dt):
        if not _laser_on(op):
            return 0.3 + abs(gaussian_noise(nrng, 0.03))
        h_noz = health_of(comp_map, "nozzle_wear")
        wobble = 2.5 * (1.0 - h_noz) * math.sin(st["t"] * 1.9)   # 噴嘴磨損 → 氣壓波動
        return max(0.0, NOM_GAS + wobble + gaussian_noise(nrng, 0.12))

    def drv_speed(op, c, dt):
        if not _laser_on(op):
            return 0.0
        h_lens = health_of(comp_map, "protective_lens_fouling")
        return NOM_SPEED * _speed_factor(h_lens) + gaussian_noise(nrng, 0.4)

    def drv_dross(op, c, dt):
        if not _laser_on(op):
            return 0.0
        h_noz = health_of(comp_map, "nozzle_wear")
        h_lens = health_of(comp_map, "protective_lens_fouling")
        return max(0.0, 0.5 + 10.0 * (1.0 - h_noz) ** 1.3 + 5.0 * (1.0 - h_lens) ** 1.5
                   + abs(gaussian_noise(nrng, 0.12)))

    def drv_vibration(op, c, dt):
        if not op["running"]:
            return 0.1 + abs(gaussian_noise(nrng, 0.02))
        return 0.35 + abs(gaussian_noise(nrng, 0.06))   # 龍門本身沒有退化線,量級低而平穩

    def drv_count(op, c, dt):
        return int(st["cuts"])

    tag_by_name["head_pos_x"].driver = drv_head_x
    tag_by_name["head_pos_y"].driver = drv_head_y
    tag_by_name["laser_power"].driver = drv_power
    tag_by_name["lens_temp"].driver = drv_lens_temp
    tag_by_name["chiller_temp"].driver = drv_chiller
    tag_by_name["assist_gas_pressure"].driver = drv_gas
    tag_by_name["cut_speed"].driver = drv_speed
    tag_by_name["dross_rate"].driver = drv_dross
    tag_by_name["vibration_rms"].driver = drv_vibration
    tag_by_name["cut_count"].driver = drv_count

    def oee_fn(op, comps):
        h_lens = health_of(comps, "protective_lens_fouling")
        perf = _speed_factor(h_lens)
        dr = 0.5 + 10.0 * (1.0 - health_of(comps, "nozzle_wear")) ** 1.3 \
             + 5.0 * (1.0 - h_lens) ** 1.5
        return perf, float(np.clip(1.0 - dr / 25.0, 0.5, 1.0))

    def quality_fn(op, comps, tag_by):
        """掛渣率即不良機率(同一支 driver 重算)。"""
        return min(0.95, max(0.0, drv_dross(op, comps, 0.0) / 100.0)), "dross"

    device = Device(
        device_id=device_id, template="laser_cutter", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
