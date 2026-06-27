# 雲端生產數據導論 — 虛擬智慧工業區教學平台

> 一套常駐在校內 5090 主機上的虛擬工業區。學生認領園區裡的公司,
> 透過工業通訊協定(Modbus / OPC-UA / MQTT)連線、監控、處置故障(第一階段),
> 再把歷史數據帶回去訓練模型、以閉環即時推論做預測性維護(第二階段)。

---

## 這個專案是什麼

一個 **2D 等距(isometric)的虛擬工業園區**,裡面有多家不同產業的公司
(機械加工、半導體機台、CNC、AGV 物流、產線設備、廠務動力)。每家公司有若干設備,
每台設備持續產生**接近真實的運轉數據**,並可隨時被注入故障。

學生不是看 demo,而是**實際操作真實的工作流程**:
查設備規格 → 自己寫客戶端連線抓資料 → 建監控儀表板 → 偵測故障 → 開工單處置 →
撈歷史數據訓練模型 → 把模型接回園區做即時預測 → 在設備真正壞掉之前提前告警。

老師端有上帝視角控制台:左手注入故障,右手看學生儀表板冒紅燈。

## 核心設計原則(整個專案的定海神針)

**模擬引擎是「心」,2D 世界是「皮」,兩者徹底解耦。**

- **心(simulation engine)**:唯一持有狀態的地方。負責產生誠實、有 ground-truth 標籤、
  可時間加速的設備數據。它不知道協定、不知道畫面。
- **皮 / 各種視圖**:協定轉接層、2D 世界、儀表板、任務板、設備目錄 ——
  全部都只是「讀同一份引擎狀態的不同視圖」,自己不存任何狀態。

守住這條線,才能在一學期內把東西做出來;破壞它,複雜度會失控。

## 文件導覽

| 檔案 | 內容 |
|------|------|
| `CLAUDE.md` | **Claude Code 進場第一份讀的檔**:技術棧、repo 結構、開發慣例、建置順序 |
| `docs/01-architecture.md` | 分層架構、資料流、部署拓樸(5090 + Cloudflare Tunnel + Tailscale) |
| `docs/02-simulation-engine.md` | **心臟**:隱藏健康狀態、退化數學模型、故障分類學、訊號模型、時間加速 |
| `docs/03-industry-templates.md` | 產業設備型別庫與 tag 清單(CNC / AGV / 半導體 / 機械手臂 / 廠務) |
| `docs/04-scenario-and-api.md` | 場景 YAML schema、REST + WebSocket API、協定轉接綁定 |
| `docs/05-world-and-teaching.md` | 2D 等距世界前端、公司認領、工單、兩階段教學、自動評分、閉環推論 |
| `docs/06-mcp.md` | MCP server 工具定義(自然語言建廠 / 注入故障) |
| `docs/07-roadmap.md` | P0–P4 建置順序與具體任務拆解 |

## 一句話的建議起手式

先做 **P0 的垂直切片**:模擬引擎(含退化)+ Modbus 轉接 + 一台會退化到故障的 CNC +
一份設備目錄。先證明「能產出可訓練的數據」,其餘都是往上長。

---

## P0 快速啟動

P0 已完成:單台 CNC 從健康自然退化到軸承故障,Modbus 讀得到、目錄查得到、Historian 有歷史曲線。

```bash
python -m venv .venv
.venv\Scripts\activate            # Windows;Linux/mac 用 source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env              # Windows:copy .env.example .env
# Windows 綁 502 需系統管理員;開發建議在 .env 設 MODBUS_PORT=5020
python main.py                   # 起 引擎 + Modbus + Historian + FastAPI(同進程)
```

連線驗證(另開一個終端機):

```bash
# 設備目錄(學生規格書):每個 tag 的 register / 型別 / 連線資訊
curl http://127.0.0.1:8000/api/catalog

# 用 pymodbus 客戶端連線監看,應看見 vibration_rms 上升、最後 state 跳 fault
python student_kit/p0_modbus_reader.py --port 5020 --api http://127.0.0.1:8000/api/catalog

# 退化歷史曲線(Historian)
curl "http://127.0.0.1:8000/api/history?device=cnc-01&tag=vibration_rms"
```

主要端點:`/api/park`、`/api/catalog`、`/api/devices/{id}`、`/api/history`、
`/api/devices/{id}/health`(ground-truth)、`GET/POST /api/sim/clock`(調倍率 / 暫停)。

> Historian 連不上 TimescaleDB 時會自動降級為 in-memory(`degraded: true`),引擎照常運行。
> 要用真正的 TimescaleDB:先 `docker compose up -d timescaledb`,並 `pip install asyncpg`。

### P0 驗收狀態

| 驗收項 | 狀態 | 備註 |
|--------|------|------|
| CNC 自然退化到軸承故障 | ✅ 已驗 | 3600× 下約 87 秒 wall;vibration 1.5→13.4 mm/s,state→fault |
| Modbus 讀得到上升中的 vibration_rms | ✅ 已驗 | pymodbus 3.6.9,float32 雙暫存器解碼 |
| 訊號相關(電流 / 溫度同步) | ✅ 已驗 | 電流 8.6→11.8 A、溫度→80°C 隨軸承退化 |
| 設備目錄查得到 | ✅ 已驗 | `/api/catalog` 含完整 register 對照 |
| Historian 有完整退化曲線 | ✅ 已驗(in-memory) | TimescaleDB 實寫路徑待 Docker 環境驗證 |

所有數據皆為 **合成(synthetic)**,帶 ground-truth 標籤,絕非真實場域量測(見 docs/02 §4)。

---

作者:勤益科大 劉瑞弘 · DofLab
