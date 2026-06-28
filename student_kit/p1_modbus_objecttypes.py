"""學生範例:一台設備、四種 Modbus object type 怎麼讀。

教學重點 ——「同一台設備,不同點位放在不同 object type / 資料型別,解讀方式就不同」:
  - Holding Register(FC03):量測值。float32 佔 2 格(big-endian,高字組在前);
    **第 1 格是 state(int16),所以 float 量測從第 2 格起算**(這是最常踩的雷)。
  - Discrete Input(FC02):狀態旗標 bit(唯讀),如 running / fault / idle。
  - Input Register(FC04):唯讀整數,如 state_code、量測的縮放鏡像(工程單位 = 值 / scale)。
  - Coil(FC01/05):命令 bit —— Phase B 才開放(教師碼可寫),本檔尚未示範。

每個點位的 object / fc / address 都在 /api/catalog 查得到,不要用猜的。

用法:
    python student_kit/p1_modbus_objecttypes.py --unit 2          # im-01(射出機)
    python student_kit/p1_modbus_objecttypes.py --host 127.0.0.1 --port 5020 --unit 2 \
        --api http://127.0.0.1:8077/api/catalog --count 5
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request

from pymodbus.client import ModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadDecoder

_STATE_NAME = {0: "idle", 1: "running", 2: "tool_change", 3: "alarm",
               4: "fault", 5: "maint", 6: "moving", 7: "charging", 8: "blocked"}


def fetch_device(api_url: str, unit_id: int) -> dict | None:
    """從 /api/catalog 撈某 unit_id 設備的完整規格(含三種 object type 點位)。"""
    try:
        with urllib.request.urlopen(api_url, timeout=3) as resp:
            catalog = json.loads(resp.read().decode("utf-8"))
        for dev in catalog.get("devices", []):
            if (dev.get("connection", {}).get("modbus", {}) or {}).get("unit_id") == unit_id:
                return dev
        print(f"[reader] 目錄找不到 unit_id={unit_id}")
    except Exception as exc:
        print(f"[reader] 查目錄失敗:{exc}")
    return None


def decode(registers: list[int], datatype: str):
    """big-endian(wordorder/byteorder 皆 BIG)→ 對應型別。"""
    dec = BinaryPayloadDecoder.fromRegisters(registers, byteorder=Endian.BIG, wordorder=Endian.BIG)
    if datatype == "int16":
        return dec.decode_16bit_int()
    if datatype == "int32":
        return dec.decode_32bit_int()
    return dec.decode_32bit_float()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5020)
    ap.add_argument("--unit", type=int, default=2)
    ap.add_argument("--api", default="http://127.0.0.1:8077/api/catalog")
    ap.add_argument("--interval", type=float, default=2.0)
    ap.add_argument("--count", type=int, default=0, help="讀幾次後結束(0=持續)")
    args = ap.parse_args()

    dev = fetch_device(args.api, args.unit)
    if dev is None:
        return
    holding = dev.get("tags", [])
    discretes = dev.get("discrete_inputs", [])
    input_regs = dev.get("input_registers", [])
    print(f"[reader] {dev['id']}({dev['template']}) @ {args.host}:{args.port} unit={args.unit}")
    print(f"         holding={len(holding)} 個、discrete_input={len(discretes)} 個、input_register={len(input_regs)} 個\n")

    client = ModbusTcpClient(args.host, port=args.port)
    if not client.connect():
        print("[reader] 連線失敗")
        return

    n = 0
    try:
        while True:
            print(f"── t={time.strftime('%H:%M:%S')} ──────────────────────")

            # FC03 Holding Register:量測(state 是 int16,float 由第 2 格起)
            print(" [FC03 holding]")
            for t in holding:
                width = 1 if t["datatype"] == "int16" else 2
                rr = client.read_holding_registers(address=t["modbus_register"], count=width, slave=args.unit)
                if rr.isError():
                    print(f"   {t['name']:<18} ERR"); continue
                val = decode(rr.registers, t["datatype"])
                shown = _STATE_NAME.get(int(val), val) if t["name"] == "state" else f"{val:.3f}"
                print(f"   {t['name']:<18} reg{t['modbus_register']:>2}/40{t['modbus_register']+1:03d}  {t['datatype']:<7} = {shown}")

            # FC02 Discrete Input:狀態旗標 bit
            if discretes:
                print(" [FC02 discrete input]")
                for p in discretes:
                    rr = client.read_discrete_inputs(address=p["address"], count=1, slave=args.unit)
                    bit = "ERR" if rr.isError() else (1 if rr.bits[0] else 0)
                    print(f"   {p['name']:<18} addr{p['address']:>2}/10{p['address']+1:03d}  bool    = {bit}")

            # FC04 Input Register:唯讀 int(含縮放鏡像)
            if input_regs:
                print(" [FC04 input register]")
                for p in input_regs:
                    width = 1 if p["datatype"] == "int16" else 2
                    rr = client.read_input_registers(address=p["address"], count=width, slave=args.unit)
                    if rr.isError():
                        print(f"   {p['name']:<18} ERR"); continue
                    raw = decode(rr.registers, p["datatype"])
                    eu = raw / p["scale"] if p.get("scale", 1) not in (0, 1) else raw
                    extra = f"  (÷{p['scale']} = {eu:.2f})" if p.get("scale", 1) not in (0, 1) else ""
                    print(f"   {p['name']:<18} addr{p['address']:>2}/30{p['address']+1:03d}  {p['datatype']:<7} = {raw}{extra}")

            print()
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
