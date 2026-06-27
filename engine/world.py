"""世界:載入場景、持有所有設備、推進、廣播 snapshot(docs/01 資料流)。

World 是唯一持有狀態者。每個 tick:
  1. clock.advance(dt_wall) → dt_sim
  2. 每台 device.step(dt_sim)
  3. 組 snapshot,廣播給訂閱者(adapters / historian / 未來的 ws)
adapters / API / 前端都只是讀這份 snapshot 的視圖,自己不存狀態。
"""
from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Awaitable, Callable, Dict, List

import yaml

from .clock import SimClock
from .device import Device
from .templates import get_builder

# 訂閱者:async callback,每 tick 收到一份 snapshot
Subscriber = Callable[[dict], Awaitable[None]]


class World:
    def __init__(self, park: dict):
        self.park: dict = park
        sim = park.get("sim", {}) or {}
        self.clock = SimClock(
            time_multiplier=sim.get("time_multiplier", 1.0),
            tick_hz=sim.get("tick_hz", 10.0),
        )
        self.protocol_mode: str = park.get("protocol_mode", "channel_mux")
        self.ports: dict = park.get("ports", {"modbus": 502, "opcua": 4840, "mqtt": 1883})

        self.devices: Dict[str, Device] = {}
        self._build_devices()

        self._subscribers: List[Subscriber] = []
        self._event_subscribers: List[Subscriber] = []
        self._running = False
        self._last_snapshot: dict = {}
        self._prev_states: Dict[str, str] = {}      # 偵測狀態轉換用
        self._pending_events: List[dict] = []

    # ── 建構 ────────────────────────────────────────────────
    @classmethod
    def from_yaml(cls, path: str | Path) -> "World":
        data = yaml.safe_load(Path(path).read_text(encoding="utf-8"))
        if "park" not in data:
            raise ValueError(f"場景檔缺少 'park' 根節點:{path}")
        return cls(data["park"])

    def _build_devices(self) -> None:
        for company in self.park.get("companies", []) or []:
            cid = company.get("id")
            for dev_cfg in company.get("devices", []) or []:
                builder = get_builder(dev_cfg["template"])
                device = builder(dev_cfg["id"], dev_cfg, cid)
                if device.id in self.devices:
                    raise ValueError(f"設備 id 重複:{device.id}")
                self.devices[device.id] = device

    # ── 動態建廠(hot-add,docs/06)──────────────────────────
    def _next_unit_id(self) -> int:
        used = [(d.protocols.get("modbus", {}) or {}).get("unit_id", 0) for d in self.devices.values()]
        return max(used, default=0) + 1

    def add_company(self, company_cfg: dict) -> dict:
        """把一間新公司(含設備)即時加入世界:引擎推進、WS 廣播、目錄/工單/評分立即生效。
        原生協定 server 在啟動時建好,新設備需重啟 server 才會被 Modbus/OPC-UA/MQTT 暴露。"""
        cid = company_cfg.get("id") or f"c{len(self.park.get('companies', [])) + 1:02d}"
        company_cfg["id"] = cid
        company_cfg.setdefault("map_pos", {"x": 6 + 5 * len(self.park.get("companies", [])) % 20, "y": 20})
        company_cfg.setdefault("owner", None)

        uid = max(self._next_unit_id(), 50)   # 動態加的從 50 起,避開既有定址
        built = []
        for dev_cfg in company_cfg.get("devices", []) or []:
            did = dev_cfg["id"]
            if did in self.devices:
                did = f"{did}-{uid}"
                dev_cfg["id"] = did
            proto = dev_cfg.setdefault("protocols", {})
            proto.setdefault("modbus", {"unit_id": uid, "register_base": 0})
            proto.setdefault("opcua", {"node_folder": f"{cid}/{did}"})
            proto.setdefault("mqtt", {"topic_prefix": f"park/{cid}/{did}"})
            uid += 1
            device = get_builder(dev_cfg["template"])(did, dev_cfg, cid)
            device.hot_added = True
            self.devices[did] = device
            built.append(did)

        self.park.setdefault("companies", []).append(company_cfg)
        return {
            "company": cid, "name": company_cfg.get("name"), "devices": built,
            "note": "已即時加入:引擎/2D世界/WS/目錄/工單皆生效;"
                    "原生協定(Modbus/OPC-UA/MQTT)需重啟 server 才會暴露新設備。",
        }

    # ── 訂閱 ────────────────────────────────────────────────
    def subscribe(self, callback: Subscriber) -> None:
        """訂閱每 tick 的 telemetry snapshot。"""
        self._subscribers.append(callback)

    def subscribe_events(self, callback: Subscriber) -> None:
        """訂閱事件(狀態轉換 / 故障)。"""
        self._event_subscribers.append(callback)

    # ── 推進 ────────────────────────────────────────────────
    def step(self, dt_sim: float) -> dict:
        sim_t = self.clock.now()
        for device in self.devices.values():
            device.set_sim_t(sim_t)
            device.step(dt_sim)
        self._pending_events = self._detect_events(sim_t)
        snapshot = self._make_snapshot()
        self._last_snapshot = snapshot
        return snapshot

    def _detect_events(self, sim_t: float) -> List[dict]:
        """比對前一刻狀態,產生狀態轉換 / 故障事件(docs/04 §events)。"""
        events: List[dict] = []
        for device in self.devices.values():
            cur = device.state
            prev = self._prev_states.get(device.id)
            if prev is not None and cur != prev:
                if cur == "fault":
                    # 找出造成故障的元件(本體退化),附上型態供評分 / 顯示
                    failed = next(
                        (c.name for c in device.components.values()
                         if c.failed and c.causes_device_fault),
                        None,
                    )
                    events.append({
                        "type": "fault", "device": device.id, "company": device.company_id,
                        "component": failed, "fault_type": "gradual", "sim_t": sim_t,
                    })
                else:
                    events.append({
                        "type": "state_change", "device": device.id, "company": device.company_id,
                        "from": prev, "to": cur, "sim_t": sim_t,
                    })
            self._prev_states[device.id] = cur
        return events

    def _make_snapshot(self) -> dict:
        return {
            "wall_t": time.time(),
            "sim_t": self.clock.now(),
            "multiplier": self.clock.time_multiplier,
            "devices": {d.id: d.public_snapshot() for d in self.devices.values()},
        }

    async def run(self) -> None:
        """主迴圈:對 wall clock 取實際 dt,乘倍率推進 sim,確保加速時不漂移。"""
        self._running = True
        last = time.monotonic()
        while self._running:
            now = time.monotonic()
            dt_wall = now - last
            last = now

            dt_sim = self.clock.advance(dt_wall)
            snapshot = self.step(dt_sim)

            for cb in self._subscribers:
                try:
                    await cb(snapshot)
                except Exception as exc:  # 單一訂閱者出錯不應拖垮整個世界
                    print(f"[world] telemetry 訂閱者錯誤:{exc}")

            # 事件(狀態轉換 / 故障)在 telemetry 之後廣播
            for ev in self._pending_events:
                for cb in self._event_subscribers:
                    try:
                        await cb(ev)
                    except Exception as exc:
                        print(f"[world] event 訂閱者錯誤:{exc}")

            await asyncio.sleep(self.clock.target_dt)

    def stop(self) -> None:
        self._running = False

    # ── 視圖 ────────────────────────────────────────────────
    @property
    def last_snapshot(self) -> dict:
        return self._last_snapshot

    def park_view(self) -> dict:
        """GET /api/park:園區地圖 + 公司清單 + 認領狀態(docs/04)。"""
        companies = []
        for c in self.park.get("companies", []) or []:
            companies.append(
                {
                    "id": c.get("id"),
                    "name": c.get("name"),
                    "industry": c.get("industry"),
                    "owner": c.get("owner"),
                    "map_pos": c.get("map_pos"),
                    "device_ids": [d.get("id") for d in c.get("devices", []) or []],
                }
            )
        return {
            "name": self.park.get("name"),
            "protocol_mode": self.protocol_mode,
            "ports": self.ports,
            "sim": self.clock.snapshot(),
            "companies": companies,
        }

    def catalog(self, host: str = "<world-host>") -> dict:
        """GET /api/catalog:設備目錄(規格書)。學生據此寫 client 連線(docs/04)。"""
        entries = []
        for d in self.devices.values():
            entry = d.catalog_entry()
            mb = d.protocols.get("modbus", {}) or {}
            ua = d.protocols.get("opcua", {}) or {}
            mq = d.protocols.get("mqtt", {}) or {}
            folder = ua.get("node_folder", f"{d.company_id}/{d.id}")
            topic = mq.get("topic_prefix", f"park/{d.company_id}/{d.id}")
            # 補上實際連線資訊:channel_mux 下三協定各共用一埠,以 unit_id / folder / topic 分設備
            entry["connection"] = {
                "modbus": {
                    "host": host,
                    "port": self.ports.get("modbus"),
                    "unit_id": mb.get("unit_id"),
                    "register_type": "holding",
                    "word_order": "big",
                    "byte_order": "big",
                    "note": "float32 佔 2 個連續暫存器(big-endian)",
                },
                "opcua": {
                    "endpoint": f"opc.tcp://{host}:{self.ports.get('opcua')}/clouddata/",
                    "node_folder": folder,
                    "note": f"完整路徑 Objects/{folder}/<tag>",
                },
                "mqtt": {
                    "host": host,
                    "port": self.ports.get("mqtt"),
                    "topic": f"{topic}/state",
                    "note": "整包 JSON;訂閱 park/# 收全部",
                },
            }
            # multi_port 疊加層:每台設備的專屬 Modbus 埠(啟用時才有)
            mp = getattr(self, "multiport_modbus", None)
            if mp and d.id in mp:
                entry["connection"]["modbus_multiport"] = {
                    "host": host, "port": mp[d.id], "unit_id": "any",
                    "note": "專屬埠,一台一連線(multi_port);register 同 channel_mux",
                }
            entries.append(entry)
        return {
            "park": self.park.get("name"),
            "protocol_mode": self.protocol_mode,
            "synthetic": True,  # 明確標示合成數據(docs/02 §4)
            "devices": entries,
        }
