"""P0 學生連線範例:查設備目錄 → 連 Modbus → 解碼 → 持續監看。

這正是學生在課堂要做的事:先看規格書(/api/catalog)知道每個 tag 在哪個 register、
什麼型別,再自己寫 client 連線抓資料。本檔也兼作 P0 驗收腳本 ——
跑起來應看見 vibration_rms 隨時間上升,最後 state 跳 fault(4)。

用法:
    python student_kit/p0_modbus_reader.py
    python student_kit/p0_modbus_reader.py --host 127.0.0.1 --port 5020 --unit 1 \
        --api http://127.0.0.1:8000/api/catalog --tags vibration_rms spindle_current spindle_temp state

只依賴 pymodbus(連線)與標準函式庫(查目錄),學生環境最小化。
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request

from pymodbus.client import ModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadDecoder

# 查不到目錄時的後備 register 對照(與 CNC template 一致)
_FALLBACK = {
    "state": (0, "int16"),
    "spindle_speed": (1, "float32"),
    "spindle_load": (3, "float32"),
    "spindle_current": (5, "float32"),
    "spindle_temp": (7, "float32"),
    "vibration_rms": (9, "float32"),
    "tool_wear": (11, "float32"),
    "coolant_temp": (13, "float32"),
    "cycle_time": (15, "float32"),
    "part_count": (17, "int32"),
}
_STATE_NAME = {0: "idle", 1: "running", 2: "tool_change", 3: "alarm", 4: "fault", 5: "maint"}


def fetch_tag_map(api_url: str, unit_id: int) -> dict:
    """從 /api/catalog 撈某 unit_id 設備的 tag → (register, datatype)。失敗則用後備表。"""
    try:
        with urllib.request.urlopen(api_url, timeout=3) as resp:
            catalog = json.loads(resp.read().decode("utf-8"))
        for dev in catalog.get("devices", []):
            if (dev.get("connection", {}).get("modbus", {}) or {}).get("unit_id") == unit_id:
                return {t["name"]: (t["modbus_register"], t["datatype"]) for t in dev["tags"]}
        print(f"[reader] 目錄中找不到 unit_id={unit_id},改用後備表")
    except Exception as exc:
        print(f"[reader] 查目錄失敗({exc}),改用後備表")
    return dict(_FALLBACK)


def decode(registers: list[int], datatype: str):
    dec = BinaryPayloadDecoder.fromRegisters(registers, byteorder=Endian.BIG, wordorder=Endian.BIG)
    if datatype == "int16":
        return dec.decode_16bit_int()
    if datatype == "int32":
        return dec.decode_32bit_int()
    return dec.decode_32bit_float()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=6020)
    ap.add_argument("--unit", type=int, default=1)
    ap.add_argument("--api", default="http://127.0.0.1:8077/api/catalog")
    ap.add_argument("--tags", nargs="*",
                    default=["state", "vibration_rms", "spindle_current", "spindle_temp", "tool_wear"])
    ap.add_argument("--interval", type=float, default=1.0)
    ap.add_argument("--count", type=int, default=0, help="讀幾次後結束(0=持續)")
    args = ap.parse_args()

    tag_map = fetch_tag_map(args.api, args.unit)
    tags = [t for t in args.tags if t in tag_map]
    print(f"[reader] 連線 {args.host}:{args.port} unit={args.unit},監看 {tags}")

    client = ModbusTcpClient(args.host, port=args.port)
    if not client.connect():
        print("[reader] 連線失敗")
        return

    n = 0
    try:
        while True:
            cols = []
            for name in tags:
                reg, dtype = tag_map[name]
                width = 1 if dtype == "int16" else 2
                rr = client.read_holding_registers(address=reg, count=width, slave=args.unit)
                if rr.isError():
                    cols.append(f"{name}=ERR")
                    continue
                val = decode(rr.registers, dtype)
                if name == "state":
                    cols.append(f"state={_STATE_NAME.get(int(val), val)}")
                else:
                    cols.append(f"{name}={val:8.3f}")
            print(f"t={time.strftime('%H:%M:%S')}  " + "  ".join(cols))

            n += 1
            if args.count and n >= args.count:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        pass
    finally:
        client.close()


if __name__ == "__main__":
    main()
