# CLAUDE.md

這是 Claude Code 在本 repo 工作時的進場說明。先讀本檔,再依任務讀 `docs/` 對應章節。

**沒有指定任務時(例如排程 routine 醒來),讀 `.claude/NEXT_TASKS.yaml`** —— 那是可執行的工作
佇列:由上而下就是優先序,每項標了自主程度(`self` 自己做完開 draft PR / `ask_first` 先問)、
完成定義與驗證指令。做完要在同一個 PR 裡回填該項的 `status` 與 `pr`。
敘事版的現況與理由在 `docs/ROADMAP.md`,兩邊衝突以 ROADMAP 為準並回頭修佇列。

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
│   ├── repair.py              # 處置 / 保養動作字典(維修手冊:每種故障在數據上長什麼樣)
│   ├── signals.py             # 訊號模型(health→觀測,含熱滯後/雜訊)
│   ├── sensor_faults.py       # 感測器故障層(stuck/drift/bias/dropout)
│   ├── device.py              # Device = tags + drivers + health components
│   ├── templates/             # 產業型別庫(15 種,見 docs/03;_stroke_font.py = CNC 刻字筆畫字型)
│   ├── line.py                # 產線物料流:line: 宣告的公司,工件在站間真實傳遞
│   ├── mes.py                 # MES:工單驅動設備運轉
│   ├── course.py              # 每週課程情境:把 course_weeks.yaml 的條件套到跑著的引擎
│   ├── supply.py              # 跨公司供應鏈:A 出貨 = B 進料;上游停→下游餓料、下游滿→上游阻塞
│   └── world.py               # 載入場景、推進所有設備、廣播狀態
├── adapters/                  # 協定轉接層(讀 engine 狀態)
│   ├── access_log.py          # 協定端存取軌跡(哪台被讀幾次 / 多久打一次;拿不到身分)
│   ├── modbus_server.py
│   ├── modbus_multiport.py    # 進階模式:每台設備一個專屬埠(6100+)
│   ├── opcua_server.py
│   └── mqtt_publisher.py
├── api/                       # FastAPI:REST 控制面 + WebSocket 即時面
│   ├── rest.py
│   ├── ws.py
│   ├── auth.py                # 教師 token / 學生認領的權限判定
│   ├── catalog.py             # 公開設備目錄(學生規格書)
│   ├── commissioning.py       # 整合建廠自動上線:點位表(JSON/CSV/MD)+ 三協定試連自測
│   ├── tickets.py             # 工單:結案要選對處置動作,選錯扣工時且不會修好
│   ├── maintenance.py         # 預防保養:停機換壽命(停機計入可用率損失)
│   ├── alarm_rules.py         # 學生託管告警規則:平台代跑,對 ground-truth 算 F1 / lead time
│   ├── levels.py              # 資料的一生九關 + 全班進度看板(判定現查,不快取)
│   ├── classroom.py           # 課堂即時練習:佈題倒數 / 學生作答 / 即時批改 / 首答留名
│   ├── polls.py               # 全班投票:收票後照多數決真的去動引擎
│   ├── submissions.py         # 作業繳交與自動批改(含 production KPI:準交率 / WIP)
│   ├── scenarios.py           # 情境腳本(災難日)+ 每週課程情境套用
│   ├── oee.py                 # OEE 累積與排名榜
│   ├── diagnostics.py         # 健康檢查 / 連線自測(戰情版)
│   ├── scoring.py             # 用 ground-truth 自動評分
│   └── predictions.py         # 階段二:接收學生模型預測
├── ai/                        # 自然語言建廠(LLM)
│   └── factory_generator.py
├── historian/                 # 持久化
│   ├── writer.py              # 高頻 telemetry → SQLite / TimescaleDB
│   └── state_store.py         # 營運狀態(工單 / 預測 / OEE / 認領)重啟不歸零
├── mcp/                       # MCP server(打 REST API)
│   └── server.py
├── tools/                     # 教材與運維工具(headless,不需要活廠)
│   ├── make_device_atlas.py   # 設備動畫圖鑑:preview 截圖 + 綁定契約 → docs/設備動畫圖鑑.md
│   ├── audit_data_coverage.py # 資料盤點:逐機型訊號覆蓋 + 資料域缺口(docs/資料盤點_生產數據完整性.md 的數字來源)
│   ├── make_offline_pack.py   # 離線備援包:每種產業各一台、一週乾淨基線(W4 Plan B)
│   ├── make_week_packs.py     # 每週凍結資料包:逐週預產 + 產後驗證 + 教師答案卷
│   ├── generate_dataset.py    # 階段二訓練資料集(快轉 run-to-failure)
│   ├── make_assignment.py     # 作業出題:每學號 train + 私有 test + 答案金鑰
│   ├── grade_assignment.py    # 自動評分(F1 / MAE);grade_chamber_assignment.py 為製程漂移版
│   ├── smoke_test.py          # 對執行中世界做不變式檢查(回傳 0/1 供 CI / 排程)
│   └── stress_test.py         # WS / API 壓測
├── scenarios/                 # 場景 YAML(見 docs/04)
│   ├── levels.yaml            # 九關與支線徽章定義(改關卡改這裡,api/levels.py 不寫死)
│   ├── classroom_exercises.yaml # 課堂即時練習題庫
│   ├── classroom_polls.yaml   # 全班投票題庫
│   ├── course_weeks.yaml      # 每週課程情境(週次對齊《18週教學大綱 v2.1》)
│   ├── class_park.yaml        # 課堂版園區(65 廠 / 154 設備 / 12 產線 / 32 條供應鏈)
│   ├── default_park.yaml      # 示範版園區(37 廠 / 85 設備 / 6 產線)
│   └── scripts/               # ★ 場景產生器(gen_class_park.py / gen_default_park.py)
├── web/                       # React + PixiJS + three.js 前端
│   ├── src/world/             # 俯瞰(PixiJS)+ 廠內產線(three.js)+ 15 種機型 3D
│   │   ├── deviceMotion.ts    # 資料橋:狀態正規化 / 退化度 / 補間 / L3 時間換算
│   │   ├── processFlow.ts     # 製程角色 → 產線佈局(誰在上游、手臂伸去哪)
│   │   └── MachineFx.tsx      # 共用視覺語彙:柱燈 / 冒煙 / 抖動 / 過熱輝光
│   ├── preview/               # dev 專用:逐台渲染、產線配方、量測、驗證載具
│   ├── teacher/               # 上帝視角控制台 + 參考客戶端儀表板
│   └── catalog/               # 公開設備目錄頁
├── tests/animation/           # 動畫 ↔ 模擬資料一致性驗證(見該目錄 README)
├── tests/daily/               # 每日模擬測試:情境輪替 + 圖文報告
├── tests/test_input_control.py  # CNC 刻字 / 手臂取放:寫 setpoint 後輸出真的跟著變(CI)
├── tests/test_line_flow.py      # 產線物料流:守恆 / 餓料滿料誠實停機 / 輸送帶終站(CI)
├── tests/test_repair_actions.py # 處置選錯不會修好 / 保養真的扣可用率 / 一次故障一張單(CI)
├── tests/test_alarm_rules.py    # 告警規則:持續與重新武裝 / F1 與 lead time(CI)
├── tests/test_levels.py         # 九關:自動判定查平台事實 / 人工勾選不能濫用 / 瓶頸關(CI)
├── tests/test_classroom_live.py # 倒數截止 / 首答留名 / 全班投票真的動到引擎(CI)
├── tests/test_supply_chain.py   # 上游停→下游餓料 / 下游停→上游阻塞 / 守恆(CI)
├── tests/test_commissioning.py  # 整合建廠 A+B+C:白名單 / 熱上線配址 / 點位表不洩答案(CI)
├── tests/test_course_grading.py # 週次對齊大綱 / correlation 時間戳對齊 / production KPI(CI)
├── tests/test_week_packs.py     # 每週凍結包:產得出來 / 驗證擋得住 / 學生包不洩答案(CI)
├── .github/workflows/verify.yml   # CI:場景健全性 / 前端建置 / 動畫一致性
└── student_kit/               # 給學生的範例:連線骨架、目錄查詢、預測上傳範例
```

**場景不要手改 YAML** —— `scenarios/*.yaml` 由 `scenarios/scripts/gen_*.py` 產生,
要調組合改產生器再重跑。手改會在下次重產時被蓋掉。

**教材有兩條路,別混在一起** —— 活廠(平台開著,教師套當週情境、學生連線)與
**凍結包**(`tools/make_week_packs.py` / `make_offline_pack.py` 離線預產,平台在不在線
都不影響已發教材)。凍結包一律:學生包不含 ground-truth、教師答案卷分開存、manifest 記
seed + engine commit,且**產後要驗**(注入的東西在觀測窗內真的找得到,驗不過就拒產)。

**`docs/設備動畫圖鑑.md` 與 `docs/images/device_atlas/` 也是產生的** ——
由 `tools/make_device_atlas.py` 依 preview 截圖與綁定契約重產,不要手改。

**目前的重心是資料,不是動畫(2026-08-21 定調)** —— 設備動畫與機型擴充告一段落,除非教學上
真的需要新機型,不要再往那條線加東西。現在要補的是**資料鏈**:停機原因碼、事件表、逐件生產
紀錄與良/不良計數、取數介面。實測盤點與缺口見 `docs/資料盤點_生產數據完整性.md`
(數字跑 `python tools/audit_data_coverage.py` 重產),工作項見佇列 T13–T15。

**要改動畫先讀 `docs/animation_binding.md`**(綁定契約)。那份文件是動畫的唯一依據:
每個會動的部位都必須對應一支具體 tag,前端不重算引擎已算過的物理,做了時間換算要標倍率。
改完跑 `tests/animation/` 那套(CI 也會跑)。

## 開發慣例

- prose / 註解用繁體中文,識別碼 / API / schema 用英文。
- 每個設備 tag 都要有:`name`、`unit`、`datatype`、`modbus_register`、`opcua_node`、`mqtt_field`。
- 故障注入、健康狀態 ground-truth 屬「老師面」,API 需 auth;設備目錄與遙測屬「學生面」,公開唯讀。
  **工單的 component / fault_type 也是 ground-truth**(等於寫著答案),學生視圖只給症狀。
- 學生的操作要**有代價**:處置選錯照扣工時、保養停機計入可用率、告警太敏感就誤報。
  做對做錯的差別由引擎誠實反映,不是改分數改出來的(見 docs/決策與後果.md)。
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
