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

# 設備狀態 → Modbus 整數碼(adapter 用)。狀態本身在引擎以字串表示,人讀友善。
STATE_CODES: Dict[str, int] = {
    "idle": 0,
    "running": 1,
    "tool_change": 2,
    "alarm": 3,
    "fault": 4,
    "maintenance": 5,
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
    ):
        self.id = device_id
        self.template = template
        self.tags = tags
        self.components: Dict[str, DegradationComponent] = {c.name: c for c in components}
        self.duty = duty
        self.protocols = protocols or {}
        self.company_id = company_id
        # 應力指數:s = (load/load_nom)^a · speed_factor^b(docs/02 §1)
        self.stress_a = float(stress_a)
        self.stress_b = float(stress_b)
        self.idle_stress = float(idle_stress)  # 待機時的微量退化(預設 0:不轉不磨)

        self.state: str = "idle"
        self._fault_latched: bool = False
        self._sim_t: float = 0.0

    # ── 運轉點 → 應力 ───────────────────────────────────────
    def _stress(self, op: dict) -> float:
        if not op["running"]:
            return self.idle_stress
        load_ratio = op["load"] / max(1e-6, op["load_nom"])
        return (load_ratio ** self.stress_a) * (op["speed_factor"] ** self.stress_b)

    # ── 推進一步 ────────────────────────────────────────────
    def step(self, dt_sim: float) -> None:
        # sim_t 由 world 在呼叫前注入(見 world.step / set_sim_t),duty cycle 需要絕對時間
        op = self.duty.operating_point(self._sim_t)
        stress = self._stress(op)

        for comp in self.components.values():
            comp.step(dt_sim, stress)

        for tag in self.tags:
            if tag.driver is not None:
                tag.value = tag.driver(op, self.components, dt_sim)

        self._update_state(op)

    def set_sim_t(self, sim_t: float) -> None:
        """world 在 step 前注入當前模擬時間(duty cycle 需要絕對時間)。"""
        self._sim_t = sim_t

    def _update_state(self, op: dict) -> None:
        # 故障一旦發生即閂鎖,等待 reset / 維修(P0 不處置,僅觀察)
        device_failed = any(
            c.failed and c.causes_device_fault for c in self.components.values()
        )
        if device_failed:
            self._fault_latched = True
        if self._fault_latched:
            self.state = "fault"
        elif op["running"]:
            self.state = "running"
        else:
            self.state = "idle"

    # ── 視圖 ────────────────────────────────────────────────
    def public_snapshot(self) -> dict:
        """學生面:狀態 + 觀測 tag 值。**不含** ground-truth。"""
        return {
            "id": self.id,
            "template": self.template,
            "state": self.state,
            "state_code": STATE_CODES.get(self.state, 0),
            "tags": {t.name: t.value for t in self.tags},
        }

    def ground_truth(self) -> dict:
        """老師面:每元件 health / RUL / 故障狀態(需 auth,學生面不可見)。"""
        op = self.duty.operating_point(getattr(self, "_sim_t", 0.0))
        stress = self._stress(op)
        comps = [c.ground_truth(stress) for c in self.components.values()]
        rul = min((c["rul_sim_s"] for c in comps), default=float("inf"))
        return {
            "id": self.id,
            "state": self.state,
            "rul_sim_s": rul,
            "components": comps,
            "synthetic": True,  # 學術誠信:永遠標示為合成數據(docs/02 §4)
        }

    def catalog_entry(self) -> dict:
        """設備目錄(規格書):協定定址 + tag 清單。供學生寫 client 用(docs/04)。"""
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
                    "modbus_register": t.modbus_register,
                    "opcua_node": t.opcua_node,
                    "mqtt_field": t.mqtt_field,
                }
                for t in self.tags
            ],
        }
