"""MQTT 轉接層(docs/01、docs/04)。

純 Python:內嵌 amqtt broker(免 Docker / mosquitto),再以 amqtt client 把每台設備
整包狀態發到 `<topic_prefix>/state`。channel-mux:用 topic 前綴分設備。
**自己不存狀態**;學生用任意 MQTT client 訂閱 `park/#` 即可。

發佈節流到約 2 Hz(對外訂閱者足夠,不灌爆 broker)。
"""
from __future__ import annotations

import json
import logging

from amqtt.broker import Broker
from amqtt.client import MQTTClient

from engine.world import World

for name in ("amqtt", "transitions", "amqtt.broker", "amqtt.client"):
    logging.getLogger(name).setLevel(logging.WARNING)  # amqtt 預設很吵


class MqttPublisher:
    def __init__(self, world: World, host: str = "0.0.0.0", port: int = 1883,
                 publish_interval_s: float = 0.5):
        self.world = world
        self.host = host
        self.port = port
        self.publish_interval_s = publish_interval_s
        self._broker: Broker | None = None
        self._client: MQTTClient | None = None
        self._started = False
        self._last_pub_wall = 0.0

    def _topic_prefix(self, did: str) -> str:
        # 從引擎當前設備設定取 topic(熱載入新設備也一致),查不到才退回預設
        dev = self.world.devices.get(did)
        if dev is not None:
            return (dev.protocols.get("mqtt", {}) or {}).get("topic_prefix", f"park/{did}")
        return f"park/{did}"

    async def start(self) -> None:
        """啟動內嵌 broker 並連上 client。須在訂閱 on_snapshot 之前 await。"""
        config = {
            "listeners": {"default": {"type": "tcp", "bind": f"{self.host}:{self.port}"}},
            "sys_interval": 0,
            "auth": {"allow-anonymous": True},
        }
        self._broker = Broker(config)
        await self._broker.start()
        self._client = MQTTClient(config={"auto_reconnect": False})
        await self._client.connect(f"mqtt://127.0.0.1:{self.port}/")
        self._started = True
        print(f"[mqtt] 內嵌 broker 啟動於 {self.host}:{self.port},發佈 <topic_prefix>/state")

    async def on_snapshot(self, snapshot: dict) -> None:
        if not self._started or self._client is None:
            return
        wall_t = snapshot["wall_t"]
        if wall_t - self._last_pub_wall < self.publish_interval_s:
            return
        self._last_pub_wall = wall_t

        for did, dev in snapshot["devices"].items():
            topic = f"{self._topic_prefix(did)}/state"
            payload = json.dumps({
                "sim_t": snapshot["sim_t"], "state": dev["state"],
                "tags": dev["tags"], "synthetic": True,
            }).encode("utf-8")
            try:
                await self._client.publish(topic, payload, qos=0)
            except Exception as exc:
                print(f"[mqtt] 發佈 {topic} 失敗:{exc}")

    async def stop(self) -> None:
        if not self._started:
            return
        try:
            if self._client is not None:
                await self._client.disconnect()
            if self._broker is not None:
                await self._broker.shutdown()
        except Exception:
            pass
        self._started = False
