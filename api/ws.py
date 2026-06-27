"""WebSocket 即時面(docs/04 §WebSocket)。

兩條推送通道,都只是「讀引擎 snapshot / 事件」的視圖,自己不存狀態:
- /ws/telemetry:全設備 tag 即時值(2D 世界 + 儀表板訂閱)
- /ws/events:故障、狀態轉換等事件

連線管理器訂閱 world,收到資料就推給所有連線的瀏覽器;推送失敗的連線自動移除。
"""
from __future__ import annotations

import asyncio
from typing import Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect


class ConnectionManager:
    """維護一組 WebSocket 連線,並把訊息廣播出去。"""

    def __init__(self, name: str):
        self.name = name
        self._active: Set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._active.add(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._active.discard(ws)

    async def broadcast(self, message: dict) -> None:
        if not self._active:
            return
        dead = []
        for ws in list(self._active):
            try:
                await ws.send_json(message)
            except Exception:
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._active.discard(ws)

    # 給 world 訂閱用的 callback
    async def on_message(self, message: dict) -> None:
        await self.broadcast(message)

    @property
    def count(self) -> int:
        return len(self._active)


def register_ws_routes(
    app: FastAPI,
    telemetry: ConnectionManager,
    events: ConnectionManager,
) -> None:
    @app.websocket("/ws/telemetry")
    async def ws_telemetry(ws: WebSocket):
        await telemetry.connect(ws)
        try:
            while True:
                # 推送式通道:不需要客戶端傳東西,但要 await 以偵測斷線
                await ws.receive_text()
        except WebSocketDisconnect:
            await telemetry.disconnect(ws)
        except Exception:
            await telemetry.disconnect(ws)

    @app.websocket("/ws/events")
    async def ws_events(ws: WebSocket):
        await events.connect(ws)
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            await events.disconnect(ws)
        except Exception:
            await events.disconnect(ws)
