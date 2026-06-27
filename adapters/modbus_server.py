"""Modbus TCP 轉接層(docs/01 §協定轉接、docs/04)。

讀同一份引擎 snapshot,把每個 tag 值編碼進 holding registers。**自己不存狀態**。
channel-mux:單一 TCP server,以 unit_id 分設備(P0 只有 unit_id=1)。
float32 佔 2 個連續暫存器(big-endian word/byte order),tag 的 register 位址由 template 配。

版本鎖定 pymodbus==3.6.9(見 CLAUDE.md)。Endian 用 3.6 的大寫 BIG/LITTLE。
"""
from __future__ import annotations

import asyncio
from typing import Dict

from pymodbus.constants import Endian
from pymodbus.datastore import (
    ModbusSequentialDataBlock,
    ModbusServerContext,
    ModbusSlaveContext,
)
from pymodbus.payload import BinaryPayloadBuilder
from pymodbus.server import StartAsyncTcpServer

from engine.world import World

_HOLDING_FC = 3          # function code 3 = read holding registers
_DATABLOCK_SIZE = 256    # 每個 slave 預留的 holding register 數(夠 P0 所有 tag)


class ModbusAdapter:
    def __init__(self, world: World, host: str = "0.0.0.0", port: int = 502):
        self.world = world
        self.host = host
        self.port = port

        # 為每個 unit_id 建一個 slave context(zero_mode:位址 0 對應 index 0,
        # 學生讀 holding register N 就拿到目錄上標的 register N)
        self._slaves: Dict[int, ModbusSlaveContext] = {}
        for device in world.devices.values():
            unit_id = (device.protocols.get("modbus", {}) or {}).get("unit_id", 1)
            if unit_id not in self._slaves:
                self._slaves[unit_id] = ModbusSlaveContext(
                    hr=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE),
                    zero_mode=True,
                )
        if not self._slaves:                      # 沒有任何 Modbus 設備時也給一個預設 slave
            self._slaves[1] = ModbusSlaveContext(
                hr=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE), zero_mode=True
            )

        self.context = ModbusServerContext(slaves=self._slaves, single=False)
        self._server_task: asyncio.Task | None = None

    # ── 編碼 ────────────────────────────────────────────────
    @staticmethod
    def _encode(datatype: str, value) -> list[int]:
        builder = BinaryPayloadBuilder(byteorder=Endian.BIG, wordorder=Endian.BIG)
        if datatype == "int16":
            builder.add_16bit_int(int(value))
        elif datatype == "int32":
            builder.add_32bit_int(int(value))
        else:  # float32(預設)
            builder.add_32bit_float(float(value))
        return builder.to_registers()

    # ── 訂閱者:每 tick 把 snapshot 寫進 registers ──────────
    async def on_snapshot(self, snapshot: dict) -> None:
        for device in self.world.devices.values():
            unit_id = (device.protocols.get("modbus", {}) or {}).get("unit_id", 1)
            slave = self._slaves.get(unit_id)
            if slave is None:
                continue
            for tag in device.tags:
                try:
                    regs = self._encode(tag.datatype, tag.value)
                    slave.setValues(_HOLDING_FC, tag.modbus_register, regs)
                except Exception as exc:  # 單一 tag 編碼失敗不應中斷整批
                    print(f"[modbus] tag {device.id}.{tag.name} 編碼失敗:{exc}")

    # ── 啟動 ────────────────────────────────────────────────
    async def start(self) -> None:
        """啟動 async TCP server(會持續執行直到被取消)。"""
        units = sorted(self._slaves)
        print(f"[modbus] TCP server 啟動於 {self.host}:{self.port},unit_id={units}")
        await StartAsyncTcpServer(context=self.context, address=(self.host, self.port))

    def start_background(self) -> asyncio.Task:
        self._server_task = asyncio.create_task(self.start())
        return self._server_task
