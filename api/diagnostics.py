"""協定連線自測 / 戰情版(docs/05 §參考客戶端儀表板)。

老師的「標準答案」client:**真的用 Modbus / OPC-UA / MQTT 當 client 連回自己的 server**,
逐設備讀一個樣本值,回報每設備 × 每協定的連得上/讀到值/延遲。
所以同時是「伺服器到底通不通」的自測,也是「以協定列出設備」的戰情版。

連的是 127.0.0.1 + 各協定實際埠(loopback)。容錯:單一設備或協定失敗不影響其他。
"""
from __future__ import annotations

import asyncio
import json
import time

from engine.device import Device
from engine.world import World


def _sample_tag(device: Device):
    """挑一個有代表性的 float32 tag 來讀(vibration_rms / battery_soc / 第一個 float)。"""
    by_name = {t.name: t for t in device.tags}
    for name in ("vibration_rms", "battery_soc", "outlet_pressure"):
        if name in by_name and by_name[name].datatype == "float32":
            return by_name[name]
    for t in device.tags:
        if t.datatype == "float32":
            return t
    return device.tags[0]


# ── Modbus ──────────────────────────────────────────────────
async def check_modbus(world: World, host: str, port: int) -> list[dict]:
    from pymodbus.client import AsyncModbusTcpClient
    from pymodbus.constants import Endian
    from pymodbus.payload import BinaryPayloadDecoder

    devices = list(world.devices.values())
    client = AsyncModbusTcpClient(host, port=port)
    try:
        await asyncio.wait_for(client.connect(), timeout=3)
        if not client.connected:
            raise ConnectionError("未連上")
    except Exception as e:
        return [{"device": d.id, "ok": False, "error": f"connect: {e}"} for d in devices]

    results = []
    for d in devices:
        unit = (d.protocols.get("modbus", {}) or {}).get("unit_id")
        tag = _sample_tag(d)
        t0 = time.perf_counter()
        try:
            if unit is None:
                raise ValueError("無 unit_id")
            rr = await asyncio.wait_for(
                client.read_holding_registers(tag.modbus_register, count=2, slave=unit), timeout=2)
            if rr.isError():
                raise IOError(str(rr))
            dec = BinaryPayloadDecoder.fromRegisters(rr.registers, byteorder=Endian.BIG, wordorder=Endian.BIG)
            val = dec.decode_32bit_float()
            results.append({"device": d.id, "addr": f"unit {unit} / reg {tag.modbus_register}",
                            "tag": tag.name, "value": round(val, 2), "ok": True,
                            "latency_ms": round((time.perf_counter() - t0) * 1000, 1)})
        except Exception as e:
            results.append({"device": d.id, "addr": f"unit {unit}", "tag": tag.name,
                            "ok": False, "error": str(e)})
    client.close()
    return results


# ── Modbus multi_port(每台專屬埠)─────────────────────────
async def check_modbus_multiport(world: World, host: str, port_map: dict) -> list[dict]:
    from pymodbus.client import AsyncModbusTcpClient
    from pymodbus.constants import Endian
    from pymodbus.payload import BinaryPayloadDecoder

    results = []
    for d in world.devices.values():
        port = port_map.get(d.id)
        tag = _sample_tag(d)
        if port is None:
            results.append({"device": d.id, "ok": False, "error": "無專屬埠(熱載入需重啟)"})
            continue
        t0 = time.perf_counter()
        client = AsyncModbusTcpClient(host, port=port)
        try:
            await asyncio.wait_for(client.connect(), timeout=2)
            rr = await asyncio.wait_for(
                client.read_holding_registers(tag.modbus_register, count=2, slave=1), timeout=2)
            if rr.isError():
                raise IOError(str(rr))
            dec = BinaryPayloadDecoder.fromRegisters(rr.registers, byteorder=Endian.BIG, wordorder=Endian.BIG)
            results.append({"device": d.id, "addr": f"port {port} / reg {tag.modbus_register}",
                            "tag": tag.name, "value": round(dec.decode_32bit_float(), 2), "ok": True,
                            "latency_ms": round((time.perf_counter() - t0) * 1000, 1)})
        except Exception as e:
            results.append({"device": d.id, "addr": f"port {port}", "tag": tag.name, "ok": False, "error": str(e)})
        finally:
            client.close()
    return results


# ── OPC-UA ──────────────────────────────────────────────────
async def check_opcua(world: World, endpoint: str) -> list[dict]:
    from asyncua import Client

    devices = list(world.devices.values())
    client = Client(endpoint)
    try:
        await asyncio.wait_for(client.connect(), timeout=4)
    except Exception as e:
        return [{"device": d.id, "ok": False, "error": f"connect: {e}"} for d in devices]

    results = []
    try:
        ns = await client.get_namespace_index("http://clouddata.dof")
        for d in devices:
            folder = (d.protocols.get("opcua", {}) or {}).get("node_folder", f"{d.company_id}/{d.id}")
            tag = _sample_tag(d)
            t0 = time.perf_counter()
            try:
                path = [f"{ns}:{p}" for p in folder.split("/")] + [f"{ns}:{tag.name}"]
                node = await client.nodes.objects.get_child(path)
                val = await asyncio.wait_for(node.read_value(), timeout=2)
                results.append({"device": d.id, "addr": f"{folder}/{tag.name}", "tag": tag.name,
                                "value": round(float(val), 2), "ok": True,
                                "latency_ms": round((time.perf_counter() - t0) * 1000, 1)})
            except Exception as e:
                results.append({"device": d.id, "addr": folder, "tag": tag.name,
                                "ok": False, "error": "節點不存在(熱載入設備需重啟)" if "BadNo" in str(e) or "child" in str(e).lower() else str(e)})
    finally:
        await client.disconnect()
    return results


# ── MQTT ────────────────────────────────────────────────────
async def check_mqtt(world: World, host: str, port: int) -> list[dict]:
    from amqtt.client import MQTTClient

    devices = list(world.devices.values())
    prefixes = {d.id: (d.protocols.get("mqtt", {}) or {}).get("topic_prefix", f"park/{d.company_id}/{d.id}")
                for d in devices}

    client = MQTTClient(config={"auto_reconnect": False})
    try:
        await asyncio.wait_for(client.connect(f"mqtt://{host}:{port}/"), timeout=3)
        await client.subscribe([("park/#", 0)])
    except Exception as e:
        return [{"device": d.id, "ok": False, "error": f"connect: {e}"} for d in devices]

    collected: dict[str, object] = {}
    try:
        deadline = time.perf_counter() + 2.0   # 發佈 ~2Hz,2 秒內應收齊
        while time.perf_counter() < deadline and len(collected) < len(devices):
            try:
                msg = await asyncio.wait_for(client.deliver_message(), timeout=1.0)
            except asyncio.TimeoutError:
                break
            topic = msg.topic
            did = next((i for i, pfx in prefixes.items() if topic.startswith(pfx + "/")), None)
            if did and did not in collected:
                try:
                    data = json.loads(bytes(msg.publish_packet.payload.data))
                    tag = _sample_tag(world.devices[did])
                    collected[did] = data.get("tags", {}).get(tag.name)
                except Exception:
                    collected[did] = None
    finally:
        await client.disconnect()

    results = []
    for d in devices:
        topic = prefixes[d.id] + "/state"
        if d.id in collected and isinstance(collected[d.id], (int, float)):
            results.append({"device": d.id, "addr": topic, "tag": _sample_tag(d).name,
                            "value": round(float(collected[d.id]), 2), "ok": True})
        else:
            results.append({"device": d.id, "addr": topic, "ok": False,
                            "error": "逾時未收到(熱載入或未發佈)"})
    return results


# ── 彙整 ────────────────────────────────────────────────────
async def run_diagnostics(world: World, host: str, ports: dict) -> dict:
    modbus, opcua, mqtt = await asyncio.gather(
        check_modbus(world, host, int(ports.get("modbus", 502))),
        check_opcua(world, f"opc.tcp://{host}:{int(ports.get('opcua', 4840))}/clouddata/"),
        check_mqtt(world, host, int(ports.get("mqtt", 1883))),
        return_exceptions=True,
    )

    def _norm(r):
        return r if isinstance(r, list) else [{"ok": False, "error": str(r)}]

    modbus, opcua, mqtt = _norm(modbus), _norm(opcua), _norm(mqtt)

    def _summary(rows, port):
        ok = sum(1 for r in rows if r.get("ok"))
        return {"reachable": ok, "total": len(rows), "port": port}

    protocols = {
        "modbus": {"summary": _summary(modbus, ports.get("modbus")), "devices": modbus},
        "opcua": {"summary": _summary(opcua, ports.get("opcua")), "devices": opcua},
        "mqtt": {"summary": _summary(mqtt, ports.get("mqtt")), "devices": mqtt},
    }

    # multi_port 啟用時,額外測每台設備的專屬埠
    port_map = getattr(world, "multiport_modbus", None)
    if port_map:
        mp = await check_modbus_multiport(world, host, port_map)
        if not isinstance(mp, list):
            mp = _norm(mp)
        ports_sorted = sorted(port_map.values())
        rng = f"{ports_sorted[0]}–{ports_sorted[-1]}" if ports_sorted else None
        protocols["modbus_multiport"] = {"summary": _summary(mp, rng), "devices": mp}

    return {"synthetic": True, "host": host, "protocols": protocols}
