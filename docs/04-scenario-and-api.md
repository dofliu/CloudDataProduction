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
| GET | `/api/tickets?owner=` | 我的工單 |
| POST | `/api/tickets/{id}/ack` / `/resolve` | 確認 / 結案工單 |
| POST | `/api/predictions` | **階段二**:上傳模型預測 `{device, predicted_fault, eta, confidence}` |
| GET | `/api/scores` | 計分排名(公開榜) |

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
hypertable。學生階段二用 SQL 撈歷史訓練。提供 `GET /api/history?device=&tag=&from=&to=`
方便學生匯出 CSV(也鼓勵他們直接連 DB 練 SQL)。
