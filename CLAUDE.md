# CLAUDE.md

這是 Claude Code 在本 repo 工作時的進場說明。先讀本檔,再依任務讀 `docs/` 對應章節。

## 專案一句話

虛擬 2D 工業園區教學平台:模擬引擎產生擬真設備數據,經 Modbus / OPC-UA / MQTT 暴露;
學生連線監控、處置故障(階段一),再以閉環即時推論做預測性維護(階段二)。
常駐於校內 5090 主機,無公開 IP。

## 鐵則(違反會讓專案失控)

1. **狀態只存在於模擬引擎**。協定轉接層、世界前端、儀表板、API 都是「讀視圖」,不得自存設備狀態。
2. **數據必須誠實且可訓練**。觀測訊號是「隱藏健康狀態」的函數且彼此相關(見 `docs/02`),
   不是 sine 波貼雜訊。所有合成數據都帶 ground-truth 標籤,並**明確標示為合成數據**,
   絕不對外宣稱是真實場域量測。
3. **先做會動的垂直切片,再做廣度**。依 `docs/07` 的 P0→P4,不要先蓋 3D 城市(本專案不做 3D)。
4. **時間可加速**。所有退化、計時都對 `sim_clock` 積分,不對 wall clock。

## 技術棧(已定,除非有強理由不要換)

| 層 | 選型 | 備註 |
|----|------|------|
| 語言 | Python 3.11 | 後端與引擎 |
| 引擎/服務框架 | asyncio + FastAPI | REST + WebSocket 同一進程 |
| 數值 | numpy | 退化與訊號模型 |
| Modbus | `pymodbus==3.6.9` | 版本鎖定,勿升級 |
| OPC-UA | `asyncua` | server 與 client |
| MQTT broker | `mosquitto`(容器)或 `amqtt`(純 Python 備援) | |
| MQTT client | `aiomqtt` | |
| Historian | TimescaleDB(PostgreSQL 16 + timescaledb) | SQL 對學生分析友善 |
| 前端 | React + Vite + TypeScript | |
| 2D 等距渲染 | PixiJS | 大量 sprite + 動畫效能好 |
| 美術素材 | Kenney.nl(CC0) | 低多邊形、可商用、無版權疑慮 |
| MCP | FastMCP(Python) | 沿用 wind-turbine MCP 經驗 |
| 容器 | Docker Compose | 一鍵起全套 |
| 對外(HTTP) | Cloudflare Tunnel | 無需公開 IP |
| 對外(原生協定) | Tailscale | 裸 TCP 走 mesh |

## Repo 結構(建立時依此鋪)

```
cloud-production-data/
├── README.md
├── CLAUDE.md
├── docs/                      # 本規劃文件
├── docker-compose.yml
├── .env.example
├── engine/                    # ★ 心臟:純模擬,無協定無畫面
│   ├── clock.py               # 全域 sim_clock 與時間加速
│   ├── health.py              # 隱藏健康狀態 + 退化過程
│   ├── signals.py             # 訊號模型(health→觀測,含熱滯後/雜訊)
│   ├── sensor_faults.py       # 感測器故障層(stuck/drift/bias/dropout)
│   ├── device.py              # Device = tags + drivers + health components
│   ├── templates/             # 產業型別庫(見 docs/03)
│   └── world.py               # 載入場景、推進所有設備、廣播狀態
├── adapters/                  # 協定轉接層(讀 engine 狀態)
│   ├── modbus_server.py
│   ├── opcua_server.py
│   └── mqtt_publisher.py
├── api/                       # FastAPI:REST 控制面 + WebSocket 即時面
│   ├── rest.py
│   ├── ws.py
│   ├── catalog.py             # 公開設備目錄(學生規格書)
│   ├── tickets.py
│   ├── scoring.py             # 用 ground-truth 自動評分
│   └── predictions.py         # 階段二:接收學生模型預測
├── ai/                        # 自然語言建廠(LLM)
│   └── factory_generator.py
├── historian/                 # 寫入 TimescaleDB
│   └── writer.py
├── mcp/                       # MCP server(打 REST API)
│   └── server.py
├── scenarios/                 # 場景 YAML(見 docs/04)
│   └── default_park.yaml
├── web/                       # React + PixiJS 前端
│   ├── world/                 # 2D 等距園區(俯瞰→公司→設備→tag)
│   ├── teacher/               # 上帝視角控制台 + 參考客戶端儀表板
│   └── catalog/               # 公開設備目錄頁
└── student_kit/               # 給學生的範例:連線骨架、目錄查詢、預測上傳範例
```

## 開發慣例

- prose / 註解用繁體中文,識別碼 / API / schema 用英文。
- 每個設備 tag 都要有:`name`、`unit`、`datatype`、`modbus_register`、`opcua_node`、`mqtt_field`。
- 故障注入、健康狀態 ground-truth 屬「老師面」,API 需 auth;設備目錄與遙測屬「學生面」,公開唯讀。
- 預設協定模式為 **channel-mux**(共用 3 個埠,unit_id / folder / topic 分設備),多埠模式為進階選項。

## 怎麼跑(目標狀態)

```bash
cp .env.example .env            # 填 LLM key、DB 密碼、teacher token
docker compose up -d            # 起 engine+api / mosquitto / timescaledb / web
# 校內:學生直接連 LAN IP + port
# 校外 HTTP:cloudflared tunnel(世界 / 儀表板 / 目錄)
# 校外原生協定:tailscale(Modbus/OPC-UA/MQTT)
python mcp/server.py            # 老師本機 Claude Desktop 掛這支
```

## 開始建議

從 `docs/07-roadmap.md` 的 **P0** 開始。P0 完成的定義:一台 CNC 從健康跑到軸承故障、
Modbus 抓得到、設備目錄查得到、Historian 有歷史可撈。先讓這條線會動。
