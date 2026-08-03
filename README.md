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

設備不只是「讀」:學生可透過受控的**設定點**(Modbus FC06 / REST / 網頁)寫入控制 ——
改 CNC 主軸轉速、**輸入任意文字讓 CNC 刻字**、**指定機械手臂的取放兩點座標**;
有 `line:` 宣告的公司更有**引擎級產線物料流**(上游完工 → 手臂搬運 → 下游加工 → 輸送帶出貨,
工件真實傳遞、緩衝與出貨帳可由 Modbus 讀到,餓料 / 滿料的站會誠實停機)。

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
| **`docs/使用說明.md`** | **完整操作手冊(先讀這份)**:啟動、網頁分頁、教師操作、CNC 刻字 / 手臂取放、產線物料流與慢速觀察、建廠、常見問題 |
| `CLAUDE.md` | **Claude Code 進場第一份讀的檔**:技術棧、repo 結構、開發慣例、建置順序 |
| `docs/01-architecture.md` | 分層架構、資料流、部署拓樸(5090 + Cloudflare Tunnel + Tailscale) |
| `docs/02-simulation-engine.md` | **心臟**:隱藏健康狀態、退化數學模型、故障分類學、訊號模型、時間加速 |
| `docs/03-industry-templates.md` | 產業設備型別庫與 tag 清單(CNC / AGV / 半導體 / 機械手臂 / 廠務) |
| `docs/04-scenario-and-api.md` | 場景 YAML schema、REST + WebSocket API、協定轉接綁定 |
| `docs/05-world-and-teaching.md` | 2D 等距世界前端、公司認領、工單、兩階段教學、自動評分、閉環推論 |
| `docs/06-mcp.md` | MCP server 工具定義(自然語言建廠 / 注入故障) |
| `docs/07-roadmap.md` | P0–P4 建置順序與任務拆解(**原始規劃,已全數完成** —— 保留當初的順序與判斷理由) |
| **`docs/animation_binding.md`** | **動畫綁定契約**:每個會動的部位對應哪支 tag、三條鐵則、逐機種綁定表、產線佈局、自動驗收結果。**要改動畫先讀這份** |
| **`tests/animation/README.md`** | 動畫 ↔ 模擬資料一致性驗證:怎麼跑、為什麼用線性回歸、探針一覽、已知的物理限制 |
| **`README.en.md`** | English project overview |
| **`docs/ROADMAP.md`** | 現況路線圖 · 待辦 · **後續接續工作** · 已知限制(中英)Roadmap / TODO / follow-ups |
| **`docs/STRESS_TEST.md`** | 壓力測試方法與實測結果(中英)Stress test method & results |
| `docs/課程規劃_18週.md` | **18 週課程規劃**:每週主題 × demo × 回家作業 × 批改;分軌作業表(基礎 + 進階) |
| `docs/課堂即時練習.md` | **課堂即時練習 + 全班投票**(教師指南):佈題倒數 → 學生手機作答 → 即時批改 / 首答留名;投票收票後照多數決**真的去動引擎** |
| **`docs/決策與後果.md`** | **學生決策層**:工單結案要診斷後選對處置動作(選錯不會修好)、預防保養停機換壽命、託管告警規則對 ground-truth 算 F1 |
| **`docs/關卡與進度.md`** | **資料的一生九關**與全班 N×9 進度熱力圖、瓶頸關算法、協定端存取軌跡(含拿不到身分的限制說明) |
| **`docs/供應鏈連動.md`** | **跨公司供應鏈**:A 出貨 = B 進料;上游停→下游餓料、下游滿→上游阻塞;自給率量化單一供應商風險 |
| `docs/雲端生產_概念與議題.md` | **「雲端生產」概念**:課名斷句、雲製造 vs 數據上雲、ISA-95、Cloud MES;討論題 + 動手練習 |
| `docs/部署_對外連線.md` | 對外連線:Cloudflare Tunnel(HTTP)+ Tailscale(原生協定)說明與設定 |
| `student_kit/dashboard/README.md` | 學生自建監控台(Streamlit 版):三協定即時 + 趨勢 / 統計 / 分析 / 繳交 |
| `student_kit/dashboard_simple/README.md` | 同款監控台**純 Python 版**(免 Streamlit,標準庫 http.server + 原生 JS) |
| `docs/連線教學.md` | 學生用第三方工具連三協定 + 四種 object type / 線圈的圖文步驟 Connection guide |
| `docs/部署運維.md` | 常駐 5090 主機:venv 安裝、看門狗 / 開機自動、健康檢查、DB 持久化 Ops guide |
| `docs/學生講義_工業通訊資料點位.docx` | 學生講義:Modbus 四 object type × 資料型別 × 位元組順序 × 縮放 × 線圈 |
| `docs/ML基準實證.md` | **資料可訓練性實證**:用合成資料訓 RUL 迴歸 + 故障分類,held-out 機台 F1 0.95 / R² 0.94 |
| `docs/資料集與作業.md` | **資料一致性 / 出題**:確定性種子、每學號不同資料、指定故障作業集、凍結釋出與版本溯源 |
| `docs/作業範本_預測性維護.md` | **完整作業範本**:出題腳本 + 每學號私有測試集 + 自動評分 rubric + 線上活廠驗收(防 AI 代寫) |
| `docs/作業範本_製程漂移.md` | 半導體腔體 **subtle fault** 作業:製程漂移 → particle → 良率,`grade_chamber_assignment.py` 自動評分 |
| `docs/學生快速上手.docx` / `docs/作業_預測馬達故障.docx` | 發給學生的講義與作業(Word) |
| `docs/開發現況報告_2026秋.docx` | 開發現況報告(Word,對外簡報用) |

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

瀏覽器開 **http://localhost:5173**:預設落在「**🚀 開始**」分頁 —— 學生設 id、認領公司,系統依認領設備
**自動產生可執行的 Modbus Python 連線包**(填好 host/port/unit_id/register,一鍵複製直接跑),並用真實狀態
自動打勾任務進度(認領 / 開單 / 預測)。其餘分頁:「2D 世界」等距園區俯瞰、公司燈號、點設備看即時值;
「設備目錄」三協定規格書;「學生面」工單與競賽榜;「戰情版」三協定自測;「OEE 榜」。
全站為**方案 4D 教學暖色**(Lora / Noto Sans TC / JetBrains Mono 字體 + 燈號摘要 + 門檻條),2.5D 世界為**暖色等距量體**(漸層立方體建築 + 發光機台)。點機台 / 目錄卡可開**設備詳情彈窗**(放大詳細動畫 + 即時訊號 / 趨勢 / HOLDING / DISCRETE)。
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
熱載入(NL / LLM 建廠)的新設備**三協定即時上線,免重啟**(adapter 於下一拍動態掛 slave / node / 專屬埠)。

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

## 工業區世界 + 設備動畫

**俯瞰層(PixiJS 2D 等距)**:等距地磚 + 街道網格 + 滿園區高低大小不一的建築(確定性佈局),
公司建築含煙囪、招牌、屋頂彙整燈號。煙囪冒煙、故障紅閃、預測故障橘脈動、運轉綠呼吸。

**廠內層(three.js 3D)**:點公司鑽入廠內 → 依**製程角色排成一條看得懂的產線**,
而不是把設備等距排一列各做各的:

| 角色 | template | 在線上的位置 |
|------|----------|--------------|
| 產出 `source` | CNC / 沖壓 / 射出 / 製程腔體 / 熱處理爐 | 主線左段 |
| 搬運 `handler` | 六軸手臂 / AGV | 主線中段 |
| 輸送 `transport` | 輸送帶 | 主線右段 |
| 廠務 `utility` | 空壓機 / 電表 / 風機 | **不佔主線**,排在後方 |

手臂的**取件點對到上游機台的出料口、放件點壓在輸送帶起點**;地面畫料道與方向箭頭;
畫面與說明卡都寫出「製程流向:射出成型 → 手臂取放 → 輸送帶出料」(由實際設備推出來,
不是寫死在場景檔)。CNC 在產線視圖套鈑金外殼,讀起來像一台機器;**點進去**才看裸露的
刀路動畫 —— 兩個不同的觀看層級。

> ⚠ 這是**空間上的對位**,不是引擎層的物料交接。各設備的節拍仍各自獨立(引擎沒有跨設備的
> 工件傳遞),不會出現「射出機一頂出、手臂就伸手」那種同步。

**設備動畫的規矩**寫在 [docs/animation_binding.md](docs/animation_binding.md)(動畫綁定契約):
每個會動的部位都必須對應一支具體的 tag / setpoint / coil;前端不重算引擎已算過的物理;
做了時間換算就必須在畫面標出倍率。11 種 template 全部依此重寫,並有
[自動驗證](tests/animation/README.md)把關(見下節)。

---

## 動畫 ↔ 模擬資料 一致性驗證

回答一個問題:**畫面上機台 / 工件的位置、動作、座標,是不是真的對應到引擎產生的生產資料?**
不靠肉眼,也不靠 mock:

```
engine.World.step()  真實模擬 → 錄下 telemetry
        ↓ 逐幀餵進瀏覽器裡真正的 3D 元件
讀回 three.js 場景中機構的實際世界座標
        ↓ 線性回歸 + 還原誤差
與引擎發出的 tag 比對:斜率要等於契約值,R² 要 ≈ 1
```

線性回歸(而非單點比對)一次抓四種錯:接錯 tag(R² 崩)、軸向對調(交叉項才有 R²≈1)、
換算比例錯(slope 不對)、符號反了(slope 為負)。

```bash
python3 tests/animation/verify_scenario.py     # 逐廠逐台,不抽樣(102 廠 / 239 台)
python3 tests/animation/capture_frames.py web/preview
cd web && npx vite &
node preview/shot3d.mjs /tmp/shots             # 24 組情境渲染 + 無 CDN / 無 console error
node preview/shotline.mjs /tmp/lineshots       # 5 種產線配方
node tests/animation/verify_animation.mjs      # 35 項,失敗回傳 exit 1
```

`.github/workflows/verify.yml` 讓這三套在每個 PR 自動跑。

**這套驗證抓到並修好的真缺陷**:手臂的 `tcp_x/y/z` 與六軸角度互相矛盾(方位角與 J1 的
相關係數 **−0.82** —— 手臂往左轉、回報的末端往右跑)、CNC 相位鎖定漏比 z 軸、鎖定增益
非 delta-based、故障時柱燈有一半的瞬間讀起來像警告、CNC 刻字上下鏡像。

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

**這份資料真的學得起來** —— 基準 ML 範例 [student_kit/p4_train_baseline.py](student_kit/p4_train_baseline.py)
(+ [notebook](student_kit/p4_train_baseline.ipynb))在**訓練時沒看過的 7 台 held-out CNC**上:故障分類
**F1 0.95 / ROC-AUC 0.998**、RUL 迴歸 **R² 0.94 / MAE 5.5h**、中位提前告警 **24.4h**;模型 top 特徵正是
振動 / 溫度等設計好的退化主軸。誠實設定(特徵只用觀測訊號、循環內滾動防洩漏、依機台切分)與完整解讀見
[docs/ML基準實證.md](docs/ML基準實證.md)。⚠ 合成資料學的是假設物理,適合教 ML 工作流程、不保證遷移真實設備。

## 兩份場景(課堂版 / 示範版)

兩份都由**產生器**產出(規則寫死、跑一次得同一份檔),要調組合改產生器再重跑,不要手改 YAML:

| 場景 | 產生器 | 規模 | 廠名 |
|------|--------|------|------|
| `scenarios/class_park.yaml` | `scenarios/scripts/gen_class_park.py` | 65 廠 / 154 設備 / 42 種設備組合(12 條產線 / 32 條供應鏈) | **虛構**的台灣精密製造業者 |
| `scenarios/default_park.yaml` | `scenarios/scripts/gen_default_park.py` | 37 廠 / 85 設備 / 29 種設備組合(6 條產線) | 「{產品線}廠({老師}負責)」 |

> ⚠ **不使用真實公司名**。這些廠會「故障」、資料全是合成的,掛真實廠商名字等於對真實企業的
> 不實陳述(CLAUDE.md 鐵則二)。示範版保留系上老師姓名作為負責人標示,那是刻意的。

設備組合**符合該產業的工程邏輯**而不是隨機湊 —— 射出廠配輸送帶出料、半導體廠配 AGV 搬晶圓盒、
熱處理廠配大電力電表。11 種 template 在兩份場景都全數出現。

**11 種產業 template**:CNC 加工中心 / 空壓機 / AGV 搬運車 / 六軸機械手臂 / 射出成型機 /
風力發電機 / 半導體製程腔體 / 智慧電表 / 沖壓機 / 熱處理爐 / 輸送帶。
(腔體:真空泵退化 + 製程漂移→良率 subtle fault;電表:三相 V/I、功因、日/週負載;
沖壓機:噸位、離合器 / 煞車 + 模具磨耗→毛邊;熱處理爐:爐溫、加熱元件老化 + 保溫 / 密封→均勻性)

設備只需寫 `id + template`,協定定址自動配、退化參數用 template 預設並做個體差異抖動。

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

## 教材資料包(平台不在線也能上課)

課堂教材有兩條路,**不要混用同一份題目**:活廠(平台開著,教師套當週情境、學生連線)與
**凍結資料包**(離線預產,發下去之後斷電 / 重啟 / 學期中改程式都不影響)。

```bash
python tools/make_offline_pack.py --zip                    # W4 Plan B:11 種產業各一台、7 sim 天乾淨基線
python tools/make_week_packs.py --zip                      # 每週凍結包(W4/W6-W8/W10-W12/W14)
python tools/make_week_packs.py --weeks 8 --seed 41143209  # 單週 × 學號種子(每人資料不同)
```

- 讀 `scenarios/course_weeks.yaml`(週次已對齊《18 週教學大綱 v2.1》):clear 週=乾淨基線;
  注入週對**半數 producer 注入、半數留乾淨對照**;`keep` 週沿用前一個有定義的週。
- **產後驗證,驗不過就拒產** —— 設備注入要健康度顯著下降、感測器注入要有可偵測趨勢、
  clear 週不得有故障。沒驗就發下去,可能整週的題目是無解的。
- 學生包**不含 ground-truth**;教師答案卷(誰被注入 / 哪個元件 / onset)另存 `packs/answers/`,
  發包時不要一起發。manifest 記 seed + engine commit,可重現、可溯源。

完整操作見 [docs/使用說明.md §5.3](docs/使用說明.md)。

## 進度

P0~P4 完成 + 上線硬化(~100% 功能面):**階段一+二可開課**、四 object type + 教師線圈控制、
SQLite 持久化(telemetry + 工單/預測/OEE)、6xxx 埠、venv 啟動 + 看門狗 + 健康檢查 + smoke test、
工業區世界 + 產線編排、11 產業 template、multi_port、OEE 榜、資料集產生器、課堂場景 65 廠、
學生任務中心 + 個人化連線包、教師快速故障 / 重置課堂 / 真 LLM 建廠、學生可寫 setpoint、熱載入免重啟、
課堂即時練習、學生自建監控台(Streamlit + 純 Python)、18 週課程規劃 + 「雲端生產」概念文件、
4D 暖色 UI 全面重設計。

**3D 動畫精準化**:建立[動畫綁定契約](docs/animation_binding.md)並依此重寫全部 11 種機型 3D、
[35 項自動驗證](tests/animation/README.md)接上 CI、廠內視圖改成依製程角色排列的產線。
過程中修掉的真缺陷:4 支讀到 undefined 的 tag、手臂 `tcp` 與六軸角度互相矛盾、
CNC 相位鎖定漏比 z 軸與非 delta-based 增益、故障柱燈讀起來像警告、CNC 刻字上下鏡像、
3D 層對 CDN 的相依(校內 LAN 無外網會讓整個 Canvas 崩掉)。

**引擎產線物料流 + 學生可寫控制**:工件真的在 CNC → 手臂 → 輸送帶之間傳遞(餓料 / 滿料誠實停機、
帳目守恆);CNC 可由 setpoint 刻任意文字、手臂可指定 A 取 B 放。

**學生決策層 / 課堂經營 / 供應鏈**:工單結案要診斷後[選對處置動作](docs/決策與後果.md)(選錯不會修好)、
預防保養停機換壽命、託管告警規則對 ground-truth 算 F1;[資料的一生九關](docs/關卡與進度.md) +
全班 N×9 進度熱力圖 + 協定端存取軌跡;[課堂即時互動](docs/課堂即時練習.md)(倒數 / 首答留名 /
全班投票**真的動到引擎**);[跨公司供應鏈](docs/供應鏈連動.md)(上游停→下游餓料、下游滿→上游阻塞)。

**最新(2026-08-01)**:課程週次對齊《18 週教學大綱 v2.1》、correlation 批改改**時間戳對齊**
(取樣率不同不會再算出假的相關係數)、`production` 生產管理 KPI 自動批改(準交率 / WIP);
**離線教材資料包**(見上一節)——平台在不在線都不影響已發教材。

**現況盤點(2026-08-03)**:所有開發分支已全數併入 main(無未合併 commit),歷史分支可刪。
下一步是**移動件到位精準化** —— AGV 車體與手臂夾爪在兩拍遙測之間以直線指數趨近補間,
會切過巡迴路線轉角、且漸近永遠差最後一小段;解法比照 CNC 刀尖既有的相位鎖定
(AGV 沿已知路徑做弧長鎖定、手臂對 keyframe 週期鎖相),並在動畫驗證新增「到位斷言」。
診斷與作法見 [docs/ROADMAP.md](docs/ROADMAP.md) 待辦 §0。

**驗證現況**:CI(`.github/workflows/verify.yml`)每個 PR 跑 場景健全性(102 廠 / 239 台逐廠逐台,
不抽樣)+ 9 支 Python 契約測試 + 前端 tsc/build + 動畫一致性 35 項,目前全綠。

**後續接續工作**見 [docs/ROADMAP.md](docs/ROADMAP.md)。

---

作者:勤益科大 劉瑞弘 · DofLab
