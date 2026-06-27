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
**不需要 Docker** —— Historian 沒連到 DB 會自動降級為 in-memory。

### 第一次:建虛擬環境

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
copy .env.example .env            # 預設埠:API 8077、Modbus 5020(避開 Windows 502 權限與被占用的 8000)
```

### 啟動

```powershell
.\run.ps1                         # 或雙擊 run.bat;會自動用 venv 的 python 跑 main.py
```

> ⚠ 常見錯誤:不要在 `.venv\Scripts\` 目錄裡、也不要用全域 `python` 執行 ——
> `main.py` 在**專案根目錄**,且相依套件只裝在 `.venv` 裡。用上面的 `run.ps1` / `run.bat` 最保險。

啟動後打開瀏覽器:

- API 互動文件(Swagger):**http://127.0.0.1:8077/docs**
- 設備目錄(學生規格書):http://127.0.0.1:8077/api/catalog
- 即時值:http://127.0.0.1:8077/api/devices/cnc-01

連線驗證(另開一個終端機,在專案根目錄):

```powershell
# 用 pymodbus 客戶端連線監看,應看見 vibration_rms 上升、最後 state 跳 fault
.\.venv\Scripts\python.exe student_kit\p0_modbus_reader.py --port 5020 --api http://127.0.0.1:8077/api/catalog

# 退化歷史曲線(Historian)
curl "http://127.0.0.1:8077/api/history?device=cnc-01&tag=vibration_rms"
```

主要端點:`/api/park`、`/api/catalog`、`/api/devices/{id}`、`/api/history`、
`/api/devices/{id}/health`(ground-truth)、`GET/POST /api/sim/clock`(調倍率 / 暫停)。

> 預設 `time_multiplier=3600`,約 90 秒就跑到故障。想慢慢看,POST 調倍率:
> `curl -X POST http://127.0.0.1:8077/api/sim/clock -H "Content-Type: application/json" -d "{\"multiplier\":600}"`,
> 或直接改 `scenarios/p0_single_cnc.yaml` 的 `time_multiplier`(故障後重跑即重置)。
> 要改用真正的 TimescaleDB:`.env` 設 `HISTORIAN_ENABLED=true`、`pip install asyncpg`、`docker compose up -d timescaledb`。

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

## P1 啟動(多設備園區 + 三協定 + 2D 世界)

P1 已完成:多家公司多台設備、同一設備可被 **Modbus / OPC-UA / MQTT** 三協定同讀、
WebSocket 即時推送、PixiJS 2D 等距園區與公開設備目錄頁。**全程不需 Docker**
(MQTT 走內嵌純 Python broker `amqtt`)。

### 後端

`.env` 預設場景已指向多設備園區 `scenarios/default_park.yaml`(3 公司 / 6 設備)。

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements.txt   # 補裝 asyncua、amqtt
.\run.ps1                                                        # 起 引擎 + 4 協定面 + API
```

協定埠(預設,可在 `.env` 改):Modbus `5020` · OPC-UA `4841` · MQTT `1883` · API `8077`。
> 本機 4840 常被 OPC-UA Local Discovery Server 占用,故 OPC-UA 用 4841。

### 前端(2D 世界 + 目錄頁)

```powershell
cd web
npm install        # 第一次
npm run dev        # 開 http://localhost:5173
```

瀏覽器開 **http://localhost:5173**:等距園區俯瞰、公司燈號(綠/黃/紅/灰)、AGV 沿座標移動、
點設備看即時值、事件面板顯示故障與狀態轉換、頂列可調模擬倍率;切「設備目錄」頁看三協定規格書。
（Vite 開發伺服器已把 `/api`、`/ws` 代理到後端 8077。）

### P1 驗收狀態

| 驗收項 | 狀態 | 備註 |
|--------|------|------|
| 多家公司多產業設備 | ✅ 已驗 | CNC×2 + 空壓機×2 + AGV×2,故障時間錯開 |
| 同一設備三協定同讀 | ✅ 已驗 | cnc-01 vibration:Modbus 1.642 / OPC-UA 1.642 / MQTT 1.804（差 0.16） |
| WebSocket 即時 telemetry / events | ✅ 已驗 | 6 設備串流;故障/換班/充電事件正確帶元件 |
| 瀏覽器看園區並鑽到設備即時值 | ✅ 已驗 | PixiJS 2D 世界 + 設備目錄頁,狀態燈號即時 |

---

## P2 階段一教學完整可用

P2 已完成:**故障注入 + 感測器故障 + 工單 + 自動評分 + 教師控制台 + 自然語言建廠 + MCP**。
完整教學閉環:老師注入故障 → 學生偵測開工單 → 處置 resolve → 系統自動計分。

- **故障注入**:設備故障(sudden/gradual/intermittent/cascading)與感測器故障
  (drift/stuck/bias/noise/dropout)。感測器故障只汙染讀值、不動隱藏 health,
  讓學生學會分辨「設備壞了 vs 感測器壞了」。
- **工單 / MTTR**:故障自動開單,學生 ack→resolve(順手修復設備),量偵測延遲與 MTTR。
- **自動評分**:用 ground-truth 算偵測延遲 / MTTR / 漏報,出公開排名榜。
- **教師控制台**(web「教師控制台」分頁):token、調速、注入故障表單、ground-truth
  health/RUL、工單板、評分榜。
- **自然語言建廠**:`POST /api/factory {description}`,例「建一間有 3 台 CNC 的公司」即時長出
  新公司(規則式解析,免 LLM key);web 表單與 MCP 皆可觸發。
- **MCP server**(`mcp/server.py`,老師本機 Claude Desktop):薄 REST 轉接,
  含 create_factory / inject_fault / set_sim_clock / get_health / get_scores 等工具。

### 教師面 auth

教師端點需帶 `Authorization: Bearer <TEACHER_TOKEN>`(`.env` 設,預設 `dev-teacher-token`)。
教師控制台填一次 token 即存於瀏覽器。學生面(目錄 / 遙測 / 工單 / 評分)維持公開唯讀。

### MCP 啟動(老師本機)

```powershell
$env:WORLD_API_URL="http://127.0.0.1:8077"   # 5090 的 LAN / Tailscale 位址
$env:TEACHER_TOKEN="dev-teacher-token"
python mcp/server.py                          # 掛進 Claude Desktop;勿用 -m(避免遮蔽 mcp SDK)
```

### P2 驗收狀態

| 驗收項 | 狀態 | 備註 |
|--------|------|------|
| 設備故障 vs 感測器故障 | ✅ 已驗 | gradual 把故障從 >150h 提早到 20h;sensor_drift 讓溫度 59→145℃ 但 health 乾淨 |
| 教師 auth | ✅ 已驗 | 無 token 注入故障 → 401 |
| 注入→自動開單→ack/resolve→評分 | ✅ 已驗 | 偵測延遲 / MTTR 計算正確,resolve 後設備 reset 回 idle |
| 教師控制台(瀏覽器操作) | ✅ 已驗 | 注入 gradual → RUL 129h 驟降 7.5h、health 條下降、工單/評分即時 |
| 自然語言建廠 | ✅ 已驗 | 「2 台 CNC 的公司」→ 即時長出新公司、新設備已運轉、可注入故障 |
| MCP server | ✅ 匯入驗證 | 8 工具就位(完整流程需 Claude Desktop) |

---

## P3 階段二閉環即時推論

P3 已完成:學生模型訂閱遙測 → 在故障**之前** POST 預測 → 系統用 ground-truth 算
**lead time(提前量)**、設備在 2D 世界翻**橘**、上預測榜。

- **預測端點**:`POST /api/predictions {device, student, predicted_fault, eta_sim_s, confidence}`
  (公開,學生面)。`GET /api/predictions`、`GET /api/predictions/scores`。
- **比對**:[predictions.py](api/predictions.py) 訂閱故障事件,設備故障時把先前的 pending 預測標記
  hit,`lead_time = fault_onset − prediction_time`;發 `prediction` / `prediction_hit` 事件。
- **預測榜**:命中數、平均 lead time、誤報、命中率、分數(命中按提前量加分、誤報扣分);
  教師控制台底部「階段二預測榜」即時顯示。
- **2D 世界**:預測中設備翻**橘**(真故障紅優先)、公司燈號同步;**AGV 改補間平滑移動**
  (解決高倍率下綠點瞬移)。

學生範例:[student_kit/p3_predictor.py](student_kit/p3_predictor.py) —— 訂閱 `/ws/telemetry`、
振動越界就 POST 預測的最小服務骨架(學生把啟發式換成自己用 Historian 訓練的模型)。

```powershell
.\.venv\Scripts\python.exe student_kit\p3_predictor.py --student S001 --threshold 5.0
```

> ⚠ **Windows / PowerShell 注意**:PowerShell 會把 `curl` 的 JSON body 搞壞(送出空物件 → 422)。
> 要發 POST(預測 / 注入故障)請用 student_kit 的 Python 腳本或網頁 UI,**不要用 PowerShell 的 curl**。

### P3 驗收狀態

| 驗收項 | 狀態 | 備註 |
|--------|------|------|
| 故障前預測 → 命中算 lead time | ✅ 已驗 | 預測 cnc-01 → 注入 gradual → 故障,命中 lead time **8.9 sim h** |
| 預測榜(lead time / 命中率 / 誤報) | ✅ 已驗 | S007 hits=1、hit_rate=1.0、score 64.6 |
| 2D 世界預測故障翻橘 | ✅ 已驗 | cnc-01/comp-01/comp-02 橘色脈動 + 公司燈號橘、事件列 🔮 預測故障 |
| 誤報判定與 eta 脫鉤 | ✅ 已修 | eta 估錯不再把真故障誤判成誤報;誤報只看「設備到底有沒有壞」 |

---

## 戰情版 · 協定連線自測(老師的參考客戶端)

對應 docs/05 的「參考客戶端儀表板」。和教師控制台(只打 REST)不同,**戰情版真的用
Modbus / OPC-UA / MQTT 各開一個 client 連回伺服器**,逐設備讀一個樣本值 ——
同時是「伺服器到底通不通」的自測,也是「以協定列出設備」的戰情板。

- 端點:`GET /api/diagnostics/protocols`([diagnostics.py](api/diagnostics.py),連 loopback)。
- web「戰情版」分頁:三協定可達數摘要 + 設備 × 協定連線矩陣(綠✓值含定址與延遲 / 紅✗錯誤)。

已實機驗證:Modbus / OPC-UA / MQTT 各 **6/6 可達**,跨協定讀回值一致、延遲 ~1ms;
熱載入(NL 建廠)的設備在 OPC-UA / Modbus 會顯示「需重啟」、MQTT 則即時可達(誠實反映限制)。

> 學生用第三方工具(Modbus Poll / UaExpert / MQTT Explorer)連線的圖文步驟見
> [docs/連線教學.md](docs/連線教學.md)。

---

## 情境腳本(災難日 · 期末測驗)

預寫的連鎖故障腳本,當期末實作測驗 —— 全班同條件、同時間軸。步驟依 **sim 時間** 排程
(加速 / 暫停都正確),動作沿用既有注入機制。

- 腳本:[scenarios/scripts/disaster_day.yaml](scenarios/scripts/disaster_day.yaml)
  (多設備連鎖故障 + 一個感測器漂移陷阱,考根因判斷)。
- 端點:`GET /api/scenarios`(列出)、`POST /api/scenarios/{name}/run`(教師,執行)、
  `POST /api/scenarios/stop`([scenarios.py](api/scenarios.py))。
- 教師控制台「情境腳本」區:下拉選腳本 → 執行 / 停止 → 即時看每步觸發紀錄。

已實機驗證:`disaster_day` 6 步按 sim 時間依序觸發(調時鐘 → cnc-01/comp-01 漸進 →
comp-02 感測器漂移 → agv-01 突發 → cnc-02 連鎖),突發故障即時自動開單,情境正常結束。

---

## 2.5D 工業區世界 + 動畫

2D 等距世界改造成像樣的工業園區:**等距地磚 + 街道網格 + 滿園區高低大小不一的建築**
(確定性佈局),公司建築含煙囪、招牌、屋頂彙整燈號。

- **動畫**:煙囪冒煙粒子、**故障紅閃**、**預測故障橘脈動**、運轉綠呼吸、AGV 沿座標補間平滑移動。
- **第 4 種產業 template**:`robot_arm_6axis`(機械手臂,公司「鴻運自動化」),六軸角度/電流/溫度、
  tcp 末端位置、`reducer_wear` 退化主指標;pre_step 讓六軸做 pick-and-place 擺動。
- 目前 4 產業:CNC 加工中心 / 空壓機 / AGV / 機械手臂;預設園區 4 公司 8 設備。

已實機驗證(瀏覽器截圖):園區街道 + 多棟建築 + 冒煙;注入故障 → cnc-01 紅閃、屋頂燈轉紅;
預測 → comp-01 橘脈動;機械手臂公司 arm-01/02 運轉中。

---

## multi_port:每台設備一個專屬埠(疊加在 channel_mux 之上)

讓每台設備像真實工業設備一樣有自己的 `IP:port`,學生得自己管理多條連線 / 資料管線。
**與 channel_mux 並存**(不是二選一):共用埠照舊,另外為每台設備各起一個專屬 Modbus 埠。

- 開關:`.env` 的 `MULTI_PORT_ENABLED=true` + `MULTI_PORT_MODBUS_BASE=5000`(預設關)。
- 每台設備從 base 起配埠(cnc-01=5000、cnc-02=5001…);[modbus_multiport.py](adapters/modbus_multiport.py)
  為每台起一個 single-unit Modbus server,讀同一份引擎 snapshot。
- 設備目錄 / 戰情版同時列出兩種連法;戰情版多一欄「Modbus(專屬埠)」。
- MQTT 不適用 multi_port(本質 topic 分流);OPC-UA per-device 較重,先以 Modbus 為主。

已實機驗證:8 台專屬埠 server(5000–5007)上線,直接連 comp-01 的 5002 不需 unit_id 即讀到值;
戰情版四協定(共用埠 / 專屬埠 / OPC-UA / MQTT)各 **8/8 可達**,兩種 Modbus 讀回同一隱藏狀態。

---

作者:勤益科大 劉瑞弘 · DofLab
