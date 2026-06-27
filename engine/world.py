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
        self._running = False
        self._last_snapshot: dict = {}

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

    # ── 訂閱 ────────────────────────────────────────────────
    def subscribe(self, callback: Subscriber) -> None:
        self._subscribers.append(callback)

    # ── 推進 ────────────────────────────────────────────────
    def step(self, dt_sim: float) -> dict:
        sim_t = self.clock.now()
        for device in self.devices.values():
            device.set_sim_t(sim_t)
            device.step(dt_sim)
        snapshot = self._make_snapshot()
        self._last_snapshot = snapshot
        return snapshot

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
                    print(f"[world] 訂閱者錯誤:{exc}")

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
            # 補上實際連線資訊:channel_mux 下 Modbus 共用埠,以 unit_id 分設備
            entry["connection"] = {
                "modbus": {
                    "host": host,
                    "port": self.ports.get("modbus"),
                    "unit_id": (d.protocols.get("modbus", {}) or {}).get("unit_id"),
                    "register_type": "holding",
                    "word_order": "big",
                    "byte_order": "big",
                    "note": "float32 佔 2 個連續暫存器(big-endian)",
                }
            }
            entries.append(entry)
        return {
            "park": self.park.get("name"),
            "protocol_mode": self.protocol_mode,
            "synthetic": True,  # 明確標示合成數據(docs/02 §4)
            "devices": entries,
        }
