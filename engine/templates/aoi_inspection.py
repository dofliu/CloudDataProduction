"""AOI 光學檢測站 template(品質閘門,產線的「檢測」工站)。

電子與精密製造的標配:相機龍門對工件做蛇形掃描,判定良品 / 不良。三條故障線:
  · stage_bearing(本體,exponential)→ 掃描平台軸承磨損:振動升、掃描變慢,最後定位失效 → 設備 fault。
  · lens_contamination(指標,linear)→ 鏡頭污染:focus_score 下滑 → 誤判率升(**機構訊號正常**,
    是「量測系統本身劣化」的教學題 —— 檢測站說不良,不代表工件真的不良)。
  · led_aging(指標,linear)→ 環形光源衰減:light_intensity 下滑,誤判率跟著升(與鏡頭污染
    同樣推高 false_call,學生要靠 focus_score / light_intensity 分離兩個根因)。
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

INSPECT_S = 15.0        # 一件的掃描節拍(sim 秒;> 預設 dt_sim 12s,產線記帳一拍一件)
SCAN_ROWS = 5           # 蛇形掃描列數
SCAN_X = 150.0          # 掃描範圍 ±mm(相機龍門 X 行程)
SCAN_Y = 100.0          # ±mm(Y 行程;5 列 → 每列間距 50 mm)

_TAG_SPEC = [
    ("state",            "enum",  "int16"),
    ("camera_pos_x",     "mm",    "float32"),   # 相機龍門 X(蛇形掃描,±150)
    ("camera_pos_y",     "mm",    "float32"),   # 相機龍門 Y(逐列步進,±100)
    ("light_intensity",  "%",     "float32"),   # 環形光源強度(led_aging → 下滑)
    ("focus_score",      "score", "float32"),    # ★ 影像清晰度 0~100(lens_contamination → 下滑)
    ("false_call_rate",  "%",     "float32"),    # ★ 誤判率(鏡頭污染 + 光源衰減 → 上升,良率指標)
    ("inspect_time",     "s",     "float32"),    # 單件檢測節拍(軸承磨損 → 變慢)
    ("vibration_rms",    "mm/s",  "float32"),    # ★ stage_bearing 退化主指標
    ("inspected_count",  "count", "int32"),
]
_INDICATORS = {"lens_contamination", "led_aging"}
_DEFAULT_DEGRADATION = {
    "stage_bearing": {"rate": 0.0000010, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.94},
    "lens_contamination": {"rate": 0.0000015, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    "led_aging": {"rate": 0.0000008, "trajectory": "linear", "sigma": 0.10, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 80.0))

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
    st = {"t": 0.0, "count": 0.0, "ph": 0.0}

    def _inspect_time(h_bearing: float) -> float:
        return INSPECT_S + (1.0 - h_bearing) * 6.0   # 軸承磨損 → 掃描降速保精度,節拍變長

    def pre_step(dt_sim, op):
        if op["running"] and not device._fault_latched:
            st["t"] += dt_sim
            st["count"] += dt_sim / _inspect_time(health_of(comp_map, "stage_bearing"))
        st["ph"] = (st["t"] % INSPECT_S) / INSPECT_S   # 掃描相位 0..1(對額定節拍;畫面用座標鎖定)

    # 蛇形掃描座標:相位 → 第幾列 + 列內進度(偶數列往右、奇數列往左)。
    # 引擎算好座標、前端只做補間 —— 契約鐵則二:前端不重算物理。
    def _scan_xy(ph: float) -> tuple[float, float]:
        p = ph * SCAN_ROWS
        row = min(SCAN_ROWS - 1, int(p))
        u = p - row
        x = (-SCAN_X + 2.0 * SCAN_X * u) if row % 2 == 0 else (SCAN_X - 2.0 * SCAN_X * u)
        y = -SCAN_Y + row * (2.0 * SCAN_Y / (SCAN_ROWS - 1))
        return x, y

    def drv_cam_x(op, c, dt):
        if not op["running"]:
            return -SCAN_X                        # 待機停回原點(列首)
        return _scan_xy(st["ph"])[0] + gaussian_noise(nrng, 0.3)

    def drv_cam_y(op, c, dt):
        if not op["running"]:
            return -SCAN_Y
        return _scan_xy(st["ph"])[1] + gaussian_noise(nrng, 0.3)

    def drv_light(op, c, dt):
        h_led = health_of(comp_map, "led_aging")
        base = 100.0 if op["running"] else 12.0   # 待機降亮度省壽命
        return max(0.0, base * (0.68 + 0.32 * h_led) + gaussian_noise(nrng, 0.5))

    def drv_focus(op, c, dt):
        if not op["running"]:
            return 0.0
        h_lens = health_of(comp_map, "lens_contamination")
        return float(np.clip(96.0 - 55.0 * (1.0 - h_lens) ** 1.2 + gaussian_noise(nrng, 0.8), 0.0, 100.0))

    def drv_false_call(op, c, dt):
        if not op["running"]:
            return 0.0
        h_lens = health_of(comp_map, "lens_contamination")
        h_led = health_of(comp_map, "led_aging")
        return max(0.0, 0.6 + 14.0 * (1.0 - h_lens) ** 1.3 + 8.0 * (1.0 - h_led) ** 1.4
                   + gaussian_noise(nrng, 0.12))

    def drv_inspect_time(op, c, dt):
        return _inspect_time(health_of(comp_map, "stage_bearing")) + gaussian_noise(nrng, 0.1)

    def drv_vibration(op, c, dt):
        if not op["running"]:
            return 0.1 + abs(gaussian_noise(nrng, 0.02))
        h = health_of(comp_map, "stage_bearing")
        return 0.3 + 11.0 * (1.0 - h) ** 1.8 + abs(gaussian_noise(nrng, 0.08))

    def drv_count(op, c, dt):
        return int(st["count"])

    tag_by_name["camera_pos_x"].driver = drv_cam_x
    tag_by_name["camera_pos_y"].driver = drv_cam_y
    tag_by_name["light_intensity"].driver = drv_light
    tag_by_name["focus_score"].driver = drv_focus
    tag_by_name["false_call_rate"].driver = drv_false_call
    tag_by_name["inspect_time"].driver = drv_inspect_time
    tag_by_name["vibration_rms"].driver = drv_vibration
    tag_by_name["inspected_count"].driver = drv_count

    def oee_fn(op, comps):
        h_bearing = health_of(comps, "stage_bearing")
        perf = INSPECT_S / _inspect_time(h_bearing)             # 節拍變長 → 表現掉
        # 「品質」對檢測站的意義是判得準:誤判率越高,放走 / 錯殺越多
        fc = 0.6 + 14.0 * (1.0 - health_of(comps, "lens_contamination")) ** 1.3 \
             + 8.0 * (1.0 - health_of(comps, "led_aging")) ** 1.4
        return perf, float(np.clip(1.0 - fc / 40.0, 0.5, 1.0))

    device = Device(
        device_id=device_id, template="aoi_inspection", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
