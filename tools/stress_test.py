"""壓力測試 —— 模擬多名學生同時連線,量系統在負載下的吞吐、延遲與穩定度。

並發三種負載打同一台 server:
  1. WebSocket /ws/telemetry 訂閱者(模擬多人開 2D 世界 / 儀表板)
  2. Modbus TCP 輪詢者(模擬多人寫 client 連設備)
  3. REST 打點(/api/catalog、/api/oee)

並量「壓力下 sim 時鐘有效倍率」是否掉(若世界迴圈被廣播拖慢,倍率會低於設定值)。

用法:python tools/stress_test.py --ws 80 --modbus 25 --rest 15 --secs 15
"""
from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
import urllib.request

import websockets
from pymodbus.client import AsyncModbusTcpClient
from pymodbus.constants import Endian
from pymodbus.payload import BinaryPayloadDecoder

API = "http://127.0.0.1:8077"
WS = "ws://127.0.0.1:8077/ws/telemetry"
MB_PORT = 5020


def pct(vals, q):
    if not vals:
        return None
    vals = sorted(vals)
    return round(vals[min(len(vals) - 1, int(q * len(vals)))], 2)


async def ws_client(stats, secs):
    try:
        async with websockets.connect(WS, open_timeout=8) as ws:
            stats["conn"] += 1
            end = time.monotonic() + secs
            while time.monotonic() < end:
                raw = await asyncio.wait_for(ws.recv(), timeout=6)
                m = json.loads(raw)
                stats["msgs"] += 1
                stats["lat"].append((time.time() - m["wall_t"]) * 1000.0)  # ms
    except Exception:
        stats["err"] += 1


async def modbus_client(stats, secs):
    c = AsyncModbusTcpClient("127.0.0.1", port=MB_PORT)
    try:
        await asyncio.wait_for(c.connect(), timeout=5)
        stats["conn"] += 1
        end = time.monotonic() + secs
        while time.monotonic() < end:
            t0 = time.perf_counter()
            rr = await asyncio.wait_for(c.read_holding_registers(9, count=2, slave=1), timeout=5)
            if rr.isError():
                stats["err"] += 1
                continue
            BinaryPayloadDecoder.fromRegisters(rr.registers, byteorder=Endian.BIG, wordorder=Endian.BIG).decode_32bit_float()
            stats["reads"] += 1
            stats["lat"].append((time.perf_counter() - t0) * 1000.0)
    except Exception:
        stats["err"] += 1
    finally:
        c.close()


async def rest_client(stats, secs, paths):
    end = time.monotonic() + secs
    i = 0
    while time.monotonic() < end:
        path = paths[i % len(paths)]; i += 1
        t0 = time.perf_counter()
        try:
            await asyncio.to_thread(lambda: urllib.request.urlopen(API + path, timeout=6).read())
            stats["reqs"] += 1
            stats["lat"].append((time.perf_counter() - t0) * 1000.0)
        except Exception:
            stats["err"] += 1


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ws", type=int, default=80)
    ap.add_argument("--modbus", type=int, default=25)
    ap.add_argument("--rest", type=int, default=15)
    ap.add_argument("--secs", type=float, default=15.0)
    args = ap.parse_args()

    clock0 = json.load(urllib.request.urlopen(API + "/api/sim/clock"))
    t0 = time.monotonic()

    ws_s = {"conn": 0, "msgs": 0, "err": 0, "lat": []}
    mb_s = {"conn": 0, "reads": 0, "err": 0, "lat": []}
    rest_s = {"reqs": 0, "err": 0, "lat": []}

    print(f"開始壓測:WS×{args.ws} + Modbus×{args.modbus} + REST×{args.rest},持續 {args.secs}s …")
    tasks = ([ws_client(ws_s, args.secs) for _ in range(args.ws)]
             + [modbus_client(mb_s, args.secs) for _ in range(args.modbus)]
             + [rest_client(rest_s, args.secs, ["/api/catalog", "/api/oee"]) for _ in range(args.rest)])
    await asyncio.gather(*tasks)

    t1 = time.monotonic()
    clock1 = json.load(urllib.request.urlopen(API + "/api/sim/clock"))
    wall = t1 - t0
    eff_mult = (clock1["sim_t"] - clock0["sim_t"]) / wall
    set_mult = clock1["multiplier"]

    print("\n===== 壓力測試結果 =====")
    print(f"時長 {wall:.1f}s")
    print(f"[WebSocket] 連上 {ws_s['conn']}/{args.ws}  收訊息 {ws_s['msgs']}（{ws_s['msgs']/wall:.0f}/s）"
          f"  延遲 p50={pct(ws_s['lat'],0.5)}ms p95={pct(ws_s['lat'],0.95)}ms  錯誤 {ws_s['err']}")
    print(f"[Modbus]    連上 {mb_s['conn']}/{args.modbus}  讀取 {mb_s['reads']}（{mb_s['reads']/wall:.0f}/s）"
          f"  延遲 p50={pct(mb_s['lat'],0.5)}ms p95={pct(mb_s['lat'],0.95)}ms  錯誤 {mb_s['err']}")
    print(f"[REST]      請求 {rest_s['reqs']}（{rest_s['reqs']/wall:.0f}/s）"
          f"  延遲 p50={pct(rest_s['lat'],0.5)}ms p95={pct(rest_s['lat'],0.95)}ms  錯誤 {rest_s['err']}")
    print(f"[Sim 時鐘]  設定倍率 {set_mult}×,壓力下有效倍率 {eff_mult:.0f}×"
          f"（{eff_mult/set_mult*100:.0f}% —— 接近 100% 表示世界迴圈未被拖慢)")


if __name__ == "__main__":
    asyncio.run(main())
