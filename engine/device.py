"""Device 物件模型(docs/02 §6)。

Device = tags(可觀測訊號)+ degradation components(隱藏健康)+ duty cycle(運轉輪廓)。
每個 tick:依 duty 算運轉點 → 推進每個元件損傷 → 由 driver 算各 tag 值 → 更新狀態。
設備是唯一持有狀態者;adapters / API / 前端只是讀視圖。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from .health import DegradationComponent
from .sensor_faults import SensorFault

# 設備狀態 → Modbus 整數碼(adapter 用)。狀態本身在引擎以字串表示,人讀友善。
STATE_CODES: Dict[str, int] = {
    "idle": 0,
    "running": 1,
    "tool_change": 2,
    "alarm": 3,
    "fault": 4,
    "maintenance": 5,
    "moving": 6,      # AGV 移動中
    "charging": 7,    # AGV 充電中
    "blocked": 8,     # AGV 受阻
}


@dataclass
class Tag:
    """單一可觀測訊號。必含三協定映射欄位(docs/04),P0 只有 Modbus 真的被讀。"""

    name: str
    unit: str
    datatype: str                 # "float32" | "int16" | "int32"
    modbus_register: int          # holding register 起始位址
    opcua_node: str               # 形如 "c01/cnc-01/vibration_rms"(P1 用)
    mqtt_field: str               # 形如 "vibration_rms"(P1 用)
    # driver(op, components, dt_sim) -> value;由 template 用 signals.py 積木組出
    driver: Optional[Callable] = None
    value: float = 0.0

    @property
    def register_width(self) -> int:
        return 1 if self.datatype == "int16" else 2


@dataclass
class DiscretePoint:
    """唯讀離散輸入(Modbus FC02 / OPC-UA 布林 / MQTT 欄位)。值由 device 狀態推出,轉接層不自存。"""

    name: str
    di_address: int               # discrete input 位址(0-based)
    opcua_node: str
    mqtt_field: str
    fn: Callable                  # fn(device) -> bool
    value: bool = False


@dataclass
class InputRegPoint:
    """唯讀輸入暫存器(Modbus FC04)。可帶 scale 教「raw 整數 vs 工程單位」(EU = register / scale)。"""

    name: str
    unit: str
    datatype: str                 # "int16" | "int32"
    ir_address: int               # input register 起始位址(0-based)
    opcua_node: str
    mqtt_field: str
    fn: Callable                  # fn(device) -> int(已是要寫入 register 的整數)
    scale: float = 1.0
    value: float = 0.0

    @property
    def register_width(self) -> int:
        return 1 if self.datatype == "int16" else 2


class DutyProfile:
    """班表 / 負載輪廓,驅動運轉點(docs/02 §7)。

    產生「日週期 / 週週期」是刻意的:對時序模型是好訊號。退化只在 running 時累積
    (stress=0 when idle),所以兩班 vs 連續的設備壽命會不同 —— 真實且可教。
    """

    DAY = 86400.0  # 一個模擬日的秒數

    def __init__(self, profile: str = "continuous", load_nom: float = 70.0):
        self.profile = profile
        self.load_nom = float(load_nom)

    def operating_point(self, sim_t: float) -> dict:
        running, load_frac, speed_factor = self._schedule(sim_t)
        load = self.load_nom * load_frac if running else 0.0
        return {
            "running": running,
            "load": load,                 # %
            "load_nom": self.load_nom,
            "speed_factor": speed_factor,  # 相對額定轉速 0..1
        }

    def _schedule(self, sim_t: float):
        hour = (sim_t % self.DAY) / 3600.0          # 0..24 模擬時
        day_idx = int(sim_t // self.DAY)
        weekend = (day_idx % 7) in (5, 6)           # 第 6、7 天休息 → 週週期

        if self.profile == "continuous":
            # 連續運轉(如半導體),負載僅輕微起伏
            ripple = 1.0 + 0.05 * math.sin(2 * math.pi * hour / 24.0)
            return True, ripple, 1.0

        if self.profile == "single_shift":
            running = (not weekend) and (8.0 <= hour < 17.0)
        else:  # two_shift(預設離散製造)
            running = (not weekend) and (6.0 <= hour < 22.0)

        if not running:
            return False, 0.0, 0.0
        # 班內負載隨時段輕微變化(午後較高),製造可學的日內結構
        load_frac = 0.9 + 0.15 * math.sin(2 * math.pi * (hour - 6.0) / 16.0)
        return True, max(0.5, load_frac), 1.0


class Device:
    """一台設備。持有 tags / components / duty,每 tick 自我推進。"""

    def __init__(
        self,
        device_id: str,
        template: str,
        tags: List[Tag],
        components: List[DegradationComponent],
        duty: DutyProfile,
        protocols: Optional[dict] = None,
        company_id: Optional[str] = None,
        stress_a: float = 1.0,
        stress_b: float = 1.0,
        idle_stress: float = 0.0,
        state_fn: Optional[Callable] = None,
        pre_step_fn: Optional[Callable] = None,
        oee_fn: Optional[Callable] = None,
    ):
        self.id = device_id
        self.template = template
        self.tags = tags
        self.components: Dict[str, DegradationComponent] = {c.name: c for c in components}
        self.duty = duty
        self.protocols = protocols or {}
        self.company_id = company_id
        # 可選:由 template 提供的運轉狀態判定(非 fault 時)。回傳狀態字串,
        # 讓 AGV 之類能報 moving/charging,而非只有 running/idle。
        self.state_fn = state_fn
        # 可選:每 tick 在 tag drivers 之前執行一次的有狀態物理(如 AGV 移動/電池狀態機),
        # 讓多個 tag 共讀同一份整合結果,避免在各 driver 重複積分。
        self.pre_step_fn = pre_step_fn
        # 可選:OEE 瞬時訊號 oee_fn(op, components) → (performance, quality),各 0..1
        self.oee_fn = oee_fn
        # OEE 累積器(對 sim 時間積):運轉/停機時間、運轉時 perf/qual 的時間加權和
        self._oee_run = 0.0
        self._oee_down = 0.0
        self._oee_perf_acc = 0.0
        self._oee_qual_acc = 0.0
        # 應力指數:s = (load/load_nom)^a · speed_factor^b(docs/02 §1)
        self.stress_a = float(stress_a)
        self.stress_b = float(stress_b)
        self.idle_stress = float(idle_stress)  # 待機時的微量退化(預設 0:不轉不磨)

        self.state: str = "idle"
        self._fault_latched: bool = False
        self._sim_t: float = 0.0
        # 故障注入(老師面):感測器故障層 + 待生效注入佇列 + 故障起始時刻(ground-truth)
        self.sensor_faults: Dict[str, SensorFault] = {}
        self._pending_injections: List[dict] = []
        self._fault_onset_sim_t: Optional[float] = None
        self._injected: List[dict] = []   # 已生效的注入紀錄(供 ground-truth 顯示)

        # 唯讀衍生點位:離散輸入(狀態 bit,FC02)+ 輸入暫存器(狀態碼 / 量測鏡像,FC04)。
        # 自 tags + state 自動產生,模板無需逐一宣告;轉接層只讀不存(鐵則 #1)。
        self.discrete_inputs: List[DiscretePoint] = []
        self.input_registers: List[InputRegPoint] = []
        self._build_derived_points()

    # ── 唯讀衍生點位(DI / IR)──────────────────────────────
    def _build_derived_points(self) -> None:
        folder = (self.protocols.get("opcua", {}) or {}).get(
            "node_folder", f"{self.company_id}/{self.id}")
        # 離散輸入:狀態旗標(唯讀 bit)
        di_specs = [
            ("running", lambda d: d.state in ("running", "moving")),
            ("fault", lambda d: d.state == "fault"),
            ("idle", lambda d: d.state == "idle"),
            ("warning", lambda d: d.state in ("alarm", "maintenance", "blocked", "tool_change")),
            ("heartbeat", lambda d: True),   # 通訊心跳:恆為 1,教「always-on bit」
        ]
        for i, (name, fn) in enumerate(di_specs):
            self.discrete_inputs.append(DiscretePoint(
                name=name, di_address=i,
                opcua_node=f"{folder}/di_{name}", mqtt_field=f"di_{name}", fn=fn))
        # 輸入暫存器:state_code(int16 狀態碼)+ 第一個 float 的縮放鏡像 + 第一個 int32 累計量
        irs: List[InputRegPoint] = [InputRegPoint(
            name="state_code", unit="enum", datatype="int16", ir_address=0,
            opcua_node=f"{folder}/ir_state_code", mqtt_field="ir_state_code",
            fn=lambda d: STATE_CODES.get(d.state, 0), scale=1.0)]
        addr = 1
        first_float = next((t for t in self.tags if t.datatype == "float32"), None)
        if first_float is not None:   # int32 定點 ×100:同一物理量,不同 object/型別/縮放(教 raw vs EU)
            irs.append(InputRegPoint(                 # 用 int32 避免大值(如 8000 rpm)溢位
                name=f"{first_float.name}_x100", unit=first_float.unit, datatype="int32",
                ir_address=addr, opcua_node=f"{folder}/ir_{first_float.name}_x100",
                mqtt_field=f"ir_{first_float.name}_x100",
                fn=lambda d, t=first_float: int(round(t.value * 100)), scale=100.0))
            addr += 2
        first_i32 = next((t for t in self.tags if t.datatype == "int32"), None)
        if first_i32 is not None:     # int32 累計量(shot_count / total_energy)鏡像
            irs.append(InputRegPoint(
                name=first_i32.name, unit=first_i32.unit, datatype="int32",
                ir_address=addr, opcua_node=f"{folder}/ir_{first_i32.name}",
                mqtt_field=f"ir_{first_i32.name}",
                fn=lambda d, t=first_i32: int(t.value), scale=1.0))
            addr += 2
        self.input_registers = irs

    def _update_derived_points(self) -> None:
        for p in self.discrete_inputs:
            try:
                p.value = bool(p.fn(self))
            except Exception:
                p.value = False
        for p in self.input_registers:
            try:
                p.value = p.fn(self)
            except Exception:
                p.value = 0

    # ── 運轉點 → 應力 ───────────────────────────────────────
    def _stress(self, op: dict) -> float:
        if not op["running"]:
            return self.idle_stress
        load_ratio = op["load"] / max(1e-6, op["load_nom"])
        return (load_ratio ** self.stress_a) * (op["speed_factor"] ** self.stress_b)

    # ── 推進一步 ────────────────────────────────────────────
    def step(self, dt_sim: float) -> None:
        # sim_t 由 world 在呼叫前注入(見 world.step / set_sim_t),duty cycle 需要絕對時間
        self._apply_pending_injections()
        op = self.duty.operating_point(self._sim_t)
        # 有狀態物理先跑一次(tag drivers 之後才讀其結果)
        if self.pre_step_fn is not None:
            self.pre_step_fn(dt_sim, op)
        stress = self._stress(op)

        for comp in self.components.values():
            comp.step(dt_sim, stress)

        for tag in self.tags:
            if tag.driver is not None:
                tag.value = tag.driver(op, self.components, dt_sim)

        # 感測器故障層:套在真實訊號之後,完全不動 health(ground-truth 仍乾淨)
        for tag in self.tags:
            sf = self.sensor_faults.get(tag.name)
            if sf is not None:
                tag.value = sf.apply(tag.value, self._sim_t, dt_sim)

        self._update_state(op)
        self._accumulate_oee(dt_sim, op)
        self._update_derived_points()   # 狀態/量測底定後,更新衍生 DI/IR 值

    def _accumulate_oee(self, dt_sim: float, op: dict) -> None:
        """OEE 累積:故障算停機;運轉算可用時間並加權 perf/qual;待機(off-shift)不計入。"""
        if dt_sim <= 0.0:
            return
        if self._fault_latched:
            self._oee_down += dt_sim
        elif op["running"]:
            self._oee_run += dt_sim
            perf, qual = self.oee_fn(op, self.components) if self.oee_fn else (1.0, 1.0)
            self._oee_perf_acc += float(perf) * dt_sim
            self._oee_qual_acc += float(qual) * dt_sim

    def oee(self) -> dict:
        """OEE = 可用率 × 表現 × 良率(都從 ground-truth 累積,老師面)。"""
        planned = self._oee_run + self._oee_down
        availability = self._oee_run / planned if planned > 0 else 1.0
        performance = self._oee_perf_acc / self._oee_run if self._oee_run > 0 else 1.0
        quality = self._oee_qual_acc / self._oee_run if self._oee_run > 0 else 1.0
        return {
            "device": self.id,
            "availability": round(availability, 3),
            "performance": round(min(1.0, performance), 3),
            "quality": round(min(1.0, quality), 3),
            "oee": round(availability * min(1.0, performance) * min(1.0, quality), 3),
            "run_h": round(self._oee_run / 3600.0, 1),
            "down_h": round(self._oee_down / 3600.0, 1),
        }

    def set_sim_t(self, sim_t: float) -> None:
        """world 在 step 前注入當前模擬時間(duty cycle 需要絕對時間)。"""
        self._sim_t = sim_t

    def _update_state(self, op: dict) -> None:
        # 故障一旦發生即閂鎖,等待 reset / 維修(P0 不處置,僅觀察)
        device_failed = any(
            c.failed and c.causes_device_fault for c in self.components.values()
        )
        if device_failed and not self._fault_latched:
            self._fault_latched = True
            self._fault_onset_sim_t = self._sim_t   # 記真正故障起始時刻(算 lead time / 偵測延遲)
        if self._fault_latched:
            self.state = "fault"
        elif self.state_fn is not None:
            self.state = self.state_fn(op, self.components)
        elif op["running"]:
            self.state = "running"
        else:
            self.state = "idle"

    # ── 故障注入(老師面)────────────────────────────────────
    def inject_fault(self, fault_type: str, target: str, severity: float = 1.0,
                     onset_sim_s: Optional[float] = None, **params) -> dict:
        """注入故障。fault_type 以 'sensor_' 開頭 → target 是 tag;否則 target 是退化元件。
        onset_sim_s=None 表示立即生效。"""
        onset = onset_sim_s if onset_sim_s is not None else self._sim_t
        rec = {"fault_type": fault_type, "target": target,
               "severity": severity, "onset": onset, "params": params}
        self._pending_injections.append(rec)
        return {"device": self.id, "scheduled": rec}

    def _apply_pending_injections(self) -> None:
        if not self._pending_injections:
            return
        still = []
        for inj in self._pending_injections:
            if self._sim_t >= inj["onset"]:
                self._activate_injection(inj)
            else:
                still.append(inj)
        self._pending_injections = still

    def _activate_injection(self, inj: dict) -> None:
        ft, target, sev = inj["fault_type"], inj["target"], inj["severity"]
        if ft.startswith("sensor_"):
            self.sensor_faults[target] = SensorFault(
                ft, severity=sev, onset_sim_s=self._sim_t, **inj.get("params", {})
            )
            self._injected.append({"kind": "sensor", "tag": target, "type": ft,
                                   "severity": sev, "onset_sim_t": self._sim_t})
            return
        comp = self.components.get(target)
        if comp is None:
            return
        if ft == "sudden":
            comp.force_fail()
        else:  # gradual / intermittent / cascading:放大退化率(severity 0..1 → 1x..10x)
            comp.rate_multiplier = 1.0 + sev * 9.0
            if ft == "cascading":                       # 連鎖:同設備其他本體元件也略加速
                for c in self.components.values():
                    if c is not comp and c.causes_device_fault:
                        c.rate_multiplier = max(c.rate_multiplier, 1.0 + sev * 3.0)
        self._injected.append({"kind": "equipment", "component": target, "type": ft,
                               "severity": sev, "onset_sim_t": self._sim_t})

    def reset(self) -> dict:
        """reset / 維修:修復故障元件、清除感測器故障與注入,讓設備重新運轉。"""
        for c in self.components.values():
            c.reset_injection()
            if c.failed:
                c.D = (1.0 - 0.95) * c.D_fail        # 修復到 health≈0.95
        self.sensor_faults.clear()
        self._pending_injections.clear()
        self._injected.clear()
        self._fault_latched = False
        self._fault_onset_sim_t = None
        self.state = "idle"
        return {"device": self.id, "reset": True}

    # ── 視圖 ────────────────────────────────────────────────
    def public_snapshot(self) -> dict:
        """學生面:狀態 + 觀測 tag 值 + 衍生離散輸入 / 輸入暫存器。**不含** ground-truth。"""
        return {
            "id": self.id,
            "template": self.template,
            "state": self.state,
            "state_code": STATE_CODES.get(self.state, 0),
            "tags": {t.name: t.value for t in self.tags},
            "discretes": {p.name: bool(p.value) for p in self.discrete_inputs},
            "input_regs": {p.name: p.value for p in self.input_registers},
        }

    def ground_truth(self) -> dict:
        """老師面:每元件 health / RUL / 故障狀態(需 auth,學生面不可見)。"""
        op = self.duty.operating_point(getattr(self, "_sim_t", 0.0))
        stress = self._stress(op)
        comps = [c.ground_truth(stress) for c in self.components.values()]
        rul_vals = [c["rul_sim_s"] for c in comps if c["rul_sim_s"] is not None]
        rul = min(rul_vals) if rul_vals else None     # 全部待機 → RUL 未定義
        return {
            "id": self.id,
            "state": self.state,
            "rul_sim_s": rul,
            "fault_onset_sim_t": self._fault_onset_sim_t,   # 真正故障起始(算偵測延遲 / lead time)
            "components": comps,
            "sensor_faults": {tag: sf.info() for tag, sf in self.sensor_faults.items()},
            "is_sensor_fault": bool(self.sensor_faults),     # 是否有感測器層異常(讀值脫鉤真實)
            "injected": self._injected,
            "synthetic": True,  # 學術誠信:永遠標示為合成數據(docs/02 §4)
        }

    def catalog_entry(self) -> dict:
        """設備目錄(規格書):各 object type 的點位清單。供學生寫 client 用(docs/04)。
        holding(FC03,量測 float32/int)、discrete input(FC02,狀態 bit)、
        input register(FC04,唯讀 int,含縮放鏡像)。Coil(FC01/05)為 Phase B。"""
        return {
            "id": self.id,
            "template": self.template,
            "company_id": self.company_id,
            "protocols": self.protocols,
            "tags": [
                {
                    "name": t.name,
                    "unit": t.unit,
                    "datatype": t.datatype,
                    "object": "holding_register",
                    "fc": 3,
                    "access": "r",          # 引擎每 tick 覆寫,實質唯讀
                    "modbus_register": t.modbus_register,
                    "opcua_node": t.opcua_node,
                    "mqtt_field": t.mqtt_field,
                }
                for t in self.tags
            ],
            "discrete_inputs": [
                {
                    "name": p.name,
                    "object": "discrete_input",
                    "fc": 2,
                    "datatype": "bool",
                    "access": "ro",
                    "address": p.di_address,
                    "opcua_node": p.opcua_node,
                    "mqtt_field": p.mqtt_field,
                }
                for p in self.discrete_inputs
            ],
            "input_registers": [
                {
                    "name": p.name,
                    "unit": p.unit,
                    "object": "input_register",
                    "fc": 4,
                    "datatype": p.datatype,
                    "access": "ro",
                    "scale": p.scale,        # 工程單位 = register / scale
                    "address": p.ir_address,
                    "opcua_node": p.opcua_node,
                    "mqtt_field": p.mqtt_field,
                }
                for p in self.input_registers
            ],
        }
