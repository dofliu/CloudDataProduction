# Roadmap · TODO · Known Issues(路線圖 · 待辦 · 已知限制)

> 進度 Progress: **~99%**(P0–P4 大致完成)· 更新 Updated: 2026-06-28
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

兩個教學階段皆可開課。Both teaching stages are classroom-ready.

---

## ⏳ 待辦 · TODO（依優先序 by priority）

1. **對外接入 External access** —— Cloudflare Tunnel(HTTP)+ Tailscale(原生協定),ACL 限校內 / 學生群組。
   *暫緩,待能存取校內 5090 主機。Deferred until the on-campus 5090 host is accessible.*
2. **持久化 Historian Persistent historian** —— in-memory 換成 TimescaleDB(Docker)或 SQLite/parquet 落地,
   即時歷史重啟不丟、長度不限。Swap in-memory for a durable store so live history survives restarts.
3. **真 LLM 建廠 Real-LLM factory** —— 目前規則式;接 Gemini(已有 key)做任意產線自然語言描述。
   Currently rule-based; wire Gemini for free-form NL factory descriptions.
4. **熱載入補完 Hot-add completeness** —— NL 建廠的新設備目前需重啟才上 Modbus / OPC-UA 共用埠與專屬埠
   (MQTT 即時)。讓 adapters 支援動態加 register / node / port。Make adapters add registers/nodes/ports at runtime.
5. **OPC-UA multi_port** —— 目前 multi_port 只做 Modbus;OPC-UA per-device endpoint 為進階選項(較重)。
6. **更多產業 More templates** —— 半導體製程腔體(particle_count 良率)、電表 / 能源節點(OEE / 能耗題)。
   Semiconductor process chamber, energy meter.
7. **學生面公開頁 Public student pages** —— 公司認領 UI、工單板 student 視圖、公開計分 / OEE 競賽頁。

---

## ⚠ 已知限制 · Known Issues / Limitations

- **熱載入設備 Hot-added devices**:NL 建廠的新設備即時出現在 2D 世界 / 目錄 / OEE / MQTT,但 Modbus /
  OPC-UA 共用埠與專屬埠需重啟 server 才暴露。New devices need a server restart for Modbus/OPC-UA.
- **Historian 易失 Volatile historian**:in-memory 模式每 tag 僅留最後 ~20000 筆且重啟清空;階段二長歷史請用
  資料集產生器或接 DB。Use the dataset generator or a DB for long Stage-2 history.
- **待機 RUL Idle RUL**:two_shift 設備在下班時段不退化,RUL 顯示「—」(未定義),屬正確行為。Correct behaviour.
- **PowerShell + curl 的 JSON**:Windows PowerShell 會弄壞 `curl -d '{json}'`(送出空物件 → 422);發 POST 請用
  student_kit 的 Python 或網頁 UI。PowerShell mangles `curl` JSON bodies — use the Python scripts or web UI for POST.
- **本機埠占用 Local ports**:8000 可能被占用(故 API 用 8077);4840 常被 OPC-UA Local Discovery Server 占(故用 4841)。

---

## 🔭 未來想法 · Future Ideas

- 工單「讀寫控制」進階題:學生寫 register / 呼叫 OPC-UA method 下 reset 把設備拉回。
  Read-write control: students write registers / call OPC-UA methods to reset devices.
- 階段二評分擴充:F1、RUL RMSE、誤報率細化。Richer Stage-2 metrics (F1, RUL RMSE).
- 美術升級:導入 Kenney.nl CC0 等距素材取代 Graphics 幾何。Swap Graphics primitives for Kenney CC0 art.
- 本機 LLM + RAG 故障診斷助手(接 wind-turbine MCP / TAG-Wind 知識庫)。Local LLM + RAG diagnosis assistant.
- 多埠範圍 / OPC-UA 安全模式 / MQTT 帳密 等更貼近真實場域的進階設定。

---

> 本檔隨進度滾動更新。This document is updated as the project progresses.
