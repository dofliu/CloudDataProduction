"""產業設備型別庫註冊表(docs/03)。

每個 template 是一支模組,匯出 ``build(device_id, cfg, company_id) -> Device``。
world.py 依場景 YAML 的 ``template`` 欄位查這張表來實例化設備。
P0 只有 CNC;P1 起逐步補空壓機 / AGV / 機械手臂 / 半導體腔體。
"""
from __future__ import annotations

from typing import Callable, Dict

from .cnc_machining_center import build as _build_cnc

# template 名稱 → builder
_REGISTRY: Dict[str, Callable] = {
    "cnc_machining_center": _build_cnc,
}


def get_builder(template_name: str) -> Callable:
    if template_name not in _REGISTRY:
        raise KeyError(
            f"未知設備 template:{template_name}。已註冊:{sorted(_REGISTRY)}"
        )
    return _REGISTRY[template_name]


def available_templates() -> list[str]:
    return sorted(_REGISTRY)
