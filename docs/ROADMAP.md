# Roadmap · TODO · Known Issues(路線圖 · 待辦 · 已知限制)

> 進度 Progress: **~99%**(P0–P4 + 上線硬化)· 更新 Updated: 2026-06-29
> 建置順序原始規劃見 [07-roadmap.md](07-roadmap.md);本檔為現況與後續。

---

## ✅ 已完成 · Done

| 階段 Phase | 內容 Content |
|------------|--------------|
| **P0** | 模擬引擎(隱藏健康 + 退化 + 相關訊號 + 時間加速)、CNC、Modbus、設備目錄、Historian、run-to-failure |
| **P1** | OPC-UA + MQTT(免 Docker)、空壓機 / AGV、多設備園區、WebSocket、PixiJS 2D 世界 + 目錄頁 |
| **P2** | 故障注入 + 感測器故障層、教師 auth、工單(MTTR)、自動評分、教師控制台、NL 建廠、MCP server |
| **P3** | 閉環預測(`/api/predictions`)、lead-time 評分、預測故障橘、AGV 平滑、student_kit 預測範例 |
| **P4** | 災難日情境腳本、OEE 排名榜、2.5D 工業區(街道 + 多棟建築 + 動畫)、機械手臂、multi_port、戰情版連線自測、**階段二資料集產生器**、UI 建廠、**公司鑽入廠內動畫** |
| **硬化 Hardening** | **四種 object type**(holding FC03 / discrete input FC02 / input register FC04 ×100 鏡像 / **coil FC01 讀+FC05 寫**,教師才可寫)、**SQLite 持久化**(telemetry + 工單/預測/OEE + 公司認領,重啟不歸零)、**6xxx 埠**、**venv 啟動腳本 + 看門狗 + `/api/health` + smoke test**、產線編排 + 廠內人員、平靜更新、風機/AGV run_enable 停機修正、學生講義 .docx |
| **可訓練性實證** | 基準 ML 範例:held-out CNC 故障分類 F1 0.95 / RUL 迴歸 R² 0.94([docs/ML基準實證.md](ML基準實證.md)) |
| **學生面公開頁** | 認領公司 → 我的工單(ack/resolve)→ 競賽榜(故障管理 / 預測 / OEE),公開免 token |

兩個教學階段皆可開課。Both teaching stages are classroom-ready.

---

## ⏳ 待辦 · TODO（依優先序 by priority）

1. **對外接入 External access** —— Cloudflare Tunnel(HTTP)+ Tailscale(原生協定),ACL 限校內 / 學生群組。
   *暫緩,待能存取校內 5090 主機。Deferred until the on-campus 5090 host is accessible.*
2. **真 LLM 建廠 Real-LLM factory** —— 目前規則式;接 Gemini(已有 key)做任意產線自然語言描述。
   Currently rule-based; wire Gemini for free-form NL factory descriptions.
4. **熱載入補完 Hot-add completeness** —— NL 建廠的新設備目前需重啟才上 Modbus / OPC-UA 共用埠與專屬埠
   (MQTT 即時)。讓 adapters 支援動態加 register / node / port。Make adapters add registers/nodes/ports at runtime.
5. **OPC-UA multi_port** —— 目前 multi_port 只做 Modbus;OPC-UA per-device endpoint 為進階選項(較重)。
6. **更多產業 More templates** —— 半導體製程腔體(particle_count 良率)、電表 / 能源節點(OEE / 能耗題)。
   Semiconductor process chamber, energy meter.

---

## ⚠ 已知限制 · Known Issues / Limitations

- **熱載入設備 Hot-added devices**:NL 建廠的新設備即時出現在 2D 世界 / 目錄 / OEE / MQTT,但 Modbus /
  OPC-UA 共用埠與專屬埠需重啟 server 才暴露。New devices need a server restart for Modbus/OPC-UA.
- **持久化範圍 Persistence scope**:`DB_BACKEND=sqlite` 後 telemetry(`historian.db`)與工單/預測/OEE(`state.db`)重啟不丟。
  production 可改 `timescale`。Local SQLite persists telemetry + ops state across restarts.
- **待機 RUL Idle RUL**:two_shift 設備在下班時段不退化,RUL 顯示「—」(未定義),屬正確行為。Correct behaviour.
- **PowerShell + curl 的 JSON**:Windows PowerShell 會弄壞 `curl -d '{json}'`(送出空物件 → 422);發 POST 請用
  student_kit 的 Python 或網頁 UI。PowerShell mangles `curl` JSON bodies — use the Python scripts or web UI for POST.
- **必須用 venv python**:裸 `python` = 全域那支(版本會漂移,pymodbus 被拉到 3.9.2 會崩);一律 `run-engine.ps1`。
- **本機埠 Local ports**:工業協定埠統一 6xxx(Modbus 6020 / OPC-UA 6041 / MQTT 6083 / multiport 6100+ / 控制埠 6023),避開 5040(CDPSvc)等保留埠;API 8077。含中文的 .ps1 須存 UTF-8 BOM。

---

## 🔭 未來想法 · Future Ideas

- 讀寫控制進階(已起步):命令線圈 `run_enable` / `reset_fault` 已可寫(教師)。下一步可開放學生在受控範圍寫
  setpoint(寫 holding 改節拍 / 溫度目標)。Coils done for teacher; next: student-writable setpoints.
- 階段二評分擴充:F1、RUL RMSE、誤報率細化。Richer Stage-2 metrics (F1, RUL RMSE).
- 美術升級:導入 Kenney.nl CC0 等距素材取代 Graphics 幾何。Swap Graphics primitives for Kenney CC0 art.
- 本機 LLM + RAG 故障診斷助手(接 wind-turbine MCP / TAG-Wind 知識庫)。Local LLM + RAG diagnosis assistant.
- 多埠範圍 / OPC-UA 安全模式 / MQTT 帳密 等更貼近真實場域的進階設定。

---

> 本檔隨進度滾動更新。This document is updated as the project progresses.
