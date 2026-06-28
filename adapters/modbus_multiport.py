"""Modbus multi_port 轉接層(docs/01 §連接埠策略)。

**疊加在 channel_mux 之上**:除了共用埠(以 unit_id 分設備),再為每台設備各起一個
專屬埠的 single-unit Modbus server —— 讓每台設備像真實工業設備一樣,有自己的 IP:port。

學生因此能對比兩種定址思維,代價是要自己管理多條連線 / 資料管線(真實感更強)。
所有 server 讀同一份引擎 snapshot,自己不存狀態。埠由 base 起依設備順序遞增。
"""
from __future__ import annotations

import asyncio

from pymodbus.datastore import (
    ModbusSequentialDataBlock,
    ModbusServerContext,
    ModbusSlaveContext,
)
from pymodbus.server import StartAsyncTcpServer

from engine.world import World
from .modbus_server import apply_device_to_slave

_DATABLOCK_SIZE = 256


def _new_slave() -> ModbusSlaveContext:
    """專屬埠的 single-unit slave,四種 object type 各備一個資料區(co 留給 Phase B)。"""
    return ModbusSlaveContext(
        di=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE),
        co=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE),
        ir=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE),
        hr=ModbusSequentialDataBlock(0, [0] * _DATABLOCK_SIZE),
        zero_mode=True,
    )


class ModbusMultiPortAdapter:
    def __init__(self, world: World, host: str = "0.0.0.0", base_port: int = 6100):
        self.world = world
        self.host = host
        self.base_port = base_port

        # 依設備順序配專屬埠;single=True → 不論 client 填哪個 unit id 都回應(最寬容)
        self.port_map: dict[str, int] = {}
        self._slaves: dict[str, ModbusSlaveContext] = {}
        self._contexts: dict[str, ModbusServerContext] = {}
        port = base_port
        for device in world.devices.values():
            self.port_map[device.id] = port
            slave = _new_slave()
            self._slaves[device.id] = slave
            self._contexts[device.id] = ModbusServerContext(slaves=slave, single=True)
            port += 1
        self._tasks: list[asyncio.Task] = []

    # ── 訂閱者:每 tick 更新各設備專屬埠的 registers ────────
    async def on_snapshot(self, snapshot: dict) -> None:
        for device in self.world.devices.values():
            slave = self._slaves.get(device.id)
            if slave is None:                       # 熱載入設備無專屬埠(需重啟)
                continue
            apply_device_to_slave(slave, device)    # holding + discrete input + input register

    # ── 啟動:每台一個 server task ─────────────────────────
    def start_background(self) -> None:
        for device in self.world.devices.values():
            ctx = self._contexts[device.id]
            port = self.port_map[device.id]
            self._tasks.append(asyncio.create_task(
                StartAsyncTcpServer(context=ctx, address=(self.host, port))))
        ports = sorted(self.port_map.values())
        rng = f"{ports[0]}–{ports[-1]}" if ports else "(無)"
        print(f"[modbus-mp] {len(self._tasks)} 台專屬埠 Modbus server 啟動於 {self.host}:{rng}")

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        self._tasks = []
