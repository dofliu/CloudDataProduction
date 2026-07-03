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


class _WritableCoilBlock(ModbusSequentialDataBlock):
    """可寫線圈區(教師控制埠用):client 的 FC05/FC15 寫入 → on_write 轉成引擎命令;
    引擎每 tick 反射線圈狀態走 reflect() 旗標,不會回觸發 on_write。"""

    def __init__(self, size: int, on_write):
        super().__init__(0, [0] * size)
        self._on_write = on_write
        self._reflecting = False

    def setValues(self, address, values):
        if not self._reflecting and self._on_write is not None:
            try:
                self._on_write(address, list(values))   # 來自 client 的寫入 → 引擎命令
            except Exception as exc:
                print(f"[modbus-coil] 寫入處理失敗:{exc}")
        super().setValues(address, values)


def _coil_writer(device):
    """產生某設備的線圈寫入處理器:依 co_address 找線圈名,呼叫 device.set_coil。"""
    addr_map = {c.co_address: c.name for c in device.command_coils}

    def on_write(address, values):
        for i, v in enumerate(values):
            name = addr_map.get(address + i)
            if name is not None:
                device.set_coil(name, bool(v))
    return on_write


def _new_slave(on_coil_write=None) -> "ModbusSlaveContext":
    """一台設備一個 slave context,四種 object type 各一個資料區。
    on_coil_write 有給(教師控制埠)→ coil 用可寫區;否則用一般區(學生埠 FC01 唯讀)。
    zero_mode:位址 0 對應 index 0,學生讀 register N 就拿到目錄上標的 N。"""
    co = (_WritableCoilBlock(_DATABLOCK_SIZE, on_coil_write) if on_coil_write is not None
          else ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE))
    return ModbusSlaveContext(
        di=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE),   # discrete input(FC02)
        co=co,                                                    # coil(FC01 讀 / FC05 寫)
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
    # 線圈反射(FC01 唯讀視圖):可寫區要先抬 _reflecting,避免被當成 client 寫入回觸發
    co_block = getattr(slave, "store", {}).get("c")
    writable = isinstance(co_block, _WritableCoilBlock)
    if writable:
        co_block._reflecting = True
    try:
        for c in device.command_coils:
            slave.setValues(1, c.co_address, [1 if c.value else 0])
    except Exception as exc:
        print(f"[modbus] {device.id}.co 反射失敗:{exc}")
    finally:
        if writable:
            co_block._reflecting = False


class ModbusAdapter:
    def __init__(self, world: World, host: str = "0.0.0.0", port: int = 502,
                 writable_coils: bool = False):
        self.world = world
        self.host = host
        self.port = port
        self.writable_coils = writable_coils   # 教師控制埠 → True(FC05 寫線圈轉引擎命令)

        # 為每個 unit_id 建一個 slave context(zero_mode:位址 0 對應 index 0,
        # 學生讀 holding register N 就拿到目錄上標的 register N)。
        # writable_coils 時,每台的 coil 區綁定該設備的寫入處理器。
        self._slaves: Dict[int, ModbusSlaveContext] = {}
        for device in world.devices.values():
            unit_id = (device.protocols.get("modbus", {}) or {}).get("unit_id", 1)
            if unit_id not in self._slaves:
                on_write = _coil_writer(device) if writable_coils else None
                self._slaves[unit_id] = _new_slave(on_coil_write=on_write)
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
                slave = self._hot_add(device, unit_id)   # 熱載入設備(NL/LLM 建廠)→ 動態建 slave
            apply_device_to_slave(slave, device)   # holding + discrete input + input register

    def _hot_add(self, device, unit_id: int) -> "ModbusSlaveContext":
        """執行時新增一台設備的 slave context。self._slaves 與 ModbusServerContext._slaves
        在 single=False 下是同一個 dict(見 pymodbus),塞進去即刻對連線中的 client 生效,不必重啟。"""
        on_write = _coil_writer(device) if self.writable_coils else None
        slave = _new_slave(on_coil_write=on_write)
        self._slaves[unit_id] = slave
        print(f"[modbus] 熱加設備 {device.id}(unit_id={unit_id})即時上線,免重啟")
        return slave

    # ── 啟動 ────────────────────────────────────────────────
    async def start(self) -> None:
        """啟動 async TCP server(會持續執行直到被取消)。"""
        units = sorted(self._slaves)
        kind = "教師控制埠(可寫線圈)" if self.writable_coils else "channel-mux"
        print(f"[modbus] TCP server({kind})啟動於 {self.host}:{self.port},unit_id={units}")
        await StartAsyncTcpServer(context=self.context, address=(self.host, self.port))

    def start_background(self) -> asyncio.Task:
        self._server_task = asyncio.create_task(self.start())
        return self._server_task
