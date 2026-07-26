"""CNC 加工中心 template(docs/03)。

P0 的數據誠信核心都在這裡:**同一個 spindle_bearing 健康度同時驅動振動、電流、溫度**,
形成「振動先漲 → 電流跟漲 → 溫度因摩擦升高 → 最後跳故障」的相關早期徵兆。
學生因此能學到多訊號診斷,而不是看一個布林旗標翻轉。

build(device_id, cfg, company_id) 由場景 YAML 的設備片段實例化一台 CNC。
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile, SetPoint, Tag
from ..signals import ThermalLag, gaussian_noise, health_of
from ._common import build_components, default_seed

# ── 物理量級常數(讓學生畫出來像真的,docs/02 §7)────────────
SPINDLE_NOM_RPM = 8000.0
AMBIENT_C = 25.0
COOLANT_AMBIENT_C = 22.0

# 指標型元件 + 未指定時的預設退化(YAML 可覆寫)
_INDICATORS = {"tool_wear", "ballscrew_backlash"}
_DEFAULT_DEGRADATION = {
    "spindle_bearing": {"rate": 0.0000012, "trajectory": "exponential", "k": 3.0, "sigma": 0.08, "init_health": 0.92},
    "tool_wear": {"rate": 0.0000015, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
}

# 各 tag 的規格:(name, unit, datatype)。register 位址在 build() 內依序自動配。
_TAG_SPEC = [
    ("state",           "enum",  "int16"),
    ("spindle_speed",   "rpm",   "float32"),
    ("spindle_load",    "%",     "float32"),
    ("spindle_current", "A",     "float32"),
    ("spindle_temp",    "degC",  "float32"),
    ("vibration_rms",   "mm/s",  "float32"),   # ★ 軸承退化主指標
    ("tool_wear",       "%",     "float32"),
    ("coolant_temp",    "degC",  "float32"),
    ("cycle_time",      "s",     "float32"),
    ("part_count",      "count", "int32"),
    ("pos_x",           "mm",    "float32"),
    ("pos_y",           "mm",    "float32"),
    ("pos_z",           "mm",    "float32"),
]


def _build_tags(modbus_base: int, opcua_folder: str) -> list[Tag]:
    """依 _TAG_SPEC 自動配 Modbus register(float/int32 佔 2 暫存器,int16 佔 1)。"""
    tags: list[Tag] = []
    reg = modbus_base
    for name, unit, dtype in _TAG_SPEC:
        tags.append(
            Tag(
                name=name,
                unit=unit,
                datatype=dtype,
                modbus_register=reg,
                opcua_node=f"{opcua_folder}/{name}",
                mqtt_field=name,
            )
        )
        reg += 1 if dtype == "int16" else 2
    return tags


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}

    # ── duty cycle ──────────────────────────────────────────
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(
        profile=duty_cfg.get("profile", "continuous"),
        load_nom=duty_cfg.get("load_nom", 70.0),
    )

    # ── 退化元件(由 YAML degradation 區塊驅動)─────────────
    # 每台設備一個獨立亂數種子 → 同型設備壽命有分散,學生模型要泛化(docs/02 §7)
    seed = cfg.get("seed", default_seed(device_id))
    rng = np.random.default_rng(seed)

    components = build_components(cfg, _INDICATORS, rng, defaults=_DEFAULT_DEGRADATION)

    # ── 協定定址 ────────────────────────────────────────────
    protocols = cfg.get("protocols", {}) or {}
    opcua_folder = (protocols.get("opcua", {}) or {}).get("node_folder", f"{company_id}/{device_id}")
    modbus_base = (protocols.get("modbus", {}) or {}).get("register_base", 0)

    tags = _build_tags(modbus_base, opcua_folder)
    tag_by_name = {t.name: t for t in tags}

    # ── 訊號 driver 的有狀態積木 ────────────────────────────
    spindle_lag = ThermalLag(tau_sim_s=1800.0, init_temp=AMBIENT_C)      # 主軸熱滯後
    coolant_lag = ThermalLag(tau_sim_s=3600.0, init_temp=COOLANT_AMBIENT_C)
    part_state = {"count": 0.0}                                          # 累積加工數(浮點累積、整數輸出)
    nrng = np.random.default_rng(int(rng.integers(0, 2**31)))            # 量測雜訊專用 RNG

    def _cycle_time(h_tool: float) -> float:
        # 刀具越鈍,單件加工越久(linear 隨 tool_wear 微增)
        return 45.0 + (1.0 - h_tool) * 15.0

    # ── driver:每個都吃 (op, comps, dt_sim) → 值 ───────────
    def drv_spindle_speed(op, comps, dt):
        if not op["running"]:
            return 0.0
        target_rpm = device.setpoint("spindle_rpm_setpoint", SPINDLE_NOM_RPM)   # 學生可寫主軸轉速目標
        return target_rpm * op["speed_factor"] + gaussian_noise(nrng, 5.0)

    def drv_spindle_load(op, comps, dt):
        return (op["load"] + gaussian_noise(nrng, 0.5)) if op["running"] else 0.0

    def drv_spindle_current(op, comps, dt):
        h_b = health_of(comps, "spindle_bearing")
        if not op["running"]:
            return 0.8 + gaussian_noise(nrng, 0.05)
        base = 2.0 + 0.085 * op["load"]          # 隨負載
        friction = 3.0 * (1.0 - h_b)             # 退化 → 摩擦 → 同樣出力要更大電流
        return base + friction + gaussian_noise(nrng, 0.08)

    def drv_spindle_temp(op, comps, dt):
        h_b = health_of(comps, "spindle_bearing")
        load_heat = 0.45 * op["load"] if op["running"] else 0.0
        friction_heat = 22.0 * (1.0 - h_b)       # 退化推高目標溫度 → 另一條相關線索
        target = AMBIENT_C + load_heat + friction_heat
        return spindle_lag.update(target, dt) + gaussian_noise(nrng, 0.2)

    def drv_vibration(op, comps, dt):
        h_b = health_of(comps, "spindle_bearing")
        base = (1.0 + 0.004 * op["load"]) if op["running"] else 0.15   # 正常運轉殘餘振動
        degr = 12.0 * (1.0 - h_b) ** 1.8                               # ★ 軸承退化主貢獻(非線性放大)
        return max(0.0, base + degr + gaussian_noise(nrng, 0.05))

    def drv_tool_wear(op, comps, dt):
        h_t = health_of(comps, "tool_wear")
        return float(np.clip((1.0 - h_t) * 100.0 + gaussian_noise(nrng, 0.2), 0.0, 100.0))

    def drv_coolant_temp(op, comps, dt):
        # 冷卻液跟著主軸溫度走,但更慢(較大 τ)。讀 spindle_lag.T(本 tick 已更新)
        target = COOLANT_AMBIENT_C + 0.25 * (spindle_lag.T - AMBIENT_C)
        return coolant_lag.update(target, dt) + gaussian_noise(nrng, 0.15)

    def drv_cycle_time(op, comps, dt):
        return _cycle_time(health_of(comps, "tool_wear")) + gaussian_noise(nrng, 0.3)

    def drv_part_count(op, comps, dt):
        if op["running"] and dt > 0.0:
            ct = _cycle_time(health_of(comps, "tool_wear"))
            part_state["count"] += dt / max(1.0, ct)
        return int(part_state["count"])

    def get_target_pos(progress: float, pattern: int):
        if pattern == 1:
            if progress < 0.05 or progress > 0.95:
                return 0.0, -150.0, 50.0
            p = (progress - 0.05) / 0.9
            return float(np.cos((p-0.25) * np.pi * 2) * 150), float(np.sin((p-0.25) * np.pi * 2) * 150), -50.0
        elif pattern == 2:
            if progress < 0.05 or progress > 0.95:
                return -150.0, -150.0, 50.0
            p = (progress - 0.05) / 0.9
            if p < 0.25: return -150.0 + 300.0 * (p/0.25), -150.0, -50.0
            elif p < 0.5: return 150.0, -150.0 + 300.0 * ((p-0.25)/0.25), -50.0
            elif p < 0.75: return 150.0 - 300.0 * ((p-0.5)/0.25), 150.0, -50.0
            else: return -150.0, 150.0 - 300.0 * ((p-0.75)/0.25), -50.0
        else:
            strokes = [
                [(-220, -60), (-220, 60)],
                [(-220, 60), (-140, -60)],
                [(-140, -60), (-140, 60)],
                [(-40, 60), (-100, 60), (-100, -60), (-40, -60)],
                [(40, 60), (40, -60), (100, -60), (100, 60)],
                [(140, 60), (220, 60)],
                [(180, 60), (180, -60)]
            ]
            total_segments = len(strokes)
            seg_progress = progress * total_segments
            seg_idx = min(int(seg_progress), total_segments - 1)
            local_p = seg_progress - seg_idx
            stroke = strokes[seg_idx]
            pts = len(stroke)
            
            if local_p < 0.1:
                return stroke[0][0], stroke[0][1], 50.0 - 100.0 * (local_p/0.1)
            elif local_p > 0.9:
                return stroke[-1][0], stroke[-1][1], -50.0 + 100.0 * ((local_p-0.9)/0.1)
            else:
                cut_p = (local_p - 0.1) / 0.8
                cut_segs = pts - 1
                c_idx = min(int(cut_p * cut_segs), cut_segs - 1)
                cc_p = (cut_p * cut_segs) - c_idx
                p1 = stroke[c_idx]
                p2 = stroke[c_idx+1]
                x = p1[0] + (p2[0] - p1[0]) * cc_p
                y = p1[1] + (p2[1] - p1[1]) * cc_p
                return float(x), float(y), -50.0

    def drv_pos_x(op, comps, dt):
        if not op["running"]: return 0.0
        pat = int(device.setpoint("machining_pattern", 0.0))
        x, _, _ = get_target_pos(part_state["count"] % 1.0, pat)
        return x

    def drv_pos_y(op, comps, dt):
        if not op["running"]: return 0.0
        pat = int(device.setpoint("machining_pattern", 0.0))
        _, y, _ = get_target_pos(part_state["count"] % 1.0, pat)
        return y

    def drv_pos_z(op, comps, dt):
        if not op["running"]: return 100.0
        pat = int(device.setpoint("machining_pattern", 0.0))
        _, _, z = get_target_pos(part_state["count"] % 1.0, pat)
        return z

    tag_by_name["spindle_speed"].driver = drv_spindle_speed
    tag_by_name["spindle_load"].driver = drv_spindle_load
    tag_by_name["spindle_current"].driver = drv_spindle_current
    tag_by_name["spindle_temp"].driver = drv_spindle_temp
    tag_by_name["vibration_rms"].driver = drv_vibration
    tag_by_name["tool_wear"].driver = drv_tool_wear
    tag_by_name["coolant_temp"].driver = drv_coolant_temp
    tag_by_name["cycle_time"].driver = drv_cycle_time
    tag_by_name["part_count"].driver = drv_part_count
    tag_by_name["pos_x"].driver = drv_pos_x
    tag_by_name["pos_y"].driver = drv_pos_y
    tag_by_name["pos_z"].driver = drv_pos_z

    def oee_fn(op, comps):
        h_tool = health_of(comps, "tool_wear")
        perf = 45.0 / _cycle_time(h_tool)                 # 刀鈍 → 節拍變長 → 表現降
        qual = max(0.5, 1.0 - (1.0 - h_tool) * 0.45)      # 刀鈍 → 不良率升
        return perf, qual

    setpoints = [
        SetPoint(name="spindle_rpm_setpoint", register=100, unit="rpm",
                 min=2000.0, max=12000.0, default=SPINDLE_NOM_RPM, scale=1.0),
        SetPoint(name="machining_pattern", register=101, unit="enum",
                 min=0.0, max=2.0, default=0.0, scale=1.0)
    ]
    device = Device(
        device_id=device_id,
        template="cnc_machining_center",
        tags=tags,
        components=components,
        duty=duty,
        protocols=protocols,
        company_id=company_id,
        oee_fn=oee_fn,
        setpoints=setpoints,
    )

    # state tag 反映設備狀態碼。driver 在 _update_state 之前執行,故落後 1 tick(0.1s),
    # P0 可接受;adapter 的 snapshot 另含即時 state_code 供精確顯示。
    tag_by_name["state"].driver = lambda op, comps, dt: float(STATE_CODES.get(device.state, 0))

    return device
