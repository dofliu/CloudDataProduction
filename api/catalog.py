"""設備目錄(規格書)組裝(docs/04 §公開學生面)。

學生面公開唯讀:學生據此知道每台設備的協定 / 埠 / unit_id / register / tag 清單,
才能自己寫 client 連線。**不含任何 ground-truth**。
"""
from __future__ import annotations

from engine.device import STATE_CODES, STOP_REASON_CODES
from engine.world import World


def build_catalog(world: World, host: str) -> dict:
    """回傳完整設備目錄。host = 學生連 Modbus 時要打的位址(LAN IP / Tailscale 位址)。"""
    catalog = world.catalog(host=host)
    # 列舉碼字典:state_code / stop_reason_code 是整數,學生要能查到它代表什麼。
    # 沒有這張表,「停機原因碼 = 3」對學生就只是一個數字。
    catalog["enums"] = {
        "state_code": {v: k for k, v in STATE_CODES.items()},
        "stop_reason_code": {v: k for k, v in STOP_REASON_CODES.items()},
    }
    catalog["hint"] = (
        "float32 佔 2 個連續 holding registers(big-endian word/byte order);"
        "channel_mux 模式下所有設備共用同一 Modbus 埠,以 unit_id 區分。"
    )
    return catalog
