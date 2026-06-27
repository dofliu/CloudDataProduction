# 06 · MCP 工具定義

MCP server(`mcp/server.py`,FastMCP)跑在**老師本機 Claude Desktop**,
透過 LAN / Tailscale 打 5090 上世界伺服器的 REST API。它只是 REST 的薄轉接,
**不需與引擎同機**。所以「模擬器在 5090、MCP 在本機」完全可行。

> 課堂魔法:老師在 Claude Desktop 講一句
> 「在西區建一間有 5 套機械手臂的公司,給 cnc-01 注入軸承漸進故障」,世界就動起來。

AI 建廠不只 MCP 一個入口:同一個 `/api/factory` 端點,web 教師控制台也放一個
「文字描述建廠」輸入框 —— **有沒有 MCP 都能用 AI 生成**,MCP 是高級體驗,表單是備援。

## 工具清單

```python
# mcp/server.py(概念)

@mcp.tool()
def create_factory(description: str) -> dict:
    """自然語言建廠。把描述送到 /api/factory,後端 LLM 依 template 庫產生 YAML、
    驗證、自動配 unit_id/topic、熱載入。回傳建立的公司與設備清單。
    例:'建一間半導體廠,3 台製程腔體,2 台機械手臂'"""

@mcp.tool()
def add_device(company_id: str, template: str, count: int = 1) -> dict:
    """在既有公司加 count 台某 template 設備,自動配定址。"""

@mcp.tool()
def list_devices(company_id: str | None = None) -> list:
    """列出設備與當前狀態(走公開 catalog)。"""

@mcp.tool()
def inject_fault(device_id: str, component: str,
                 fault_type: str = "gradual", severity: float = 1.0,
                 onset_sim_s: float | None = None) -> dict:
    """對設備注入故障。fault_type: sudden/gradual/intermittent/cascading/
    sensor_stuck/sensor_drift/sensor_bias/sensor_noise/sensor_dropout。"""

@mcp.tool()
def set_sim_clock(multiplier: float | None = None, paused: bool | None = None) -> dict:
    """調時間倍率(1/60/3600)或暫停 / 續跑。"""

@mcp.tool()
def get_health(device_id: str) -> dict:
    """讀 ground-truth health / RUL / fault 狀態(教師面,需 token)。"""

@mcp.tool()
def run_scenario(name: str) -> dict:
    """載入預寫情境腳本(如 disaster_day)。"""
```

## 認證

MCP server 啟動時從環境變數讀 `WORLD_API_URL` 與 `TEACHER_TOKEN`,
所有教師面呼叫帶 token。`.env`:

```
WORLD_API_URL=http://100.x.x.x:8000      # 5090 的 Tailscale 位址(或 LAN IP)
TEACHER_TOKEN=...
```

## 與既有資產的接點

- 沿用 wind-turbine MCP 的 stdio / FastMCP 模式與 `claude_desktop_config.json` 設定方式。
- 5090 上可另起本機 LLM + 故障診斷 RAG(接 TAG-Wind 知識庫),讓建廠與診斷不依賴外部 API。
