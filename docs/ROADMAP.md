# Roadmap · TODO · Known Issues(路線圖 · 待辦 · 已知限制)

> 進度 Progress: **~100%**(P0–P4 + 上線硬化 + 產業庫擴充 + 課堂即時練習 + 學生監控台 + 4D 暖色 UI 重設計 + 3D 動畫精準化與自動驗證)· 更新 Updated: 2026-07-28
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
| **學生自建監控台(範例作品)** | `student_kit/dashboard`(Streamlit)+ `student_kit/dashboard_simple`(純標準庫 `http.server` + 原生 JS,免 Streamlit);共用 `client.py` 資料層,含 **Modbus / OPC-UA / MQTT 三協定 reader** + 統一 `read_live()`;即時監控可切三協定、趨勢 / 統計 / 分析、繳交作業自動批改。設備目錄依設備實際公布協定顯示切換鈕(為 per-device protocol 預留) |
| **課程規劃與概念文件** | 18 週課程規劃([docs/課程規劃_18週.md](課程規劃_18週.md),含分軌作業表 + W12/W13 選作)、**「雲端生產」概念與議題**([docs/雲端生產_概念與議題.md](雲端生產_概念與議題.md):課名斷句、雲製造 vs 數據上雲、ISA-95、Cloud MES,含討論題 + 動手練習)、對外連線部署說明([docs/部署_對外連線.md](部署_對外連線.md)) |
| **4D 暖色 UI 全面重設計** | 依 Claude Design「方案 4D 教學暖色」handoff 全站重繪(**只改視覺,不動 API / telemetry / 資料流**):① 暖色 tokens + Lora / Noto Sans TC / JetBrains Mono 字體 + 全站 UI;② 2D 世界(PixiJS 俯瞰 + 廠內產線)暖色重繪;③ **設備詳情彈窗**(點機台 / 目錄卡 → 放大詳細 Canvas 動畫 + 即時訊號 / 趨勢 / HOLDING / DISCRETE,接真實 telemetry);④ **雙機上下料工作站**(2 CNC + 手臂 2 連桿 IK 在兩機間搬運,含示範廠 c65)。取代先前的深色工業風設計稿 |

| **3D 設備動畫精準化** | 建立**動畫綁定契約**([docs/animation_binding.md](animation_binding.md)):每個會動的部位都必須對應一支具體 tag / setpoint / coil,前端不得重算引擎已算過的物理,做了時間換算就必須在畫面標示倍率。依此重寫全部機種 3D:① 修好 4 支**抓不到的 tag**(空壓機 `tank_pressure`→`outlet_pressure`、風機 `yaw_angle`→`pitch_angle`、電表 `voltage`/`current`→三相 `*_l1/l2/l3`、CNC `machining_pattern` 改讀 setpoint);② CNC 改吃引擎的 `pos_x/y/z` + 真 `cycle_time`(含相位鎖定),手臂改吃完整六軸 `joint_angle_1..6`(取放站由正運動學定位),沖壓改吃 `ram_position`;③ 新增 **`deviceMotion.ts` 資料橋**(狀態正規化 / 退化度 / delta-based 補間 / L3 時間換算)與 **`MachineFx`** 共用視覺語彙(柱燈 / 故障冒煙 / 依 `vibration_rms` 抖動 / 過熱輝光);④ 補上**製程腔體**與**熱處理爐** 3D(11 種 template 全覆蓋);⑤ 燈光 / 環境 / 陰影上移到 Canvas 層級(WebGL context lost 根因);⑥ **全面移除 CDN 相依**(drei `<Environment preset>` 抓 .hdr、`<Text>` 抓字型資料,LAN 無外網會整個 Canvas 崩掉)—— 改本地程序化環境貼圖 + CanvasTexture 文字牌;⑦ dev 預覽頁 `web/preview/models3d.html` + `shot3d.mjs` 自動截圖與 console 錯誤檢查 |

| **動畫正確性自動驗證** | [tests/animation](../tests/animation/README.md):把 `engine.World.step()` 錄下的**真實 telemetry** 逐幀餵進瀏覽器裡真正的 3D 元件,讀回 three.js 場景中機構的**實際世界座標**,與引擎 tag 做線性回歸 + 還原誤差比對(一次抓出接錯 tag / 軸向對調 / 換算比例錯 / 符號反了)。**35 項全數通過,11 種機型全覆蓋**;另有 `verify_scenario.py` 逐廠逐台不抽樣(102 廠 / 205 台)與 `shot3d` / `shotline` 的無 CDN + 無 console error 檢查。三套都接上 CI(`.github/workflows/verify.yml`)。**驗證抓到並修好的真缺陷**:① 手臂 `tcp_x/y/z` 與六軸角度**互相矛盾**(tcp 原本是一條與角度無關的參數式擺動,方位角與 J1 的相關係數 **−0.82** —— 手臂往左轉、回報的末端往右跑;改由 `forward_kinematics()` 算出後為 **+0.999993**);② CNC 相位鎖定漏比 z 軸(刀路自交處會鎖到相反的抬刀 / 下刀相位);③ 鎖定增益非 delta-based(低 fps 機器刀尖固定落後);④ 故障時柱燈**有一半的瞬間讀起來像警告**(severity 拉滿使黃燈恆亮,而紅燈在閃);⑤ CNC 刻字上下鏡像(`pos_y`→世界 Z,而世界 +Z 在畫面上是往下);⑥ 刻痕補點是 frame-rate 相依的(低幀率下字變成散落的點)。另修正 `visualPeriod` 原本會**加速**播放過慢循環的設計錯誤(加速會直接破壞畫面與 `pos_*` 的座標對應) |

| **廠內產線製程佈局** | 廠內視圖不再把設備等距排一列各做各的,改依**製程角色**(產出 / 搬運 / 輸送 / 廠務)排成一條看得懂的線(`web/src/world/processFlow.ts`):相鄰工站邊靠邊、手臂轉 90° 讓**取件點對到上游機台出料口、放件點壓在輸送帶起點**、廠務退到後排不佔主線、地面畫料道與方向箭頭、畫面與說明卡寫出「製程流向:射出成型 → 手臂取放 → 輸送帶出料」(由實際設備推出來)。CNC 在產線視圖套鈑金外殼,裸露刀路留給詳情頁。各機種佔地半寬由 `preview/measure.mjs` 從真實場景量回來,不是估的。**⚠ 這是空間上的對位,不是引擎層的物料交接** —— 各設備節拍仍各自獨立 |

| **場景產生器化** | `scenarios/*.yaml` 改由 `scenarios/scripts/gen_*.py` 產生(規則寫死、可重現):課堂版 65 廠 / 133 設備 / 46 種組合,示範版 37 廠 / 72 設備 / 32 種組合,11 種 template 兩份都全覆蓋。設備組合符合產業工程邏輯而非隨機湊。**公司名改為虛構**(合成資料掛真實廠商名等於對真實企業的不實陳述);示範版廠名改成「{產品線}廠({老師}負責)」,產生器加了廠名唯一性斷言 |

兩個教學階段皆可開課。Both teaching stages are classroom-ready.

---

## ⏳ 待辦 · TODO(依優先序 by priority)

### 1. 每週凍結資料包 Weekly frozen data packs ★最高優先

**問題**:`scenarios/course_weeks.yaml` 的每週情境是**套用到正在跑的引擎**上的
(教師控制台按「套用第 N 週情境」)。這代表平台必須持續開著才有當週資料 —— 對一學期
18 週的課不現實(斷電、重啟、學期中改程式都會影響)。

**方向**:把「每週情境」離線**預先產成凍結的資料包**,平台在不在線都不影響已發教材。
零件其實都有了,缺的是把它們串起來的那一段:

| 已有 | 缺 |
|------|-----|
| `tools/generate_dataset.py`(`--inject` / `--seed` / `--degradation-scale` / `--devices`) | 讀 `course_weeks.yaml` 的 glue —— 產生器目前只吃手打的 `--inject` |
| `manifest.json` 記 seed + engine commit(可溯源、可重現) | 每週 × 每學號的批次產出與打包 |
| `tools/make_assignment.py` / `grade_assignment.py`(每學號私有測試集 + 自動評分) | 週次 ↔ 作業 ↔ 練習題的綁定 |
| `scenarios/classroom_exercises.yaml`(課堂即時練習題庫) | 練習題與「當週資料包」對應(目前練習是對線上活廠出的) |

**另外兩個缺口**:
- `course_weeks.yaml` 只定義了 **8 週**(W4–W8、W10、W11、W13),18 週規劃裡其餘上課週沒有條件。
- **產出後要驗**:每份資料包都該自動檢查「這週要學生找的東西真的找得到」
  (注入的故障在觀測窗內有沒有顯著到可偵測、標籤分佈會不會極端不平衡)。
  沒驗就發下去,可能整週的題目是無解的。作法可比照 [ML基準實證](ML基準實證.md)。

### 2. 其餘 template 的資料自洽性掃描 Cross-tag consistency sweep

手臂的 `tcp` 缺陷(與六軸角度互相矛盾,相關係數 −0.82)是靠一個**物理不變量**抓到的。
其餘 10 種 template 應該也有可查的不變量,例如:

- 電表:`active_power ≈ √3 × V × I × power_factor`
- 空壓機:`flow` 與 `motor_current` 的關係(濾網阻塞時兩者應脫鉤 —— 這正是要教的)
- CNC:`part_count` 的增速應與 `cycle_time` 一致
- 熱處理爐:`heating_power` 與 `furnace_temp` 對 setpoint 的追隨關係

成本低、風險小,而且如果真的還有「兩套互相矛盾的資料」,那是**會直接教錯學生**的問題,
優先度高於任何視覺改善。作法比照 `verify_scenario.py::check_kinematics`。

### 3. 引擎層的物料流 Material flow in the engine

目前廠內產線是**空間上的對位**:手臂的取件點對到上游機台的出料口,但兩者節拍各自獨立,
不會出現「射出機一頂出、手臂就伸手」。要真連動得在引擎加產線 / 工件傳遞的概念。

教學價值高(學生能學到節拍不匹配造成的堆料 / 斷料、瓶頸分析),但這是**引擎的架構性改動**,
會連帶影響 OEE 與件數統計。建議等課程流程確定需要再做。

### 4. 對外接入 External access

Cloudflare Tunnel(HTTP)+ Tailscale(原生協定),ACL 限校內 / 學生群組。
*暫緩,待能存取校內 5090 主機。* 見 [docs/部署_對外連線.md](部署_對外連線.md);骨架見 `deploy/cloudflared/`。

### 5. 其他

- **生產管理 KPI 自動批改** —— 準交率 / WIP / 前置時間都能從 `/api/orders` 自算,但尚未像其他作業
  一樣自動批改。見 [雲端生產_概念與議題](雲端生產_概念與議題.md) §7。
- **字體離線化** —— HTML 以 Google Fonts 載入 Lora / Noto Sans TC / JetBrains Mono,LAN 無外網會回退
  系統字體(版面 / 顏色不受影響)。**3D 層已完全不依賴外網**,此項只剩 HTML 字體。
- **動畫綁定契約落實到俯瞰層** —— [animation_binding.md](animation_binding.md) 目前規範廠內 3D;
  PixiJS 俯瞰層(公司量體 / 燈號 / 煙囪)仍是純裝飾動畫,未來可比照納管。
- **OPC-UA multi_port** —— 目前 multi_port 只做 Modbus;OPC-UA per-device endpoint 為進階選項(較重)。
- **更多產業 template** —— 11 種已涵蓋主要教學需求;後續可補廢水 / 環控、鑄造、噴塗。

> 已完成而從待辦移除:真 LLM 建廠、熱載入補完、產業庫擴充(10→11 種)。

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
- **示範廠 c65 Demo company**:`scenarios/class_park.yaml` 有一間額外的「上下料示範廠」(c65:2 CNC + 手臂)。
  廠內視圖改 3D 後,原本的 2D「雙機上下料工作站」畫法已移除,c65 現在就是一般的多機台產線;
  上下料的搬運演示改由 **AGV 詳情場景**(兩個停靠站各有一支上下料手臂,節拍對齊引擎的 6 秒停靠)呈現。
  c65 屬**教師展示用**,不需要時可刪除該公司。Extra teacher-demo company; remove it if not needed.
- **4D 字體 Fonts**:見上 TODO §5 —— LAN 無外網,HTML 會回退系統字體;**3D 層不受影響**(不依賴外網)。
- **動畫的時間換算 Animation time scaling**:場景預設 `time_multiplier: 120`,多數設備的真實循環在牆鐘上
  只有零點幾秒,直接畫會變閃爍。因此週期性動作與高轉速件會夾在可讀區間並**在畫面標出倍率**
  (例:「動畫慢放 ×8」「轉速視覺 ×1/10667」)。**數值一律以點位為準,畫面節拍是換算後的**。
  這時 1 Hz 的 `pos_*` / `ram_position` 已低於該循環的 Nyquist,因此不做相位鎖定;
  倍率≈1(慢速 sim)時才會把畫面相位鎖回遙測。見 [docs/animation_binding.md](animation_binding.md) §1 鐵則三。
- **每週情境需要活廠 Weekly scenarios need a live engine**:`scenarios/course_weeks.yaml` 的每週條件是
  由教師控制台**套用到正在跑的引擎**上,平台沒開就沒有當週資料。離線作業目前走另一條路
  (`tools/generate_dataset.py` 產凍結 CSV)。把兩者串起來、預先產出整學期的資料包是 TODO §1。
  Weekly conditions are applied to the running engine; offline assignments use frozen CSVs instead.
- **3D 層禁用 CDN 資源 No CDN in the 3D layer**:drei 的 `<Environment preset>`(抓 .hdr)與 `<Text>`
  (troika 抓字型資料,中文必抓)在無外網時會讓整個 Canvas 拋錯 / 文字消失。專案已改用本地程序化環境貼圖與
  CanvasTexture 文字牌;**新增 3D 元件時不要把這兩個 API 加回來**,`node preview/shot3d.mjs` 會攔到。

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
