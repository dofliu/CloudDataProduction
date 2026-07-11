# Roadmap · TODO · Known Issues(路線圖 · 待辦 · 已知限制)

> 進度 Progress: **~99%**(P0–P4 + 上線硬化 + 產業庫擴充 + UI 全面重設計)· 更新 Updated: 2026-07-06
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
| **資料一致性** | 確定性種子(`--seed` 真可重現、每學號不同);engine tag `course-2026S1`;manifest 記 seed/commit([docs/資料集與作業.md](資料集與作業.md)) |
| **作業範本** | `make_assignment.py`(每學號 train + 私有 test + 答案金鑰)+ `grade_assignment.py`(F1/MAE 自動評分)+ rubric + 線上活廠驗收([docs/作業範本_預測性維護.md](作業範本_預測性維護.md)) |
| **產業庫擴充** | **半導體製程腔體 `semi_process_chamber`**(真空泵退化→fault、process_drift→particle_count→良率掉的 subtle fault、MFC 讀值漂移)+ **電表 `energy_meter`**(三相 V/I、功因、kWh 累積、日/週負載曲線、capacitor_aging、異常耗電以 sensor_fault 注入);掛入園區(東台 c03 / 大立光 c06 各一腔體、新增 c23 能源中心 2 電表),前端 2D sprite + NL 建廠關鍵字齊備 |
| **學生體驗(2026 秋)** | 「🚀 開始」任務中心落地頁(故事引導 + 真實狀態自動打勾任務 + **個人化可跑連線包**:讀值 / 監控告警 / 階段二預測)、我的設備即時現況、後端斷線友善提示 + 自動恢復、名詞速查浮層、學生快速上手 .docx |
| **教學工具鏈** | 教師「⚡ 快速故障(demo)」+ **一鍵「🧹 重置課堂資料」**(`/api/session/reset`,換班歸零不刪 DB)+ **真 LLM 建廠**(Gemini REST,一句話建多型別工廠,失敗回退規則式)+ **腔體製程漂移 subtle-fault 迴歸作業**(`grade_chamber_assignment.py` + [docs/作業範本_製程漂移.md](作業範本_製程漂移.md)) |
| **熱載入補完** | NL/LLM 建的新設備三原生協定即時上線免重啟:Modbus channel-mux(`_hot_add` 動態建 slave,與 `ModbusServerContext` 同 dict 即刻生效)、OPC-UA(`_add_device` 執行時加 node)、multi_port(動態配專屬埠起 server);MQTT 本即時 |
| **UI 全面重設計** | 依 [docs/design_handoff_ui_redesign](design_handoff_ui_redesign/) 設計稿:深色工業風 tokens + **IBM Plex Sans TC / Mono** 字體、頂欄 logo/SYNTHETIC pill/**全域燈號摘要**/Mono 時鐘、側欄**關鍵訊號門檻條** + 分區;五頁(學生/目錄 master-detail/戰情/OEE/教師)卡片化;2.5D 世界照設計稿實作**等距金屬量體**(`isoBox3` 三面 `FillGradient` 漸層 + 徑向陰影/發光)——俯瞰建築窗格網 + 廠內機台 mCNC/mArm/mChamber… 逐台重繪。資料流 / API 完全不動 |

| **課堂即時練習** | 教師一鍵佈題(對一台設備套健康 / 感測器故障 / 設備退化情境)→ 學生手機作答(匿名以座號/學號)→ 即時批改、計入平時成績;題分基礎(觀察/選擇)與進階(統計/相關/趨勢/根因,重用既有誠實批改器)。教師面即時看板(答對率/分佈)+ 平時成績。定義於 `scenarios/classroom_exercises.yaml`,見 [docs/課堂即時練習.md](課堂即時練習.md) |

兩個教學階段皆可開課。Both teaching stages are classroom-ready.

---

## ⏳ 待辦 · TODO（依優先序 by priority）

1. **對外接入 External access** —— Cloudflare Tunnel(HTTP)+ Tailscale(原生協定),ACL 限校內 / 學生群組。
   *暫緩,待能存取校內 5090 主機。Deferred until the on-campus 5090 host is accessible.*
2. **真 LLM 建廠 Real-LLM factory** —— ✅ 已完成:接 Gemini(REST,免 SDK)做自由描述、**一句話建多型別工廠**,
   失敗自動回退規則式;輸出嚴格驗證(見 Done 表)。Done — Gemini via REST, multi-template, graceful fallback.
4. **熱載入補完 Hot-add completeness** —— ✅ 已完成:三個原生協定 adapter(Modbus channel-mux / OPC-UA /
   multi_port)於下一拍動態掛 slave / node / 專屬埠,NL/LLM 建的新設備即時可連、免重啟(見 Done 表)。
5. **OPC-UA multi_port** —— 目前 multi_port 只做 Modbus;OPC-UA per-device endpoint 為進階選項(較重)。
6. **更多產業 More templates** —— ✅ 已完成:半導體製程腔體、電表能源節點、**沖壓機**、**熱處理爐**(共 10 種)。
   後續可再補:廢水 / 環控節點、鑄造、噴塗等。Wastewater/environmental, casting, coating next.

---

## ⚠ 已知限制 · Known Issues / Limitations

- **熱載入設備 Hot-added devices**:NL/LLM 建的新設備即時出現在 2D 世界 / 目錄 / OEE、且三協定
  (Modbus channel-mux / OPC-UA / MQTT + multi_port)於下一拍 snapshot 動態掛上,**免重啟**。
  Hot-added devices go live on all native protocols without restart.
- **持久化範圍 Persistence scope**:`DB_BACKEND=sqlite` 後 telemetry(`historian.db`)與工單/預測/OEE(`state.db`)重啟不丟。
  production 可改 `timescale`。Local SQLite persists telemetry + ops state across restarts.
- **待機 RUL Idle RUL**:two_shift 設備在下班時段不退化,RUL 顯示「—」(未定義),屬正確行為。Correct behaviour.
- **PowerShell + curl 的 JSON**:Windows PowerShell 會弄壞 `curl -d '{json}'`(送出空物件 → 422);發 POST 請用
  student_kit 的 Python 或網頁 UI。PowerShell mangles `curl` JSON bodies — use the Python scripts or web UI for POST.
- **必須用 venv python**:裸 `python` = 全域那支(版本會漂移,pymodbus 被拉到 3.9.2 會崩);一律 `run-engine.ps1`。
- **本機埠 Local ports**:工業協定埠統一 6xxx(Modbus 6020 / OPC-UA 6041 / MQTT 6083 / multiport 6100+ / 控制埠 6023),避開 5040(CDPSvc)等保留埠;API 8077。含中文的 .ps1 須存 UTF-8 BOM。

---

## 🔭 未來想法 · Future Ideas

- ✅ 讀寫控制:命令線圈 `run_enable` / `reset_fault`(教師)+ **學生可寫設定點**(受控範圍,holding FC06:
  空壓機 pressure、CNC spindle rpm;後端夾限、越界 snap、量測仍唯讀)。Coils (teacher) + student-writable setpoints done.
- 階段二評分擴充:F1、RUL RMSE、誤報率細化。Richer Stage-2 metrics (F1, RUL RMSE).
- 美術升級:導入 Kenney.nl CC0 等距素材取代 Graphics 幾何。Swap Graphics primitives for Kenney CC0 art.
- 本機 LLM + RAG 故障診斷助手(接 wind-turbine MCP / TAG-Wind 知識庫)。Local LLM + RAG diagnosis assistant.
- 多埠範圍 / OPC-UA 安全模式 / MQTT 帳密 等更貼近真實場域的進階設定。
- **每台設備支援的協定不同(per-device protocol capability)** —— 目前每台設備三種協定(Modbus /
  OPC-UA / MQTT)全上;更貼近真實場域的做法是**讓不同設備只暴露部分協定**(如老舊 PLC 僅 Modbus、
  新錶端才有 MQTT)。屆時:設備目錄 `connection` 只列該設備真正支援的協定;學生 client / 監控台需依
  目錄動態決定可選協定(本專案 `student_kit/dashboard_simple` 的協定切換已預留此擴充點:目錄有哪個
  協定區塊才顯示對應分頁)。Different devices expose different protocol subsets; catalog + clients gate
  protocol choice by what each device actually advertises.

---

> 本檔隨進度滾動更新。This document is updated as the project progresses.
