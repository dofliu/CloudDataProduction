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
) -> list[DegradationComponent]:
    """由場景 YAML 的 degradation 區塊批次建退化元件。

    indicator_names 內的元件預設 **不** 判定設備故障(指標型,如刀具 / 濾網);
    其餘預設會讓設備進 fault(本體退化,如軸承)。皆可被 YAML 的 causes_device_fault 覆寫。
    每個元件給獨立種子 → 同型設備壽命有分散。
    """
    comps: list[DegradationComponent] = []
    for name, dc in (cfg.get("degradation", {}) or {}).items():
        comps.append(
            DegradationComponent(
                name=name,
                rate=dc["rate"],
                trajectory=dc.get("trajectory", "linear"),
                sigma=dc.get("sigma", 0.0),
                D_fail=dc.get("D_fail", 1.0),
                failure_threshold=dc.get("failure_threshold", 0.0),
                init_health=dc.get("init_health", 1.0),
                k=dc.get("k", 3.0),
                causes_device_fault=dc.get("causes_device_fault", name not in indicator_names),
                seed=int(rng.integers(0, 2**31)),
            )
        )
    return comps
