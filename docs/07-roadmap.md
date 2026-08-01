# 07 · 建置順序(P0–P4)

> **狀態:P0–P4 全數完成(2026-08-01),本檔已成為歷史紀錄。**
> 下面 33 項任務與五個「完成定義」都已達成並在 CI 上有對應驗證。
> **現況、待辦與已知限制請看 [ROADMAP.md](ROADMAP.md)**;操作方式看 [使用說明.md](使用說明.md)。
> 保留本檔是為了留住**當初的建置順序與判斷理由** —— 後續加大功能時同一套原則仍適用
> (先垂直切片、先誠實資料、狀態只在引擎)。

原則:**先讓一條垂直線會動,再往兩側長。** 2D 世界放後面 —— 它是加分,不是地基。
每個 phase 給「完成定義」(done = 可驗收的具體狀態)。

---

## P0 · 最小垂直切片 —— 證明「能產出可訓練的數據」

**目標**:一台 CNC 從健康自然退化到軸承故障,Modbus 抓得到,目錄查得到,Historian 有歷史。

- [x] `engine/clock.py`:sim_clock + 時間加速。
- [x] `engine/health.py`:DegradationComponent(linear + exponential 兩種軌跡)。
- [x] `engine/signals.py`:訊號模型(baseline + g(health) + 熱滯後 + 雜訊),訊號相關。
- [x] `engine/templates/cnc_machining_center.py`:CNC tag + 退化元件。
- [x] `engine/device.py` + `engine/world.py`:載入單台、推進、產 snapshot。
- [x] `adapters/modbus_server.py`:pymodbus 3.6.9,tag → register,channel-mux 單 unit。
- [x] `api/catalog.py` + `GET /api/catalog`:設備目錄。
- [x] `historian/writer.py` + TimescaleDB:寫入 + `GET /api/history`。
- [x] 一份 `scenarios/p0_single_cnc.yaml`。

**完成定義**:`time_multiplier=3600` 跑,用任意 Modbus client 連得上、讀得到 vibration_rms
隨時間上升、最後跳 fault;TimescaleDB 查得到完整退化歷史曲線。

---

## P1 · 補協定、產業庫、Historian、2D 地圖雛形

- [x] `adapters/opcua_server.py`(asyncua,node folder)、`adapters/mqtt_publisher.py`(topic)。
- [x] 產業庫:`air_compressor`、`agv_mobile_robot`(P1 前段);`robot_arm_6axis`、`semi_process_chamber`(P1 後段)。
- [x] 多設備場景 `scenarios/default_park.yaml`(數家公司、各產業)。
- [x] `api/ws.py`:`/ws/telemetry` + `/ws/events`。
- [x] `web/catalog`:公開設備目錄頁。
- [x] `web/world`(PixiJS):2D 等距園區俯瞰 + 公司 + 設備三層,狀態驅動燈號(先不求動畫精緻)。

**完成定義**:同一台設備可同時被 Modbus / OPC-UA / MQTT 三協定讀到;瀏覽器能看園區俯瞰
並鑽到設備即時值。

---

## P2 · 故障注入、教師控制台、工單、自動評分、MCP —— 階段一教學完整可用

- [x] `api/rest.py` 教師面:`/api/faults`、`/api/sim/clock`、`/api/devices/{id}/health`、auth。
- [x] `engine/sensor_faults.py`:感測器故障後處理層。
- [x] `api/tickets.py`:工單生成 / ack / resolve + MTTR。
- [x] `api/scoring.py`:偵測延遲、處置正確性、漏報誤報。
- [x] `web/teacher`:上帝視角控制台 + 參考客戶端儀表板。
- [x] `ai/factory_generator.py` + `POST /api/factory`(NL 建廠);web 表單入口。
- [x] `mcp/server.py`:`docs/06` 全部工具。
- [x] `student_kit/`:連線骨架、目錄查詢、工單 API 範例。

**完成定義**:老師用 MCP 或表單建廠、注入故障;學生用自寫 client 偵測並開工單處置;
系統自動計分。階段一可實際開課。

---

## P3 · 階段二閉環即時推論

- [x] `api/predictions.py` + `POST /api/predictions`。
- [x] scoring 擴充:lead time、F1、RUL RMSE、誤報率。
- [x] 2D 世界「預測故障(橘)」狀態 + `prediction_hit` 事件。
- [x] `student_kit/` 加:訂閱遙測 + 上傳預測的範例服務骨架。
- [x] ground-truth `fault_onset_time` / `RUL` 正確輸出供評分。

**完成定義**:學生模型訂閱遙測、在故障注入前 POST 預測;系統算出 lead time、
設備在世界翻橘、上榜。階段二可實際開課。

---

## P4 · 動畫、情境腳本、對外接入

- [x] 2D 世界動畫:輸送帶 / 手臂 / AGV 移動 / 閃紅 / 橘脈動 / 冒煙。
- [x] 情境腳本引擎 + `disaster_day` + `POST /api/scenarios/{name}/run`。
- [x] OEE / 排名公開榜。
- [x] 部署:`docker-compose.yml` 全套;Cloudflare Tunnel(HTTP)、Tailscale(原生協定)上線;
      ACL 限校內 / 學生群組。
- [x] 多埠模式(multi_port)當進階範例。

**完成定義**:校外學生用瀏覽器看世界、用 Tailscale 抓協定;災難日可當期末測驗;
全套 `docker compose up` 一鍵起。

---

## 里程碑對應你的課程兩階段

- **第一階段(連線 / 監控 / 處置)開課** ← 需 **P2** 完成。✅ 已達成
- **第二階段(分析 / 訓練 / 閉環預測)開課** ← 需 **P3** 完成。✅ 已達成
- P4 是體驗升級與對外常駐,可在學期中滾動補。✅ 除**對外接入**(Cloudflare Tunnel + Tailscale)
  尚待能存取校內 5090 主機外皆已完成。

## P4 之後長出來的(不在原始規劃裡)

原始規劃到 P4 為止;實際開課需求又長出以下幾層,細節見 [ROADMAP.md](ROADMAP.md) 的 Done 表:

- **上線硬化**:四種 Modbus object type + 命令線圈、SQLite 雙庫持久化、venv + 看門狗 + smoke test。
- **資料誠實性的自動驗證**:動畫 ↔ 模擬資料一致性 35 項、場景逐廠逐台健全性、故障語意統一。
- **學生決策層**:處置選錯不會修好、保養停機換壽命、託管告警規則對 ground-truth 算 F1。
- **課堂經營**:資料的一生九關 + 全班進度熱力圖、即時練習 / 投票、跨公司供應鏈。
- **教材資料包**:離線備援包與每週凍結包(含產後驗證),讓平台不在線也能上課。

## 風險提醒(別踩)

1. **別先做 3D / 寫實城市**:本案不做 3D;美術用 Kenney CC0,氛圍到位即可。
2. **別讓退化變 sine 波**:訊號相關 + 隱藏 health 是階段二能不能教的命脈,P0 就要對。
3. **狀態只在引擎**:任何「順手在前端 / adapter 存個值」都會破壞解耦,日後難拆。
4. **時間對 sim_clock**:任何對 wall clock 計時的退化都會在加速時出錯。
