"""AGV / 自走搬運車 template(docs/03,物流)。

有電池與移動特性:沿矩形路線繞行,電量耗盡去充電。pos_x/y 讓 2D 世界能畫出移動。
headline:motor_bearing 退化 → 電流 / 溫度上升;battery_capacity_fade 讓可充上限緩降(指標型)。
移動 / 電池狀態機放在 pre_step_fn,每 tick 只整合一次,各 tag 共讀結果。
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, build_tags

AMBIENT_C = 25.0
NOM_SPEED = 1.2          # m/s
DRAIN_PER_S = 0.0009     # 移動時 SOC 每模擬秒下降(%)
CHARGE_PER_S = 0.004     # 充電時 SOC 每模擬秒上升(%)
SOC_LOW = 20.0           # 低於此去充電
# 矩形巡迴路線(廠區局部座標,公尺),四段周長 52 m
_LOOP = [(2.0, 2.0), (18.0, 2.0), (18.0, 12.0), (2.0, 12.0)]
_SEG_LEN = [16.0, 10.0, 16.0, 10.0]
_SEG_HEADING = [0.0, 90.0, 180.0, 270.0]
_PERIM = sum(_SEG_LEN)

_TAG_SPEC = [
    ("state",           "enum",  "int16"),
    ("battery_soc",     "%",     "float32"),
    ("battery_voltage", "V",     "float32"),
    ("battery_temp",    "degC",  "float32"),
    ("motor_current_l", "A",     "float32"),
    ("motor_current_r", "A",     "float32"),
    ("motor_temp",      "degC",  "float32"),
    ("speed",           "m/s",   "float32"),
    ("pos_x",           "m",     "float32"),
    ("pos_y",           "m",     "float32"),
    ("heading",         "deg",   "float32"),
    ("payload",         "kg",    "float32"),
]
_INDICATORS = {"battery_capacity_fade", "wheel_wear"}
_DEFAULT_DEGRADATION = {
    "motor_bearing": {"rate": 0.0000011, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
    "battery_capacity_fade": {"rate": 0.0000008, "trajectory": "linear", "sigma": 0.1, "init_health": 1.0, "causes_device_fault": False},
    "wheel_wear": {"rate": 0.0000010, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
}


def _pos_from_s(s: float):
    """路線距離 s → (x, y, heading)。"""
    s = s % _PERIM
    for i, seg in enumerate(_SEG_LEN):
        if s <= seg:
            x0, y0 = _LOOP[i]
            x1, y1 = _LOOP[(i + 1) % 4]
            frac = s / seg
            return x0 + (x1 - x0) * frac, y0 + (y1 - y0) * frac, _SEG_HEADING[i]
        s -= seg
    return _LOOP[0][0], _LOOP[0][1], 0.0


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty = DutyProfile(profile="continuous", load_nom=cfg.get("duty_cycle", {}).get("load_nom", 60.0))

    seed = cfg.get("seed", abs(hash(device_id)) % (2**31))
    rng = np.random.default_rng(seed)
    components = build_components(cfg, _INDICATORS, rng, defaults=_DEFAULT_DEGRADATION)
    comp_map = {c.name: c for c in components}   # pre_step / 部分 driver 用名稱查健康度

    protocols = cfg.get("protocols", {}) or {}
    opcua_folder = (protocols.get("opcua", {}) or {}).get("node_folder", f"{company_id}/{device_id}")
    modbus_base = (protocols.get("modbus", {}) or {}).get("register_base", 0)
    tags = build_tags(_TAG_SPEC, modbus_base, opcua_folder)
    tag_by_name = {t.name: t for t in tags}

    batt_lag = ThermalLag(tau_sim_s=1200.0, init_temp=AMBIENT_C + 3.0)
    motor_lag = ThermalLag(tau_sim_s=900.0, init_temp=AMBIENT_C)
    nrng = np.random.default_rng(int(rng.integers(0, 2**31)))

    # 共享狀態(由 pre_step 整合,各 tag 讀取)
    st = {"mode": "moving", "soc": 100.0, "s": float(rng.uniform(0, _PERIM)),
          "x": 0.0, "y": 0.0, "heading": 0.0, "speed": 0.0, "payload": 0.0}

    def pre_step(dt_sim, op):
        if device._fault_latched or not op["running"]:   # 故障 / 教師停機(run_enable=0)→ 停在原地
            st["speed"] = 0.0
            return
        h_batt = health_of(comp_map, "battery_capacity_fade")
        usable_max = 100.0 * h_batt          # 電池衰退 → 可充上限下降(可觀測線索)
        if st["mode"] == "charging":
            st["speed"] = 0.0
            st["soc"] = min(usable_max, st["soc"] + CHARGE_PER_S * dt_sim)
            if st["soc"] >= usable_max - 0.5:
                st["mode"] = "moving"
        else:  # moving
            st["speed"] = NOM_SPEED
            st["s"] += st["speed"] * dt_sim
            st["soc"] = max(0.0, st["soc"] - DRAIN_PER_S * dt_sim)
            st["payload"] = 0.0 if int(st["s"] // _PERIM) % 2 == 0 else 30.0  # 每圈交替載重
            if st["soc"] <= SOC_LOW:
                st["mode"] = "charging"
        st["x"], st["y"], st["heading"] = _pos_from_s(st["s"])

    def state_fn(op, comps):
        if not op["running"]:                # 教師停機 → idle(不再 moving/charging)
            return "idle"
        return "charging" if st["mode"] == "charging" else "moving"

    moving = lambda: st["mode"] == "moving"

    def drv_soc(op, comps, dt):
        return st["soc"] + gaussian_noise(nrng, 0.05)

    def drv_voltage(op, comps, dt):
        # 電壓隨 SOC,移動時略降(負載壓降)
        v = 46.0 + 0.08 * st["soc"] - (0.6 if moving() else 0.0)
        return v + gaussian_noise(nrng, 0.05)

    def drv_batt_temp(op, comps, dt):
        target = AMBIENT_C + (4.0 if moving() else 6.0)  # 充電發熱略高
        return batt_lag.update(target, dt) + gaussian_noise(nrng, 0.1)

    def _motor_current(side_bias):
        h_bearing = health_of(comp_map, "motor_bearing")
        h_wheel = health_of(comp_map, "wheel_wear")
        if not moving():
            return 0.4 + gaussian_noise(nrng, 0.03)
        base = 4.0 + 0.03 * st["payload"]
        friction = 2.5 * (1.0 - h_bearing) + 1.0 * (1.0 - h_wheel)
        return base + friction + side_bias + gaussian_noise(nrng, 0.08)

    def drv_motor_temp(op, comps, dt):
        h_bearing = health_of(comp_map, "motor_bearing")
        load_heat = 12.0 if moving() else 0.0
        target = AMBIENT_C + load_heat + 15.0 * (1.0 - h_bearing)
        return motor_lag.update(target, dt) + gaussian_noise(nrng, 0.2)

    tag_by_name["battery_soc"].driver = drv_soc
    tag_by_name["battery_voltage"].driver = drv_voltage
    tag_by_name["battery_temp"].driver = drv_batt_temp
    tag_by_name["motor_current_l"].driver = lambda op, c, dt: _motor_current(+0.2)
    tag_by_name["motor_current_r"].driver = lambda op, c, dt: _motor_current(-0.2)
    tag_by_name["motor_temp"].driver = drv_motor_temp
    tag_by_name["speed"].driver = lambda op, c, dt: st["speed"] + (gaussian_noise(nrng, 0.02) if moving() else 0.0)
    tag_by_name["pos_x"].driver = lambda op, c, dt: st["x"]
    tag_by_name["pos_y"].driver = lambda op, c, dt: st["y"]
    tag_by_name["heading"].driver = lambda op, c, dt: st["heading"]
    tag_by_name["payload"].driver = lambda op, c, dt: st["payload"]

    def oee_fn(op, comps):
        h_m = health_of(comp_map, "motor_bearing")
        h_b = health_of(comp_map, "battery_capacity_fade")
        return 0.85 + 0.15 * h_m, max(0.8, 0.9 + 0.1 * h_b)   # 馬達退化降表現;電池衰退微降良率

    device = Device(
        device_id=device_id, template="agv_mobile_robot", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        state_fn=state_fn, pre_step_fn=pre_step, oee_fn=oee_fn,
    )
    tag_by_name["state"].driver = lambda op, comps, dt: float(STATE_CODES.get(device.state, 0))
    return device
