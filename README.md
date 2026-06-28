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
| `docs/07-roadmap.md` | P0–P4 建置順序與具體任務拆解(原始規劃) |
| **`README.en.md`** | English project overview |
| **`docs/ROADMAP.md`** | 現況路線圖 · 待辦 · 已知限制(中英)Roadmap / TODO / known issues |
| **`docs/STRESS_TEST.md`** | 壓力測試方法與實測結果(中英)Stress test method & results |
| `docs/連線教學.md` | 學生用第三方工具連三協定 + 四種 object type / 線圈的圖文步驟 Connection guide |
| `docs/部署運維.md` | 常駐 5090 主機:venv 安裝、看門狗 / 開機自動、健康檢查、DB 持久化 Ops guide |
| `docs/學生講義_工業通訊資料點位.docx` | 學生講義:Modbus 四 object type × 資料型別 × 位元組順序 × 縮放 × 線圈 |

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
copy .env.example .env            # 工業協定埠統一 6xxx 區(Modbus 6020、OPC-UA 6041、MQTT 6083);API 8077
```

### 啟動

```powershell
.\run-engine.ps1                  # 強制用 .venv 的 python 跑 main.py,並檢查 pymodbus==3.6.9
```

> ⚠ **一律用 `run-engine.ps1`(或 `.venv\Scripts\python.exe`),不要用裸 `python`** ——
> 全域 Python 的套件版本會漂移(pymodbus 被別的工具拉到 3.9.2 會讓 Modbus 啟動崩)。
> 常駐 5090 主機請見 [docs/部署運維.md](docs/部署運維.md)(看門狗 + 開機自動 + 健康檢查)。

啟動後打開瀏覽器:

- API 互動文件(Swagger):**http://127.0.0.1:8077/docs**
- 健康檢查:http://127.0.0.1:8077/api/health
- 設備目錄(學生規格書):http://127.0.0.1:8077/api/catalog

連線驗證(另開一個終端機,在專案根目錄):

```powershell
# 一次讀四種 object type(FC03 holding / FC02 discrete input / FC04 input register / FC01 coil)
.\.venv\Scripts\python.exe student_kit\p1_modbus_objecttypes.py --unit 2

# 全套不變式 smoke test(三協定可達 / 四 object type / float 解碼 / sim 前進),回傳 0=全過
.\.venv\Scripts\python.exe tools\smoke_test.py
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

協定埠(預設,可在 `.env` 改):Modbus `6020` · OPC-UA `6041` · MQTT `6083` · API `8077`。
> 工業協定埠統一在 6xxx 區(避開 Windows 保留/服務埠,如 5040 被 CDPSvc 占用)。

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
- **點公司鑽入廠內**:俯瞰點公司建築 → 切到該公司內部場景(地坪 + 輸送帶滾動 +
  各設備專屬動畫:機械手臂依 joint_angle 擺動、CNC 主軸旋轉、AGV 沿 pos_x/y 廠內移動、
  空壓機風扇轉),狀態環同步紅閃 / 橘脈動;「← 返回俯瞰」回上層。
- **第 4 種產業 template**:`robot_arm_6axis`(機械手臂,公司「鴻運自動化」),六軸角度/電流/溫度、
  tcp 末端位置、`reducer_wear` 退化主指標;pre_step 讓六軸做 pick-and-place 擺動。
- 目前 4 產業:CNC 加工中心 / 空壓機 / AGV / 機械手臂;預設園區 4 公司 8 設備。

已實機驗證(瀏覽器截圖):園區街道 + 多棟建築 + 冒煙;注入故障 → cnc-01 紅閃、屋頂燈轉紅;
預測 → comp-01 橘脈動;機械手臂公司 arm-01/02 運轉中。

---

## multi_port:每台設備一個專屬埠(疊加在 channel_mux 之上)

讓每台設備像真實工業設備一樣有自己的 `IP:port`,學生得自己管理多條連線 / 資料管線。
**與 channel_mux 並存**(不是二選一):共用埠照舊,另外為每台設備各起一個專屬 Modbus 埠。

- 開關:`.env` 的 `MULTI_PORT_ENABLED=true` + `MULTI_PORT_MODBUS_BASE=6100`。
- 每台設備從 base 起配埠(cnc-01=6100、cnc-02=6101…);[modbus_multiport.py](adapters/modbus_multiport.py)
  為每台起一個 single-unit Modbus server,讀同一份引擎 snapshot。
- 設備目錄 / 戰情版同時列出兩種連法;戰情版多一欄「Modbus(專屬埠)」。
- MQTT 不適用 multi_port(本質 topic 分流);OPC-UA per-device 較重,先以 Modbus 為主。

已實機驗證:45 台專屬埠 server(6100 起)上線,直接連設備專屬埠不需 unit_id 即讀到值;
戰情版四協定(共用埠 / 專屬埠 / OPC-UA / MQTT)各全數可達,兩種 Modbus 讀回同一隱藏狀態。

---

## OEE 設備總效率排名榜

**OEE = 可用率 × 表現 × 良率**,製造業標準 KPI。全部由引擎 ground-truth 累積算:

- **可用率**=運轉 /(運轉+故障停機)——**學生**越快偵測+結工單修復,停機越短、越高。
- **表現**=理想節拍 / 實際節拍(退化使節拍變慢)。**良率**=良品率(退化使不良升)。
- 引擎累積器在 [device.py](engine/device.py) 對 sim 時間積;各 template 提供 `oee_fn` 瞬時訊號。
- [api/oee.py](api/oee.py) + `GET /api/oee`(公開);web「OEE 榜」分頁:公司排名 + 三因子拆解條 + 每台明細。

把「設備退化損失」與「學生故障管理能力」綜合成一個 KPI,比單看 MTTR 更貼近真實工廠。

已實機驗證:對 cnc-01 注入故障不修 → 精鋐機械可用率掉到 74.6%、OEE 73.2%;
其他無停機公司 OEE 95–99%;三因子拆解與公司彙整正確。

---

## 階段二訓練資料集(資料集產生器)

階段二要訓練 PdM / RUL 模型需要**夠長、帶標籤的歷史**。即時 Historian(in-memory)不夠,
故提供 headless 資料集產生器([tools/generate_dataset.py](tools/generate_dataset.py)):快轉引擎,
各設備跑過**多次劣化→故障→維修**循環,輸出每台一份 wide CSV。

```powershell
.\.venv\Scripts\python.exe tools\generate_dataset.py --sim-days 120 --step-min 5 --out dataset
```

每筆含:`state` + 各觀測 tag(學生可見)、`gt_health_min` / `gt_rul_sim_s` / `is_sensor_fault`(ground-truth)、
`cycle_id`、**`ttf_sim_s`**(距實際故障的時間,迴歸標籤)、**`fail_within_24h`**(24h 內是否故障,分類標籤)。
含隨機感測器故障期(教設備故障 vs 感測器故障)。`dataset/` 不入庫;`manifest.json` 記錄欄位。

已驗證:60 sim-天 / 10 分解析度 → 每台 ~8.6k 筆、各 4–14 次 run-to-failure,8 秒跑完;
故障前 RUL/ttf 平滑遞減到 0、`fail_within_24h` 正樣本約 24%、循環乾淨收在故障點。

## 台中精密機械主題園區(22 公司 / 45 設備)

預設園區取材自**台中工業區 / 精密機械聚落代表廠商**(上銀、友嘉、東台、台中精機、永進、
大立光、成霖、復盛、盟立、慶鴻、瀧澤、程泰、亞崴…),加一座教學用「離岸風電示範場」。

> ⚠ 公司名稱與主要產品為公開資訊;設備、數據、運轉狀態**全為合成**,非任何公司真實產線。

- **6 產業 template**:CNC 加工中心 / 空壓機 / AGV / 機械手臂 / **射出成型機** / **風力機**
  (風機含風速—功率曲線、轉子轉速、齒輪箱退化等風能 SCADA 訊號)。
- **滑鼠移到公司**顯示簡介(名稱 + 主要產品 + 設備);**點公司進廠內**,左側顯示公司介紹卡。
- **廠內設備動畫**:機械手臂(底座+關節+夾爪,依 joint_angle 擺動)、AGV(慢速沿固定軌跡)、
  輸送帶(上有移動物件)、CNC 主軸旋轉、空壓機/風機葉片轉動。
- 設備只需寫 `id + template`,協定定址自動配、退化參數用 template 預設並做個體差異抖動。

## 四種 object type + 命令線圈(教學重點)

設備點位刻意分散在 Modbus 四種資料物件,讓學生學會「依規格決定怎麼讀」:

| Object type | FC | 內容 | 型別 |
|---|---|---|---|
| Holding Register `4xxxx` | 03 | 量測值(state 在第 1 格 int16,float 由第 2 格起) | float32 / int16 / int32 |
| Discrete Input `1xxxx` | 02 | 狀態旗標 running / fault / idle / warning / heartbeat | bool(唯讀) |
| Input Register `3xxxx` | 04 | 狀態碼 + 量測的 int32 定點 ×100 鏡像(教 raw vs 工程單位) | int16 / int32 |
| Coil `0xxxx` | 01讀 / 05寫 | 命令:`run_enable`(停機/復機)、`reset_fault`(清故障) | bool |

線圈權限:**學生 FC01 唯讀**看命令狀態;**寫(FC05)只有教師**(帶 token 的 REST 或隔離的教師控制埠 `MODBUS_CONTROL_PORT`)。寫 `run_enable=0` 設備會真的停機(風機順槳、AGV 停車,rpm/速度歸零,資料與命令一致)。三協定(Modbus / OPC-UA / MQTT)都暴露這些點位;設備目錄頁逐台列出 object/FC/位址/scale。

## 持久化 + 上線硬化

- **本機 DB(免 Docker)**:`DB_BACKEND=sqlite` → 高頻 telemetry 寫 `historian.db`、營運狀態(工單 / 學生預測 / OEE 累積器)寫 `state.db`,**進程重啟全部不歸零**。學生用 `pandas.read_sql` 直接撈訓練資料;production 改 `DB_BACKEND=timescale`。
- **venv 啟動**:`run-engine.ps1` 強制用 `.venv` python 並檢查 pymodbus 鎖定版。
- **行程監管**:`deploy/watchdog.ps1`(輪詢 `/api/health`、失敗清埠重啟)+ `deploy/install-startup-task.ps1`(開機自動)。
- **smoke test**:`tools/smoke_test.py` 對執行中世界做 11 項不變式檢查,回傳 0/1 供排程器 / CI。
- **平靜更新**:資料每 5 秒一拍 = 10 模擬分鐘(畫面不亂跳),動畫走前端 ticker 仍滑順。
- **2D 視覺**:寬路 + 多樣立面(窗格紋路、高低差)+ 廠內人員走動/作業 + 產線編排(機台出件→手臂夾取→輸送帶送出)。

## 進度

P0~P4 完成 + 上線硬化(~100% 功能面):**階段一+二可開課**、四 object type + 教師線圈控制、
SQLite 持久化(telemetry + 工單/預測/OEE)、6xxx 埠、venv 啟動 + 看門狗 + 健康檢查 + smoke test、
2.5D 工業區 + 產線編排 + 廠內人員、6 產業 template、multi_port、OEE 榜、資料集產生器、22 主題公司。
**剩:對外接入**(Cloudflare Tunnel + Tailscale)——待能存取校內 5090 主機再做。

---

作者:勤益科大 劉瑞弘 · DofLab
