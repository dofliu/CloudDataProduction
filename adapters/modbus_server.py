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
_DATABLOCK_SIZE = 256    # 每個 slave 預留的暫存器/位元數(夠所有 tag 與衍生點位)


def _new_slave() -> "ModbusSlaveContext":
    """一台設備一個 slave context,四種 object type 各備一個資料區(co 留給 Phase B 線圈)。
    zero_mode:位址 0 對應 index 0,學生讀 register N 就拿到目錄上標的 N。"""
    return ModbusSlaveContext(
        di=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE),   # discrete input(FC02)
        co=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE),   # coil(FC01/05,Phase B)
        ir=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE),   # input register(FC04)
        hr=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE),   # holding register(FC03)
        zero_mode=True,
    )


def encode_value(datatype: str, value) -> list[int]:
    """tag 值 → register(s)。float32/int32 佔 2 個、int16 佔 1 個(big-endian)。
    channel_mux 與 multi_port 兩個 adapter 共用此編碼。"""
    builder = BinaryPayloadBuilder(byteorder=Endian.BIG, wordorder=Endian.BIG)
    if datatype == "int16":
        builder.add_16bit_int(int(value))
    elif datatype == "int32":
        builder.add_32bit_int(int(value))
    else:  # float32(預設)
        builder.add_32bit_float(float(value))
    return builder.to_registers()


def apply_device_to_slave(slave, device) -> None:
    """把一台設備所有唯讀點位寫進其 slave context,兩個 Modbus adapter 共用:
      - holding register(FC03):量測(float32 / int16 / int32)
      - discrete input(FC02):狀態旗標 bit
      - input register(FC04):唯讀 int(狀態碼 / 量測縮放鏡像)
    setValues 的第一個參數是 function code:3=holding、2=discrete input、4=input register。"""
    for tag in device.tags:
        try:
            slave.setValues(3, tag.modbus_register, encode_value(tag.datatype, tag.value))
        except Exception as exc:  # 單一點位失敗不應中斷整批
            print(f"[modbus] {device.id}.{tag.name} 編碼失敗:{exc}")
    for p in device.discrete_inputs:
        try:
            slave.setValues(2, p.di_address, [1 if p.value else 0])
        except Exception as exc:
            print(f"[modbus] {device.id}.di.{p.name} 失敗:{exc}")
    for p in device.input_registers:
        try:
            slave.setValues(4, p.ir_address, encode_value(p.datatype, p.value))
        except Exception as exc:
            print(f"[modbus] {device.id}.ir.{p.name} 失敗:{exc}")


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
                self._slaves[unit_id] = _new_slave()
        if not self._slaves:                      # 沒有任何 Modbus 設備時也給一個預設 slave
            self._slaves[1] = _new_slave()

        self.context = ModbusServerContext(slaves=self._slaves, single=False)
        self._server_task: asyncio.Task | None = None

    # ── 訂閱者:每 tick 把 snapshot 寫進 registers ──────────
    async def on_snapshot(self, snapshot: dict) -> None:
        for device in self.world.devices.values():
            unit_id = (device.protocols.get("modbus", {}) or {}).get("unit_id", 1)
            slave = self._slaves.get(unit_id)
            if slave is None:
                continue
            apply_device_to_slave(slave, device)   # holding + discrete input + input register

    # ── 啟動 ────────────────────────────────────────────────
    async def start(self) -> None:
        """啟動 async TCP server(會持續執行直到被取消)。"""
        units = sorted(self._slaves)
        print(f"[modbus] TCP server 啟動於 {self.host}:{self.port},unit_id={units}")
        await StartAsyncTcpServer(context=self.context, address=(self.host, self.port))

    def start_background(self) -> asyncio.Task:
        self._server_task = asyncio.create_task(self.start())
        return self._server_task
