"""進程入口:同一個 asyncio 進程跑 引擎 + Modbus + Historian + FastAPI(docs/01)。

    cp .env.example .env      # 視需要調整
    python main.py            # 起世界;學生連 LAN IP + 埠

P0 預設場景 scenarios/p0_single_cnc.yaml:單台 CNC 從健康退化到軸承故障。
"""
from __future__ import annotations

import os

import uvicorn
from dotenv import load_dotenv

from adapters.modbus_server import ModbusAdapter
from api.rest import create_app
from engine.world import World
from historian.writer import Historian


def build():
    load_dotenv()

    scenario = os.getenv("SCENARIO_FILE", "scenarios/p0_single_cnc.yaml")
    world = World.from_yaml(scenario)

    # Modbus 埠可由 .env 覆寫(Windows 綁 502 需管理員;開發用 5020 之類)。
    # 覆寫後同步回 world.ports,讓設備目錄公布的埠與實際一致。
    modbus_port = int(os.getenv("MODBUS_PORT", world.ports.get("modbus", 502)))
    world.ports["modbus"] = modbus_port
    modbus = ModbusAdapter(
        world,
        host=os.getenv("MODBUS_HOST", "0.0.0.0"),
        port=modbus_port,
    )

    historian = Historian(
        dsn=os.getenv("TIMESCALE_DSN", "postgresql://postgres:postgres@localhost:5432/clouddata"),
        enabled=os.getenv("HISTORIAN_ENABLED", "true").lower() == "true",
    )

    config = {
        "public_host": os.getenv("PUBLIC_HOST", "127.0.0.1"),
        "teacher_token": os.getenv("TEACHER_TOKEN", ""),
    }
    app = create_app(world, historian, modbus, config)
    return app


app = build()


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=os.getenv("API_HOST", "0.0.0.0"),
        port=int(os.getenv("API_PORT", "8000")),
        log_level="info",
    )
