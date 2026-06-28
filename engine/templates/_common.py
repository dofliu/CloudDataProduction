"""template 共用積木:tag 自動配址、退化元件批次建構。

各產業 template 共用這些函式,避免重複 register 配址與元件建構邏輯。
"""
from __future__ import annotations

from typing import Iterable

import numpy as np

from ..device import Tag
from ..health import DegradationComponent


def build_tags(tag_spec: Iterable[tuple], modbus_base: int, opcua_folder: str) -> list[Tag]:
    """依 (name, unit, datatype) 規格自動配 Modbus register。

    float32 / int32 佔 2 個暫存器、int16 佔 1 個;同時填 opcua_node 與 mqtt_field。
    """
    tags: list[Tag] = []
    reg = modbus_base
    for name, unit, dtype in tag_spec:
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


def build_components(
    cfg: dict,
    indicator_names: set[str],
    rng: np.random.Generator,
    defaults: dict | None = None,
) -> list[DegradationComponent]:
    """由場景 YAML 的 degradation 區塊批次建退化元件。

    YAML 未指定 degradation 時退回 template 預設(defaults),並對 init_health / rate
    做個體差異抖動 → 同型設備壽命有分散(學生模型要泛化而非背一條曲線)。
    indicator_names 內的元件預設 **不** 判定設備故障(指標型,如刀具 / 濾網)。
    """
    spec = cfg.get("degradation") or defaults or {}
    jitter = not cfg.get("degradation")   # 用預設時才抖動(YAML 明寫的尊重原值)
    comps: list[DegradationComponent] = []
    for name, dc in spec.items():
        rate = dc["rate"]
        init_h = dc.get("init_health", 1.0)
        if jitter:
            rate = rate * float(0.85 + 0.30 * rng.random())
            init_h = float(min(1.0, max(0.6, init_h * (0.90 + 0.10 * rng.random()))))
        comps.append(
            DegradationComponent(
                name=name,
                rate=rate,
                trajectory=dc.get("trajectory", "linear"),
                sigma=dc.get("sigma", 0.0),
                D_fail=dc.get("D_fail", 1.0),
                failure_threshold=dc.get("failure_threshold", 0.0),
                init_health=init_h,
                k=dc.get("k", 3.0),
                causes_device_fault=dc.get("causes_device_fault", name not in indicator_names),
                seed=int(rng.integers(0, 2**31)),
            )
        )
    return comps
