# 07 · 建置順序(P0–P4)

原則:**先讓一條垂直線會動,再往兩側長。** 2D 世界放後面 —— 它是加分,不是地基。
每個 phase 給「完成定義」(done = 可驗收的具體狀態)。

---

## P0 · 最小垂直切片 —— 證明「能產出可訓練的數據」

**目標**:一台 CNC 從健康自然退化到軸承故障,Modbus 抓得到,目錄查得到,Historian 有歷史。

- [ ] `engine/clock.py`:sim_clock + 時間加速。
- [ ] `engine/health.py`:DegradationComponent(linear + exponential 兩種軌跡)。
- [ ] `engine/signals.py`:訊號模型(baseline + g(health) + 熱滯後 + 雜訊),訊號相關。
- [ ] `engine/templates/cnc_machining_center.py`:CNC tag + 退化元件。
- [ ] `engine/device.py` + `engine/world.py`:載入單台、推進、產 snapshot。
- [ ] `adapters/modbus_server.py`:pymodbus 3.6.9,tag → register,channel-mux 單 unit。
- [ ] `api/catalog.py` + `GET /api/catalog`:設備目錄。
- [ ] `historian/writer.py` + TimescaleDB:寫入 + `GET /api/history`。
- [ ] 一份 `scenarios/p0_single_cnc.yaml`。

**完成定義**:`time_multiplier=3600` 跑,用任意 Modbus client 連得上、讀得到 vibration_rms
隨時間上升、最後跳 fault;TimescaleDB 查得到完整退化歷史曲線。

---

## P1 · 補協定、產業庫、Historian、2D 地圖雛形

- [ ] `adapters/opcua_server.py`(asyncua,node folder)、`adapters/mqtt_publisher.py`(topic)。
- [ ] 產業庫:`air_compressor`、`agv_mobile_robot`(P1 前段);`robot_arm_6axis`、`semi_process_chamber`(P1 後段)。
- [ ] 多設備場景 `scenarios/default_park.yaml`(數家公司、各產業)。
- [ ] `api/ws.py`:`/ws/telemetry` + `/ws/events`。
- [ ] `web/catalog`:公開設備目錄頁。
- [ ] `web/world`(PixiJS):2D 等距園區俯瞰 + 公司 + 設備三層,狀態驅動燈號(先不求動畫精緻)。

**完成定義**:同一台設備可同時被 Modbus / OPC-UA / MQTT 三協定讀到;瀏覽器能看園區俯瞰
並鑽到設備即時值。

---

## P2 · 故障注入、教師控制台、工單、自動評分、MCP —— 階段一教學完整可用

- [ ] `api/rest.py` 教師面:`/api/faults`、`/api/sim/clock`、`/api/devices/{id}/health`、auth。
- [ ] `engine/sensor_faults.py`:感測器故障後處理層。
- [ ] `api/tickets.py`:工單生成 / ack / resolve + MTTR。
- [ ] `api/scoring.py`:偵測延遲、處置正確性、漏報誤報。
- [ ] `web/teacher`:上帝視角控制台 + 參考客戶端儀表板。
- [ ] `ai/factory_generator.py` + `POST /api/factory`(NL 建廠);web 表單入口。
- [ ] `mcp/server.py`:`docs/06` 全部工具。
- [ ] `student_kit/`:連線骨架、目錄查詢、工單 API 範例。

**完成定義**:老師用 MCP 或表單建廠、注入故障;學生用自寫 client 偵測並開工單處置;
系統自動計分。階段一可實際開課。

---

## P3 · 階段二閉環即時推論

- [ ] `api/predictions.py` + `POST /api/predictions`。
- [ ] scoring 擴充:lead time、F1、RUL RMSE、誤報率。
- [ ] 2D 世界「預測故障(橘)」狀態 + `prediction_hit` 事件。
- [ ] `student_kit/` 加:訂閱遙測 + 上傳預測的範例服務骨架。
- [ ] ground-truth `fault_onset_time` / `RUL` 正確輸出供評分。

**完成定義**:學生模型訂閱遙測、在故障注入前 POST 預測;系統算出 lead time、
設備在世界翻橘、上榜。階段二可實際開課。

---

## P4 · 動畫、情境腳本、對外接入

- [ ] 2D 世界動畫:輸送帶 / 手臂 / AGV 移動 / 閃紅 / 橘脈動 / 冒煙。
- [ ] 情境腳本引擎 + `disaster_day` + `POST /api/scenarios/{name}/run`。
- [ ] OEE / 排名公開榜。
- [ ] 部署:`docker-compose.yml` 全套;Cloudflare Tunnel(HTTP)、Tailscale(原生協定)上線;
      ACL 限校內 / 學生群組。
- [ ] 多埠模式(multi_port)當進階範例。

**完成定義**:校外學生用瀏覽器看世界、用 Tailscale 抓協定;災難日可當期末測驗;
全套 `docker compose up` 一鍵起。

---

## 里程碑對應你的課程兩階段

- **第一階段(連線 / 監控 / 處置)開課** ← 需 **P2** 完成。
- **第二階段(分析 / 訓練 / 閉環預測)開課** ← 需 **P3** 完成。
- P4 是體驗升級與對外常駐,可在學期中滾動補。

## 風險提醒(別踩)

1. **別先做 3D / 寫實城市**:本案不做 3D;美術用 Kenney CC0,氛圍到位即可。
2. **別讓退化變 sine 波**:訊號相關 + 隱藏 health 是階段二能不能教的命脈,P0 就要對。
3. **狀態只在引擎**:任何「順手在前端 / adapter 存個值」都會破壞解耦,日後難拆。
4. **時間對 sim_clock**:任何對 wall clock 計時的退化都會在加速時出錯。
