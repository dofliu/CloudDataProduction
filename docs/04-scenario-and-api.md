# 04 · 場景 Schema 與 API

## 場景 YAML(單一事實來源)

一個工業區用一份 YAML 描述。引擎吃它建世界,設備目錄與 2D 世界也讀它做自動發現。

```yaml
park:
  name: "勤益智慧工業區"
  sim:
    tick_hz: 10
    time_multiplier: 60          # 1 / 60 / 3600
  protocol_mode: channel_mux     # channel_mux(預設,共用3埠) | multi_port
  ports:                         # channel_mux 模式共用
    modbus: 502
    opcua: 4840
    mqtt: 1883

  companies:
    - id: c01
      name: "精鋐機械"
      industry: cnc_machining
      owner: null                # 學生認領後填學號
      map_pos: {x: 12, y: 8}     # 園區 2D 地圖格座標
      devices:
        - id: cnc-01
          template: cnc_machining_center
          protocols:
            modbus: {unit_id: 1}                       # channel_mux:用 unit_id 分
            opcua:  {node_folder: "c01/cnc-01"}
            mqtt:   {topic_prefix: "park/c01/cnc-01"}
          duty_cycle: {profile: two_shift, load_nom: 70}
          degradation:
            spindle_bearing: {rate: 0.00008, trajectory: exponential, sigma: 0.1, init_health: 0.96}
            tool_wear:       {rate: 0.03,    trajectory: linear,      sigma: 0.2, init_health: 1.0}

    - id: c02
      name: "晶宏半導體"
      industry: semiconductor
      owner: null
      map_pos: {x: 20, y: 14}
      devices:
        - id: etch-01
          template: semi_process_chamber
          protocols:
            modbus: {unit_id: 10}
            opcua:  {node_folder: "c02/etch-01"}
            mqtt:   {topic_prefix: "park/c02/etch-01"}
          duty_cycle: {profile: continuous}
          degradation:
            vacuum_pump_wear: {rate: 0.00005, trajectory: exponential, sigma: 0.1, init_health: 0.9}
            process_drift:    {rate: 0.0001,  trajectory: wiener,      sigma: 0.3, init_health: 1.0}
```

### multi_port 模式差異

`protocol_mode: multi_port` 時,每台設備在 `protocols` 內各自指定獨立 `port`
(而非共用 unit_id),系統預先開埠範圍(如 5000–5100)。其餘相同。

### 自然語言建廠對應

「建一間有 5 套機械手臂的公司」→ LLM 依 template 庫產生上述結構的 5 台 `robot_arm_6axis`
設備片段 → pydantic 驗證 → 自動配不衝突的 unit_id / topic → 併入 park → 熱載入。

---

## 協定轉接綁定

每個 tag 帶三組映射,adapters 各取所需,讀**同一份引擎 snapshot**:

| 協定 | 定址 | tag 映射 |
|------|------|----------|
| Modbus TCP | `unit_id`(channel)或 `port`(multi) | `modbus_register`(holding / input register);float 用兩個 register |
| OPC-UA | 位址空間資料夾 `node_folder` | `opcua_node`,完整路徑 `Objects/<node_folder>/<node>` |
| MQTT | topic 前綴 `topic_prefix` | 發佈到 `<topic_prefix>/<mqtt_field>` 或整包 JSON `<topic_prefix>/state` |

> 同一個 tag 同時透過三協定可讀 —— 這是核心教學點:學生能直接對比三種協定差異。

---

## REST API(控制面)

> 教師面端點需 `Authorization: Bearer <teacher_token>`;學生面公開唯讀。

### 公開(學生面)

| 方法 | 路徑 | 說明 |
|------|------|------|
| GET | `/api/park` | 園區地圖 + 公司清單 + 認領狀態 |
| GET | `/api/catalog` | **設備目錄(規格書)**:每台設備的協定 / IP / port / unit_id / topic / node / tag 清單 |
| GET | `/api/devices/{id}` | 單台設備公開資訊(不含 ground-truth) |
| POST | `/api/companies/{id}/claim` | 學生認領公司 `{student_id}` |
| GET | `/api/tickets?owner=` | 我的工單(**學生視圖不含 component / fault_type**,那是根因 = 答案;只給 `symptom`) |
| POST | `/api/tickets/{id}/ack` | 確認工單(記偵測延遲) |
| POST | `/api/tickets/{id}/resolve` | **帶處置動作**結案 `{action, student}`;選對才修得好,選錯扣 60% 工時且退回處理中 |
| GET | `/api/repair/actions` | 維修手冊:動作 / 工時 / **數據上的徵候**(不含哪台該用哪個,不洩答案) |
| POST | `/api/maintenance` | 預防保養 `{device, action}`(需認領授權);停機計入可用率損失 |
| GET | `/api/maintenance?actor=` | 我的保養紀錄 + 各公司彙整 |
| POST | `/api/alarm_rules` | 託管告警規則 `{device, tag, agg, window_s, op, threshold, for_s}` |
| GET | `/api/alarm_rules?student=` | 我的規則與最近告警 |
| DELETE | `/api/alarm_rules/{id}` | 刪除自己的規則 |
| GET | `/api/alarm_rules/scores` | 告警規則排行:precision / recall / F1 / 平均提前量 |
| POST | `/api/predictions` | **階段二**:上傳模型預測 `{device, predicted_fault, eta, confidence}` |
| GET | `/api/history` | 歷史取數:多設備 / 多 tag / 降採樣 / wide / CSV(見下方 Historian 一節) |
| GET | `/api/sql` `/api/sql/tables` | **唯讀 SQL**:學生自己寫查詢,四張表白名單,寫入由資料庫層拒絕 |
| GET | `/api/scores` | 計分排名(公開榜,含誤修次數 `wrong_repairs`) |

### 教師面(需 auth)

| 方法 | 路徑 | 說明 |
|------|------|------|
| POST | `/api/factory` | 建廠:`{yaml}` 或 `{description}`(走 LLM) |
| POST | `/api/devices` / PATCH `/api/devices/{id}` | 增改設備 |
| POST | `/api/faults` | 注入故障 `{device, component, fault_type, severity, onset}` |
| GET | `/api/devices/{id}/health` | **ground-truth**:health / RUL / fault_type |
| POST | `/api/sim/clock` | `{multiplier, paused}` 調時間 / 暫停 |
| POST | `/api/scenarios/{name}/run` | 載入情境腳本(災難日) |

---

## WebSocket(即時面)

| 路徑 | 推送內容 |
|------|----------|
| `/ws/telemetry` | 全設備 tag 即時值(2D 世界 + 儀表板訂閱) |
| `/ws/events` | 故障事件、狀態轉換、工單事件、預測命中事件 |

訊息格式(telemetry,每 tick 或節流後):
```json
{
  "t": 1719500000.0, "sim_t": 36000.0, "multiplier": 60,
  "devices": {
    "cnc-01": {"state": "running", "tags": {"vibration_rms": 2.31, "spindle_temp": 58.4, ...}}
  }
}
```

events:
```json
{"type": "fault", "device": "cnc-01", "fault_type": "gradual", "component": "spindle_bearing", "sim_t": 36210.0}
{"type": "prediction_hit", "device": "cnc-01", "student": "S123", "lead_time_sim": 1820.0}
```

---

## Historian 寫入

`historian/writer.py` 批次把每個 tag 的 `(time, device_id, tag, value)` 寫入 TimescaleDB
hypertable(無 DB 時退回 SQLite,再不行走記憶體降級模式;三種後端查出來的結果逐列一致)。

### 取數:`GET /api/history`

| 參數 | 說明 |
|------|------|
| `device=` / `tag=` | 舊寫法,單設備單 tag。**維持原本的回傳結構不變** |
| `devices=` / `tags=` | 逗號分隔多值,一次撈一條產線的跨設備資料 |
| `bucket=` | 時間桶秒數(0 = 原始取樣)。每桶回 `avg` / `min` / `max` / `count` |
| `shape=` | `wide`(預設,一列一個時間點、一欄一條序列)或 `long`(一列一個測點) |
| `format=` | `json`(預設)或 `csv`(帶 UTF-8 BOM,Excel 直接開) |
| `limit=` | wide 是**時間列數**、long 是總列數 |

**降採樣別只看 `avg`** —— 預測性維護要偵測的就是峰值,振動尖峰被小時平均一抹就沒了;
`max` 與 `avg` 的差距本身就是那一桶的波動幅度。

時間戳天然對齊(historian 每一拍寫的是同一個快照,不是各 tag 各自取樣),所以 wide 的
每一列就是一個時刻的橫斷面,`pd.DataFrame(points).corr()` 可以直接算 —— 真工廠的多來源
資料沒有這個性質,對齊是另一門功課。窗內完全沒資料的序列會列進回傳的 `missing` 欄位,
不會靜靜消失(不是每台都有每支 tag:CNC 是 `spindle_current`、研磨機才是 `motor_current`)。

### 進階:唯讀 SQL

`GET /api/sql?q=<SQL>` 讓學生直接寫 SQL 撈(`GET /api/sql/tables` 給表結構)。可查的表:
`telemetry` / `events` / `production` / `production_hourly`。

**安全邊界不靠字串比對。** 關鍵字黑名單只是第一層(擋掉明顯的寫入意圖、給出好的錯誤訊息);
真正的防線是**讓資料庫自己拒絕寫入** —— SQLite 走 `file:…?mode=ro` URI 連線、PostgreSQL 走
`READ ONLY` 交易,兩邊都加逾時上限。契約測試刻意繞過正則直接對唯讀連線送 `DELETE`,
確認擋下來的是資料庫而不是那條正則。

健康度、故障元件名這類 ground-truth 本來就不在這幾張表裡,SQL 撈不到答案。

範例見 `student_kit/p6_fetch_data.py`(四種取法,設備與 tag 由 `/api/catalog` 現查、不寫死)。
