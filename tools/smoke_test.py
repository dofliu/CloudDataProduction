r"""Smoke test:對「正在執行」的世界做關鍵不變式檢查,回傳 0(全過)/ 1(有失敗)。

用途:
  - 部署後 / 排程器健康檢查:確認引擎、三協定、點位、命令線圈都正常。
  - CI:擴功能後跑一次抓回歸。

跑法(務必用 venv python):
    .\.venv\Scripts\python.exe tools\smoke_test.py
    .\.venv\Scripts\python.exe tools\smoke_test.py --api http://127.0.0.1:8077 --mb-port 6020

只依賴 stdlib(urllib)+ pymodbus(venv 內),不另外起服務 —— 測的是真正在跑的那個實例。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import time
import urllib.request

from pymodbus.client import ModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadDecoder

PASS, FAIL = "PASS", "FAIL"
results: list[tuple[str, str, str]] = []


def check(name: str, ok: bool, detail: str = ""):
    results.append((PASS if ok else FAIL, name, detail))
    print(f"  [{PASS if ok else FAIL}] {name}" + (f" — {detail}" if detail else ""))
    return ok


def get(url: str, timeout=5):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def decode_f32(regs):
    return BinaryPayloadDecoder.fromRegisters(regs, byteorder=Endian.BIG, wordorder=Endian.BIG).decode_32bit_float()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://127.0.0.1:8077")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--mb-port", type=int, default=6020)
    args = ap.parse_args()
    print(f"== smoke test @ {args.api} (Modbus {args.host}:{args.mb_port}) ==")

    # 1) REST 基本面
    try:
        park = get(f"{args.api}/api/park")
        ncomp = len(park.get("companies", []))
        check("park 可達且有公司", ncomp > 0, f"{ncomp} 間公司")
    except Exception as e:
        check("park 可達", False, str(e)); _exit()

    try:
        cat = get(f"{args.api}/api/catalog")
        devs = cat.get("devices", [])
        d0 = devs[0] if devs else {}
        has_all = all(k in d0 for k in ("tags", "discrete_inputs", "input_registers", "coils"))
        check("catalog 有設備且四種 object type 齊全", len(devs) > 0 and has_all,
              f"{len(devs)} 台,首台 keys={[k for k in ('tags','discrete_inputs','input_registers','coils') if k in d0]}")
    except Exception as e:
        check("catalog 可達", False, str(e)); _exit()

    # 2) 三協定自測
    try:
        diag = get(f"{args.api}/api/diagnostics/protocols", timeout=30)
        for proto in ("modbus", "opcua"):
            s = diag["protocols"][proto]["summary"]
            check(f"{proto} 全可達", s["reachable"] == s["total"], f"{s['reachable']}/{s['total']}")
        smq = diag["protocols"]["mqtt"]["summary"]
        check("mqtt broker 有發佈", smq["reachable"] > 0, f"{smq['reachable']}/{smq['total']}")
    except Exception as e:
        check("diagnostics 可達", False, str(e))

    # 3) Modbus 實讀四種 object type(取第一台、unit 1)
    try:
        cli = ModbusTcpClient(args.host, port=args.mb_port)
        ok_conn = cli.connect()
        check("Modbus 連線", ok_conn)
        if ok_conn:
            # holding:state 在 reg0(int16),float 由 reg1 起 —— 讀 reg1 一個 float
            rr = cli.read_holding_registers(address=1, count=2, slave=1)
            val = None if rr.isError() else decode_f32(rr.registers)
            check("FC03 holding float 合理", val is not None and math.isfinite(val) and abs(val) < 1e6, f"reg1={val}")
            rd = cli.read_discrete_inputs(address=0, count=5, slave=1)
            check("FC02 discrete input 可讀", not rd.isError(), f"bits={list(rd.bits[:5]) if not rd.isError() else 'ERR'}")
            ri = cli.read_input_registers(address=0, count=1, slave=1)
            check("FC04 input register 可讀", not ri.isError(), f"state_code={ri.registers[0] if not ri.isError() else 'ERR'}")
            rc = cli.read_coils(address=0, count=2, slave=1)
            check("FC01 coil 可讀", not rc.isError(), f"coils={list(rc.bits[:2]) if not rc.isError() else 'ERR'}")
            cli.close()
    except Exception as e:
        check("Modbus 讀取", False, str(e))

    # 4) telemetry 有在前進(sim_t 兩次取樣應遞增)
    try:
        did = devs[0]["id"]
        t1 = get(f"{args.api}/api/park")["sim"]["sim_t"]
        time.sleep(6)   # > broadcast_interval_s,確保有新一拍
        t2 = get(f"{args.api}/api/park")["sim"]["sim_t"]
        check("sim 時鐘前進中", t2 > t1, f"{t1:.0f} → {t2:.0f}")
    except Exception as e:
        check("sim 時鐘", False, str(e))

    _exit()


def _exit():
    n_fail = sum(1 for r in results if r[0] == FAIL)
    print(f"\n== {len(results)-n_fail}/{len(results)} 通過 ==")
    sys.exit(1 if n_fail else 0)


if __name__ == "__main__":
    main()
