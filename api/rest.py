"""FastAPI:REST 控制面(docs/04 §REST API)。

P0 提供:園區 / 目錄 / 設備即時值 / 歷史查詢 / 讀寫模擬時鐘。
引擎主迴圈、Modbus server、Historian flush 都掛在同一進程的 lifespan 裡
(docs/01:REST + 引擎同進程)。教師面 auth 在 P0 先寬鬆(P2 起強制)。
"""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

from adapters.modbus_server import ModbusAdapter
from engine.world import World
from historian.writer import Historian
from .catalog import build_catalog


class ClockPatch(BaseModel):
    multiplier: Optional[float] = None
    paused: Optional[bool] = None


def create_app(
    world: World,
    historian: Historian,
    modbus: ModbusAdapter,
    config: dict,
) -> FastAPI:
    public_host = config.get("public_host", "127.0.0.1")

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # 啟動順序:先連 Historian,再把 adapter / historian 訂閱進世界,最後起世界迴圈
        await historian.connect()
        historian.start_background()
        world.subscribe(modbus.on_snapshot)
        world.subscribe(historian.on_snapshot)
        modbus.start_background()
        world_task = asyncio.create_task(world.run())
        print("[api] 世界已啟動,等待連線。")
        try:
            yield
        finally:
            world.stop()
            world_task.cancel()
            await historian.close()
            print("[api] 已關閉。")

    app = FastAPI(
        title="CloudDataProduction · 虛擬智慧工業區(P0)",
        description="合成(synthetic)工業設備數據教學平台。所有數據皆為模擬,非真實場域量測。",
        version="0.1.0-p0",
        lifespan=lifespan,
    )

    # ── 公開學生面 ─────────────────────────────────────────
    @app.get("/")
    def root():
        return {
            "name": "CloudDataProduction",
            "phase": "P0",
            "synthetic_data": True,
            "endpoints": ["/api/park", "/api/catalog", "/api/devices/{id}", "/api/history"],
        }

    @app.get("/api/park")
    def get_park():
        return world.park_view()

    @app.get("/api/catalog")
    def get_catalog():
        return build_catalog(world, host=public_host)

    @app.get("/api/devices/{device_id}")
    def get_device(device_id: str):
        device = world.devices.get(device_id)
        if device is None:
            raise HTTPException(404, f"無此設備:{device_id}")
        return device.public_snapshot()

    @app.get("/api/history")
    async def get_history(
        device: str = Query(..., description="設備 id"),
        tag: str = Query(..., description="tag 名稱,如 vibration_rms"),
        from_: Optional[float] = Query(None, alias="from", description="起始 wall epoch 秒"),
        to: Optional[float] = Query(None, description="結束 wall epoch 秒"),
        limit: int = Query(5000, ge=1, le=50000),
    ):
        if device not in world.devices:
            raise HTTPException(404, f"無此設備:{device}")
        rows = await historian.query(device, tag, from_, to, limit)
        return {
            "device": device,
            "tag": tag,
            "count": len(rows),
            "degraded": historian.degraded,  # True 表示來自 in-memory fallback
            "points": rows,
        }

    # ── 教師面(P0 暫不強制 token;P2 起加 auth)─────────────
    @app.get("/api/devices/{device_id}/health")
    def get_health(device_id: str):
        device = world.devices.get(device_id)
        if device is None:
            raise HTTPException(404, f"無此設備:{device_id}")
        return device.ground_truth()

    @app.get("/api/sim/clock")
    def get_clock():
        return world.clock.snapshot()

    @app.post("/api/sim/clock")
    def set_clock(patch: ClockPatch):
        if patch.multiplier is not None:
            world.clock.set_multiplier(patch.multiplier)
        if patch.paused is not None:
            world.clock.set_paused(patch.paused)
        return world.clock.snapshot()

    return app
