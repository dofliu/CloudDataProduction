"""OPC-UA 轉接層(docs/01、docs/04)。

asyncua server,讀同一份引擎 snapshot,把每個 tag 映成位址空間節點。
channel-mux:用 node_folder(如 c01/cnc-01)分設備,完整路徑 Objects/<folder>/<tag>。
**自己不存狀態**;學生用任意 OPC-UA client 連 opc.tcp://host:4840 瀏覽即可。
"""
from __future__ import annotations

import logging

from asyncua import Server

from engine.world import World

logging.getLogger("asyncua").setLevel(logging.WARNING)  # 降低 asyncua 噪音


class OpcUaAdapter:
    def __init__(self, world: World, host: str = "0.0.0.0", port: int = 4840):
        self.world = world
        self.endpoint = f"opc.tcp://{host}:{port}/clouddata/"
        self.server = Server()
        self._idx = 0
        self._nodes: dict[str, dict[str, tuple]] = {}   # device_id -> {tag: (node, datatype)}
        self._di_nodes: dict[str, list[tuple]] = {}      # device_id -> [(point, node), ...]
        self._ir_nodes: dict[str, list[tuple]] = {}      # device_id -> [(point, node), ...]
        self._co_nodes: dict[str, list[tuple]] = {}      # device_id -> [(coil, node), ...]
        self._folders: dict[str, object] = {}
        self._started = False

    async def start(self) -> None:
        """初始化 server、建位址空間、啟動。須在訂閱 on_snapshot 之前 await。"""
        await self.server.init()
        self.server.set_endpoint(self.endpoint)
        self.server.set_server_name("CloudDataProduction OPC-UA (synthetic)")
        self._idx = await self.server.register_namespace("http://clouddata.dof")

        for device in self.world.devices.values():
            await self._add_device(device)

        await self.server.start()
        self._started = True
        print(f"[opcua] server 啟動於 {self.endpoint}")

    async def _add_device(self, device) -> None:
        """為一台設備建位址空間節點。start() 初建 + 熱載入(NL/LLM 建廠)時動態加 ——
        asyncua 支援 server 執行後再加 node,新設備立即可瀏覽,不必重啟。"""
        if device.id in self._nodes:
            return
        objects = self.server.nodes.objects
        folder_path = (device.protocols.get("opcua", {}) or {}).get(
            "node_folder", f"{device.company_id}/{device.id}"
        )
        folder = await self._ensure_folder(objects, folder_path)
        self._nodes[device.id] = {}
        for tag in device.tags:
            is_float = tag.datatype == "float32"
            initial = 0.0 if is_float else 0
            node = await folder.add_variable(self._idx, tag.name, initial)
            self._nodes[device.id][tag.name] = (node, tag.datatype)
        # 離散輸入(唯讀布林)+ 輸入暫存器(唯讀整數):與 Modbus FC02/FC04 對應
        self._di_nodes[device.id] = []
        for p in device.discrete_inputs:
            node = await folder.add_variable(self._idx, f"di_{p.name}", False)
            self._di_nodes[device.id].append((p, node))
        self._ir_nodes[device.id] = []
        for p in device.input_registers:
            leaf = p.opcua_node.rsplit("/", 1)[-1]
            node = await folder.add_variable(self._idx, leaf, 0)
            self._ir_nodes[device.id].append((p, node))
        # 命令線圈(唯讀布林反射;寫入走 REST/控制埠)
        self._co_nodes[device.id] = []
        for c in device.command_coils:
            node = await folder.add_variable(self._idx, f"co_{c.name}", False)
            self._co_nodes[device.id].append((c, node))

    async def _ensure_folder(self, objects, path: str):
        """依 'c01/cnc-01' 建巢狀資料夾,公司層共用。"""
        cur, key = objects, ""
        for part in path.split("/"):
            key = f"{key}/{part}" if key else part
            if key not in self._folders:
                self._folders[key] = await cur.add_folder(self._idx, part)
            cur = self._folders[key]
        return cur

    async def on_snapshot(self, snapshot: dict) -> None:
        if not self._started:
            return
        for device in self.world.devices.values():
            nodes = self._nodes.get(device.id)
            if not nodes:
                await self._add_device(device)          # 熱載入設備 → 動態建 node,立即可瀏覽
                nodes = self._nodes.get(device.id)
                if not nodes:
                    continue
            for tag in device.tags:
                node_dt = nodes.get(tag.name)
                if not node_dt:
                    continue
                node, dtype = node_dt
                try:
                    val = float(tag.value) if dtype == "float32" else int(tag.value)
                    await node.write_value(val)
                except Exception as exc:
                    print(f"[opcua] 寫 {device.id}.{tag.name} 失敗:{exc}")
            for p, node in self._di_nodes.get(device.id, []):
                try:
                    await node.write_value(bool(p.value))
                except Exception as exc:
                    print(f"[opcua] 寫 {device.id}.di.{p.name} 失敗:{exc}")
            for p, node in self._ir_nodes.get(device.id, []):
                try:
                    await node.write_value(int(p.value))
                except Exception as exc:
                    print(f"[opcua] 寫 {device.id}.ir.{p.name} 失敗:{exc}")
            for c, node in self._co_nodes.get(device.id, []):
                try:
                    await node.write_value(bool(c.value))
                except Exception as exc:
                    print(f"[opcua] 寫 {device.id}.co.{c.name} 失敗:{exc}")

    async def stop(self) -> None:
        if self._started:
            try:
                await self.server.stop()
            except Exception:
                pass
            self._started = False
