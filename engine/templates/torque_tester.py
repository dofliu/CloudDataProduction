"""扭力功能測試機 template(手工具製程第 9 站:組裝完的成品 → 上機扭到規格值)。

扳手、套筒、起子做完要驗扭力。這一站在整條產線裡的角色很特別:**它是量測站,
不是加工站** —— 它不改變工件,只回答「這支合不合格」。

正因為如此,它的失效模式是全園區最陰險的一種:

  · drive_motor_wear(本體,exponential)→ 驅動馬達 / 減速機磨耗 → 振動升、
    加載速率掉,最後咬死 → 設備 fault。這條看得見。
  · torque_sensor_drift(指標,linear)→ **扭力感測器讀值漂移**。機器一切正常、
    產線一切正常,但它**量錯了** —— 漂移是正的就把不良品放行,是負的就把良品退掉。
    這是「量測系統本身壞掉」,不是產品壞掉。
  · fixture_wear(指標,linear)→ 夾具磨耗 → 夾不緊 → 測試中打滑 → 量到的峰值
    偏低且**分散變大**(重測就換一個數字)。

`sensor_bias` 這支 tag 是刻意公開的:它是**教學用的照妖鏡**,讓學生對照
`peak_torque` 與 `sensor_bias` 看懂「儀器說的」和「真的」差在哪。真工廠靠定期
校正與標準件比對才知道,這裡直接把答案畫出來,讓學生先建立直覺。
"""
from __future__ import annotations

from typing import Optional

import numpy as np

from ..device import STATE_CODES, Device, DutyProfile
from ..signals import gaussian_noise, health_of
from ._common import build_components, build_tags, default_seed

CYCLE_S = 11.0            # 一支工具的測試循環(sim 秒)
NOM_TORQUE_NM = 62.0      # 標稱測試扭力(N·m)
TOL_NM = 3.1              # 允收帶 ±5%(超出即判不合格)

_TAG_SPEC = [
    ("state",           "enum",  "int16"),
    ("applied_torque",  "Nm",    "float32"),   # ★ 即時施加扭力(隨相位爬升)
    ("peak_torque",     "Nm",    "float32"),   # ★ 本次峰值(判定用,含感測器偏差)
    ("torque_angle",    "deg",   "float32"),   # ★ 加載角度(打滑 → 角度異常變大)
    ("sensor_bias",     "Nm",    "float32"),   # ★ 感測器偏差(教學照妖鏡,量測系統誤差)
    ("clamp_pressure",  "bar",   "float32"),   # ★ 夾具夾持壓力(磨耗 → 掉)
    ("slip_events",     "count", "int32"),     # ★ 累計打滑次數(夾具磨耗 → 增)
    ("load_rate",       "Nm/s",  "float32"),   # 加載速率(馬達磨耗 → 掉)
    ("motor_current",   "A",     "float32"),
    ("cycle_time",      "s",     "float32"),
    ("vibration_rms",   "mm/s",  "float32"),
    ("tested_count",    "count", "int32"),
]
_INDICATORS = {"torque_sensor_drift", "fixture_wear"}
_DEFAULT_DEGRADATION = {
    "drive_motor_wear": {"rate": 0.0000010, "trajectory": "exponential", "k": 2.7, "sigma": 0.1, "init_health": 0.95},
    "torque_sensor_drift": {"rate": 0.0000021, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    "fixture_wear": {"rate": 0.0000017, "trajectory": "linear", "sigma": 0.13, "init_health": 1.0, "causes_device_fault": False},
}


def build(device_id: str, cfg: dict, company_id: Optional[str] = None) -> Device:
    cfg = cfg or {}
    duty_cfg = cfg.get("duty_cycle", {}) or {}
    duty = DutyProfile(profile=duty_cfg.get("profile", "two_shift"),
                       load_nom=duty_cfg.get("load_nom", 65.0))

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
    # 感測器漂移的方向由 device_id 決定(有些機台往上漂、有些往下)—— 兩種都要教
    drift_sign = 1.0 if (int(rng.integers(0, 2)) == 0) else -1.0
    st = {"t": 0.0, "ph": 0.0, "tests": 0.0, "slips": 0}

    def _cycle(h_motor: float) -> float:
        return CYCLE_S * (1.0 + 0.28 * (1.0 - h_motor))

    def pre_step(dt_sim, op):
        h_m = health_of(comp_map, "drive_motor_wear")
        cyc = _cycle(h_m)
        prev_ph = st["ph"]
        if op["running"] and not device._fault_latched and dt_sim > 0.0:
            st["t"] += dt_sim
            st["tests"] += dt_sim / cyc
        st["ph"] = (st["t"] % cyc) / cyc
        # 每完成一次測試,依夾具健康度決定這次有沒有打滑
        if op["running"] and st["ph"] < prev_ph:
            h_f = health_of(comp_map, "fixture_wear")
            if nrng.random() < min(0.55, 0.9 * (1.0 - h_f) ** 1.8):
                st["slips"] += 1

    def _loading() -> float:
        """一個循環的前 70% 在加載,之後洩壓 / 換件。"""
        return min(1.0, st["ph"] / 0.70) if st["ph"] < 0.70 else 0.0

    def _bias_nm(comps) -> float:
        """感測器偏差:漂移健康度掉 → 偏差線性長大(方向由機台決定)。
        這是**量測系統**的誤差,不是產品的問題 —— 產線一切正常時它照樣長。"""
        h_s = health_of(comp_map, "torque_sensor_drift")
        return drift_sign * 6.4 * (1.0 - h_s) ** 1.15

    def _true_peak(comps) -> float:
        """真值峰值:夾具磨耗 → 打滑 → 實際扭不到那麼高(且分散變大)。"""
        h_f = health_of(comp_map, "fixture_wear")
        return NOM_TORQUE_NM * (1.0 - 0.09 * (1.0 - h_f) ** 1.4)

    def _peak_spread(comps) -> float:
        h_f = health_of(comp_map, "fixture_wear")
        # 夾具鬆 → 重測就換一個數字(重複性變差,這是 Gage R&R 要教的東西)
        return 0.55 + 4.2 * (1.0 - h_f) ** 1.7

    def drv_applied(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.05)
        return (_true_peak(c) + _bias_nm(c)) * _loading() + gaussian_noise(nrng, 0.12)

    def drv_peak(op, c, dt):
        if not op["running"]:
            return 0.0
        # 儀器讀到的 = 真值 + 感測器偏差 + 夾具造成的分散
        return _true_peak(c) + _bias_nm(c) + gaussian_noise(nrng, _peak_spread(c))

    def drv_angle(op, c, dt):
        if not op["running"]:
            return 0.0
        h_f = health_of(comp_map, "fixture_wear")
        # 打滑 → 要轉更多角度才到扭力(角度是打滑最直接的旁證)
        return 32.0 * (1.0 + 0.9 * (1.0 - h_f) ** 1.6) * _loading() + gaussian_noise(nrng, 0.4)

    def drv_bias(op, c, dt):
        return _bias_nm(c) + gaussian_noise(nrng, 0.02)

    def drv_clamp(op, c, dt):
        h_f = health_of(comp_map, "fixture_wear")
        base = 42.0 * (0.58 + 0.42 * h_f) if op["running"] else 0.4
        return max(0.0, base + gaussian_noise(nrng, 0.15))

    def drv_slips(op, c, dt):
        return int(st["slips"])

    def drv_load_rate(op, c, dt):
        if not op["running"]:
            return gaussian_noise(nrng, 0.05)
        h_m = health_of(comp_map, "drive_motor_wear")
        return 9.5 * (0.62 + 0.38 * h_m) + gaussian_noise(nrng, 0.08)

    def drv_current(op, c, dt):
        if not op["running"]:
            return 0.5 + gaussian_noise(nrng, 0.03)
        h_m = health_of(comp_map, "drive_motor_wear")
        return (2.2 + 5.8 * _loading() * (1.0 + 0.55 * (1.0 - h_m) ** 1.6)
                + gaussian_noise(nrng, 0.07))

    def drv_cycle(op, c, dt):
        return _cycle(health_of(comp_map, "drive_motor_wear")) + gaussian_noise(nrng, 0.06)

    def drv_vib(op, c, dt):
        h_m = health_of(comp_map, "drive_motor_wear")
        base = 0.7 if op["running"] else 0.08
        return max(0.0, base + 6.9 * (1.0 - h_m) ** 1.85 + gaussian_noise(nrng, 0.04))

    def drv_tests(op, c, dt):
        return int(st["tests"])

    tag_by_name["applied_torque"].driver = drv_applied
    tag_by_name["peak_torque"].driver = drv_peak
    tag_by_name["torque_angle"].driver = drv_angle
    tag_by_name["sensor_bias"].driver = drv_bias
    tag_by_name["clamp_pressure"].driver = drv_clamp
    tag_by_name["slip_events"].driver = drv_slips
    tag_by_name["load_rate"].driver = drv_load_rate
    tag_by_name["motor_current"].driver = drv_current
    tag_by_name["cycle_time"].driver = drv_cycle
    tag_by_name["vibration_rms"].driver = drv_vib
    tag_by_name["tested_count"].driver = drv_tests

    def oee_fn(op, comps):
        h_m = health_of(comps, "drive_motor_wear")
        perf = CYCLE_S / _cycle(h_m)
        # 測試站的「品質」= 判定的可信度。偏差越大 / 分散越大,誤判越多。
        err = abs(_bias_nm(comps)) + _peak_spread(comps)
        return perf, float(np.clip(1.0 - err / 16.0, 0.5, 1.0))

    def quality_fn(op, comps, tag_by):
        """測試站的「不良」= **判定為不合格而退回**的比例。

        誠實之處在於:退回的原因有兩種,而且**其中一種是冤枉的** ——
          · fixture_slip:夾具打滑 → 真的沒扭到規格 → 這批是真不良
          · sensor_out_of_cal:感測器漂到讓良品讀數落到允收帶外 → **這批是誤判**

        學生若只看退回率會以為上游品質變差,實際上是自己的量測系統該校正了。
        這是刻意設計的陷阱題(對應處置動作 calibrate_sensor 而非 replace_wear_part)。"""
        if not op["running"]:
            return 0.0, "torque_out_of_spec"
        bias = abs(_bias_nm(comps))
        spread = _peak_spread(comps)
        # 讀數落在允收帶外的機率:偏差把分布整條推出去,分散讓尾巴變厚
        z = max(0.0, (bias + 0.62 * spread - TOL_NM * 0.55)) / max(0.6, spread)
        p_fail = min(0.85, 0.02 + 0.30 * z)
        h_f = health_of(comps, "fixture_wear")
        h_s = health_of(comps, "torque_sensor_drift")
        dtype = "fixture_slip" if (1.0 - h_f) > (1.0 - h_s) else "sensor_out_of_cal"
        return max(0.004, p_fail), dtype

    device = Device(
        device_id=device_id, template="torque_tester", tags=tags,
        components=components, duty=duty, protocols=protocols, company_id=company_id,
        oee_fn=oee_fn, quality_fn=quality_fn, pre_step_fn=pre_step,
    )
    tag_by_name["state"].driver = lambda op, c, dt: float(STATE_CODES.get(device.state, 0))
    return device
