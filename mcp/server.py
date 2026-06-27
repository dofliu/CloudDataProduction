"""MCP server(docs/06)。跑在老師本機 Claude Desktop,透過 LAN/Tailscale 打世界 REST API。

只是 REST 的薄轉接,不與引擎同機。課堂魔法:老師在 Claude Desktop 講一句
「給 cnc-01 注入軸承漸進故障」,世界就動起來。

啟動:
    set WORLD_API_URL=http://127.0.0.1:8077   (5090 的 LAN/Tailscale 位址)
    set TEACHER_TOKEN=dev-teacher-token
    python mcp/server.py

注意:本檔所在資料夾名為 mcp,請用 `python mcp/server.py` 啟動(勿用 -m,避免遮蔽 mcp SDK)。
"""
from __future__ import annotations

import os

import httpx
from fastmcp import FastMCP

WORLD_API_URL = os.getenv("WORLD_API_URL", "http://127.0.0.1:8077").rstrip("/")
TEACHER_TOKEN = os.getenv("TEACHER_TOKEN", "")

mcp = FastMCP("clouddata-world")


def _headers() -> dict:
    return {"Authorization": f"Bearer {TEACHER_TOKEN}"} if TEACHER_TOKEN else {}


def _post(path: str, body: dict, auth: bool = True) -> dict:
    r = httpx.post(WORLD_API_URL + path, json=body, headers=_headers() if auth else {}, timeout=10)
    r.raise_for_status()
    return r.json()


def _get(path: str, auth: bool = False) -> dict:
    r = httpx.get(WORLD_API_URL + path, headers=_headers() if auth else {}, timeout=10)
    r.raise_for_status()
    return r.json()


@mcp.tool()
def create_factory(description: str) -> dict:
    """自然語言建廠。把描述送到 /api/factory,後端依 template 庫產生公司/設備、自動配定址、熱載入。
    例:'建一間有 3 台 CNC 的公司' / '蓋一間有 5 台空壓機的廠'。回傳建立的公司與設備清單。"""
    return _post("/api/factory", {"description": description})


@mcp.tool()
def add_device(company_name: str, template: str, count: int = 1) -> dict:
    """新增 count 台某 template 設備(目前以新建一間小公司的形式加入)。
    template: cnc_machining_center / air_compressor / agv_mobile_robot。"""
    desc = f"建一間叫 {company_name} 的公司,有 {count} 台 {template}"
    return _post("/api/factory", {"description": desc})


@mcp.tool()
def list_devices() -> dict:
    """列出全部設備與協定/定址(走公開設備目錄 /api/catalog)。"""
    cat = _get("/api/catalog")
    return {"devices": [{"id": d["id"], "template": d["template"], "company": d["company_id"]}
                        for d in cat.get("devices", [])]}


@mcp.tool()
def inject_fault(device_id: str, target: str, fault_type: str = "gradual",
                 severity: float = 1.0, onset_sim_s: float | None = None) -> dict:
    """對設備注入故障。target=退化元件名(設備故障)或 tag 名(感測器故障)。
    fault_type: sudden/gradual/intermittent/cascading/sensor_drift/sensor_stuck/
    sensor_bias/sensor_noise/sensor_dropout。"""
    return _post("/api/faults", {"device": device_id, "target": target,
                                 "fault_type": fault_type, "severity": severity,
                                 "onset_sim_s": onset_sim_s})


@mcp.tool()
def reset_device(device_id: str) -> dict:
    """reset/維修設備,從故障拉回。"""
    return _post(f"/api/devices/{device_id}/reset", {})


@mcp.tool()
def set_sim_clock(multiplier: float | None = None, paused: bool | None = None) -> dict:
    """調時間倍率(1/60/600/3600)或暫停 / 續跑。"""
    body = {}
    if multiplier is not None:
        body["multiplier"] = multiplier
    if paused is not None:
        body["paused"] = paused
    return _post("/api/sim/clock", body)


@mcp.tool()
def get_health(device_id: str) -> dict:
    """讀 ground-truth:每元件 health / RUL / 故障與感測器故障狀態(教師面,需 token)。"""
    return _get(f"/api/devices/{device_id}/health", auth=True)


@mcp.tool()
def get_scores() -> dict:
    """讀自動評分排名榜(偵測延遲 / MTTR / 漏報)。"""
    return _get("/api/scores")


if __name__ == "__main__":
    mcp.run()
