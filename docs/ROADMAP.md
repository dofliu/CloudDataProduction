# Roadmap · TODO · Known Issues(路線圖 · 待辦 · 已知限制)

> 進度 Progress: **~100%**(P0–P4 + 上線硬化 + 產業庫擴充 + 課堂即時練習 + 學生監控台 + 4D 暖色 UI 重設計 + 3D 動畫精準化與自動驗證 + 學生可寫輸入控制 + 引擎產線物料流 + 學生決策層 / 九關 / 課堂即時互動 / 跨公司供應鏈 + **離線教材資料包**)· 更新 Updated: 2026-08-21
> 建置順序原始規劃見 [07-roadmap.md](07-roadmap.md)(P0–P4 已全數完成);本檔為現況與後續。
>
> **現況一句話**:兩個教學階段都可開課;平台在線(活廠)與離線(凍結資料包)兩條教材路徑都通了。
> **下一階段(2026-08-21 定調)**:設備動畫告一段落,重心回到生產數據本身 —— 見 TODO 第一節「資料鏈補完」與 [docs/資料盤點_生產數據完整性.md](資料盤點_生產數據完整性.md)。
> CI 綠燈涵蓋 場景健全性(109 廠 / 259 台逐廠逐台)+ 10 支 Python 契約測試 + 前端建置 + 動畫一致性 48 項。

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

| **動畫正確性自動驗證** | [tests/animation](../tests/animation/README.md):把 `engine.World.step()` 錄下的**真實 telemetry** 逐幀餵進瀏覽器裡真正的 3D 元件,讀回 three.js 場景中機構的**實際世界座標**,與引擎 tag 做線性回歸 + 還原誤差比對(一次抓出接錯 tag / 軸向對調 / 換算比例錯 / 符號反了)。**35 項全數通過,11 種機型全覆蓋**;另有 `verify_scenario.py` 逐廠逐台不抽樣(102 廠 / 239 台)與 `shot3d` / `shotline` 的無 CDN + 無 console error 檢查。三套都接上 CI(`.github/workflows/verify.yml`)。**驗證抓到並修好的真缺陷**:① 手臂 `tcp_x/y/z` 與六軸角度**互相矛盾**(tcp 原本是一條與角度無關的參數式擺動,方位角與 J1 的相關係數 **−0.82** —— 手臂往左轉、回報的末端往右跑;改由 `forward_kinematics()` 算出後為 **+0.999993**);② CNC 相位鎖定漏比 z 軸(刀路自交處會鎖到相反的抬刀 / 下刀相位);③ 鎖定增益非 delta-based(低 fps 機器刀尖固定落後);④ 故障時柱燈**有一半的瞬間讀起來像警告**(severity 拉滿使黃燈恆亮,而紅燈在閃);⑤ CNC 刻字上下鏡像(`pos_y`→世界 Z,而世界 +Z 在畫面上是往下);⑥ 刻痕補點是 frame-rate 相依的(低幀率下字變成散落的點)。另修正 `visualPeriod` 原本會**加速**播放過慢循環的設計錯誤(加速會直接破壞畫面與 `pos_*` 的座標對應) |

| **故障語意統一(引擎)** | 設備進入 `state=fault` 之後**仍持續回報運轉** —— CNC 的 `spindle_speed` 還是 8000 rpm、`pos_x` 繼續走刀路、`part_count` 繼續增加。學生用 Modbus 讀會看到「故障中的機台正在全速加工」,是同一份 snapshot 裡兩套互相矛盾的資料(違反鐵則二)。根因是**模板之間不一致**:11 個 template 只有 6 個在 `pre_step` 裡寫 `op["running"] and not device._fault_latched`,其餘 5 個(cnc / air_compressor / conveyor / energy_meter / heat_treat_furnace)沒寫。改成在 `engine/device.py::step` **統一擋下**(故障閂鎖 → 運轉點強制歸零),新增模板不必再記得這件事;另在元件失效的**同一拍**、driver 執行前再擋一次,否則「故障當拍」那一筆仍會自相矛盾。OEE 不受影響(`_accumulate_oee` 先看 `_fault_latched` 才看 `op["running"]`,故障仍計為可用率損失)。**這個缺陷是每日模擬測試在排程之前就抓到的** |

| **廠內產線製程佈局** | 廠內視圖不再把設備等距排一列各做各的,改依**製程角色**(產出 / 搬運 / 輸送 / 廠務)排成一條看得懂的線(`web/src/world/processFlow.ts`):相鄰工站邊靠邊、手臂轉 90° 讓**取件點對到上游機台出料口、放件點壓在輸送帶起點**、廠務退到後排不佔主線、地面畫料道與方向箭頭、畫面與說明卡寫出「製程流向:射出成型 → 手臂取放 → 輸送帶出料」(由實際設備推出來)。CNC 在產線視圖套鈑金外殼,裸露刀路留給詳情頁。各機種佔地半寬由 `preview/measure.mjs` 從真實場景量回來,不是估的。**⚠ 這是空間上的對位,不是引擎層的物料交接** —— 各設備節拍仍各自獨立 |

| **場景產生器化** | `scenarios/*.yaml` 改由 `scenarios/scripts/gen_*.py` 產生(規則寫死、可重現):課堂版 **65 廠 / 154 設備 / 42 種組合 / 12 條產線 / 32 條供應鏈**,示範版 **37 廠 / 85 設備 / 29 種組合 / 6 條產線**,11 種 template 兩份都全覆蓋(數字以 `verify_scenario.py` 實測為準)。設備組合符合產業工程邏輯而非隨機湊。**公司名改為虛構**(合成資料掛真實廠商名等於對真實企業的不實陳述);示範版廠名改成「{產品線}廠({老師}負責)」,產生器加了廠名唯一性斷言 |

| **學生可寫輸入控制(2026-07-30)** | ① **CNC 刻字**:pattern 0 從寫死刻 NCUT 升級為任意文字 —— 筆畫字型 `engine/templates/_stroke_font.py`(A–Z / 0–9 / `-`,引擎與前端逐點同一套),由 `engrave_char_1..8` setpoints(ASCII,reg 102..109)驅動,學生逐格 FC06 或 REST `/engrave_text` 一次寫整串,超行程等比縮小、預設 NCUT 零回歸。② **手臂取放兩點可指定**:`pick_x/pick_y/place_x/place_y` setpoints(±1250 mm),引擎逆運動學解回六軸 keyframes,`tcp_x/y/z` 誠實反映、「方位角 ≡ J1」不變量保持;**Modbus 轉接層補 int16 二補數**(負座標可寫、反射一致)。③ 設定點寫入控件抽成共用元件並**搬進詳情彈窗**(彈窗蓋住側欄,先前可寫欄位實際上點不到)。④ `tests/test_input_control.py` 掛 CI:預設零回歸、切削點對筆畫偏距 0、IK↔FK 往返 1e-13 mm、tcp 抵達指定點 <2 mm |

| **引擎產線物料流(2026-07-30)** | 原 TODO「Material flow in the engine」完成:公司 YAML 宣告 `line:`(站序)後工件在引擎內**真實傳遞**(`engine/line.py`)。① 上游完工進出料緩衝(滿 3 件上游停)、手臂**事件驅動**取放(`cycle_count` = 實際搬運件數,無料在取件點上方待命、電流/振動掉回待機值)、下游無料真的停 —— 餓料/滿料計 no-demand 不罰 OEE 可用率;完工偵測直接讀各 template 累積量 tag(帳 = 學生 Modbus 讀值,不做兩套);大 dt 下搬運配額制(tick 粒度不成瓶頸)。② **終站輸送帶為真站**:工件上帶、走完帶長(8 sim 秒)才出貨,**空帶待機不空轉**(belt_speed→0)。③ 可觀測:FC04 `line_in_buffer`/`line_out_buffer`/`line_on_belt` 進目錄,WS snapshot 加 `lines` 帳。④ 前端:緩衝方塊擺在 processFlow 對位的**手臂實際取放點**、輸送帶只畫帳上件數、產線統計列;**「🎬 慢速觀察 ×2」教師鈕**(×120 下取放僅 0.07 牆鐘秒,物理上不可見 —— 慢速下全程真實資料呈現)。⑤ 兩份場景由產生器接線(課堂 12 條 / 示範 6 條)、單機工廠全數補上搭配設備、公司 intro 補產線流向;**建廠(規則式)升級支援多型別描述**(「2 台 CNC 和 1 支手臂」)且產出自動接線。⑥ `tests/test_line_flow.py` 掛 CI:守恆(完工=待取+在手+已搬;出貨+帶上≤已搬≤完工)、餓料/滿料/空帶誠實停機 |

| **學生決策層(2026-07-31)** | 學生的操作開始**有代價**,做對做錯的差別由引擎誠實反映而不是改分數改出來的([docs/決策與後果.md](決策與後果.md)):① **工單結案要先診斷再選處置動作**(`engine/repair.py` 維修手冊:每種故障對應哪個動作、在數據上長什麼樣)—— 選錯照樣扣工時、設備**不會**修好、症狀繼續;一次故障只開一張單。② **預防保養停機換壽命** —— 保養要停機、停機計入可用率損失,做太勤 OEE 掉、不做就等故障。③ **學生託管告警規則**(`api/alarm_rules.py`)—— 學生把門檻 / 持續時間交給平台代跑,平台對 ground-truth 算 **F1 與 lead time**:規則太敏感就誤報、太鈍就漏報,兩邊都有分數代價。CI:`tests/test_repair_actions.py` / `tests/test_alarm_rules.py` |
| **資料的一生九關 + 全班進度(2026-07-31)** | 把整學期的能力拆成九關(接得上 → 讀得懂 → 存得下 → 看得見 → 找得出 → 說得準 → 修得好 → 防得住 → 講得出),定義在 `scenarios/levels.yaml`(**改關卡改 YAML,`api/levels.py` 不寫死**)。判定**現查平台事實**不快取(有沒有真的讀過協定、開過工單、上傳過預測…),人工勾選只開放無法自動判定的關且留痕;全班 **N×9 進度熱力圖**與**瓶頸關**算法讓老師一眼看出卡在哪。另加**協定端存取軌跡**(`adapters/access_log.py`:哪台被讀幾次 / 多久打一次 —— 誠實標示拿不到連線者身分)。CI:`tests/test_levels.py`。見 [docs/關卡與進度.md](關卡與進度.md) |
| **課堂即時互動升級(2026-07-31)** | 佈題**倒數截止**(截止後不收卷)、**首答留名**(第一個答對的人上榜)、**全班投票**(`api/polls.py` + `scenarios/classroom_polls.yaml`)—— 投票收票後**照多數決真的去動引擎**(全班決定停哪台、注入什麼),不是投完就算了。CI:`tests/test_classroom_live.py`。見 [docs/課堂即時練習.md](課堂即時練習.md) |
| **跨公司供應鏈(2026-07-31)** | `engine/supply.py`:A 公司的出貨 = B 公司的進料,課堂版接了 **32 條**。上游停 → 下游**餓料**、下游滿 → 上游**阻塞**(皆計 no-demand,不冤枉罰可用率);**自給率**量化「單一供應商風險」,可出「誰是全園區的單點故障」這類題。CI:`tests/test_supply_chain.py`(守恆 + 餓料/阻塞傳播)。見 [docs/供應鏈連動.md](供應鏈連動.md)。同批修掉「九關的『產生』關永遠不會過」(讀錯設備清單來源) |
| **課程教材端對齊(2026-08-01)** | ① `scenarios/course_weeks.yaml` 的週次**對齊《18週教學大綱 v2.1》**(現有 8 週:W4 / W6–W8 / W10–W12 / W14)。② **correlation 批改改時間戳對齊** —— 原本按列序比對,學生取樣率不同就會算出假的相關係數;改成對 `sim_t` 對齊後再算。③ **production 生產管理 KPI 自動批改**:`metric: on_time_rate`(準交率,自當週資料窗起算的完工單)與 `wip`(未完成工單數),支援 device / company 兩種範圍,真值與 `/api/orders` 公開資料一致。CI:`tests/test_course_grading.py` |
| **無產品工廠重設計(2026-08-13)** | 使用者指出「兩台空壓機是要幹嘛?完全沒有任何產品」—— 純服務型「工廠」不合理。經確認四個決定:① **廠務動力整個產業拿掉**,名額換成**切削刀具製造**(CNC 開刃 → 熱處理爐淬火 / 腔體 PVD 鍍膜,台灣強項產業;配方設備數與舊廠務逐槽相同 → 其他公司 device id 零位移),4 間公司改名(宏泰刀具 / 華通切削 / 大成刀具 / 清鋒刀具)。② **智慧物流改物流設備製造廠**:加 CNC 當 producer,產品 = AGV 整機 / 輸送分揀系統 / 智慧輸送模組 —— 自家設備就是出貨前試跑的產品。③ **自動化系統的純手臂配方用系統整合商語意講通**(設備不動):產品 = 整合工作站(賣設備,同工具機廠賣機器的邏輯),線上跑的是出貨前節拍驗證。④ **風電保留**:發電量(kWh)是可計量的產品。變動侷限在 16 間重設計廠(課堂 8 + 示範 8),其餘公司 id / 設備分毫不動;供應鏈池擴大為 12 條鏈(刀具 / 物流設備廠有 CNC 而入鏈)。全部 CI 綠 |
| **產品線合理性(2026-08-13)** | 使用者指定方向:「滑到 / 點選工廠要看到主要產品,而且廠內設備要支撐那個產品」。顯示面本已存在(俯瞰 hover tooltip 與廠內資訊卡都有主要產品 + intro),缺的是**細粒度合理性**,補兩件:① **產品綁定配方** —— 產品與設備配方原本各自獨立輪轉(「工具機滾珠螺桿」可能配到沒有熱處理爐的廠);改成每個配方列出「這組設備做得出來」的產品,產生器從該配方自己的清單選(51/65 + 20/37 間公司的產品因此換成與設備相符的)。**devices 序列刻意不動**:兩份場景的設備 / 產線 / ID 完全不變,週包、作業種子、動畫錄製零影響。② **供應鏈語意化** —— 原本按公司序號硬串、進料名直接用上游整個主力產品名(「手機鏡頭模組」餵給沖壓廠當原料);改成鏈內依工序階段排序(成形 → 機械加工 → 精整/製程,成員不變、32 段中 15 段方向重排),進料改「上游產業中間料(括注主力產品)」語彙,如「沖壓半成品(散熱片沖壓)」。CI:場景健全性 / 供應鏈 / 產線 / 週包 / 課程批改全綠。**續(同日 v2,使用者續指定)**:③ 49 個配方全部補**製程故事**進 intro —— 說明「每台設備替這個產品做哪道工序」(例:手機鏡頭模組 = 鏡筒鏡座在 CNC 精密切削、再進腔體鍍增透膜),取代乾巴巴的設備清單;光學配方 1 的設備序轉正(先 CNC 加工、再進腔鍍膜),製程流向橫幅與故事一致(僅 c07/c60/t11-f1/t11-f4 四間腔體↔CNC 對調)。④ 俯瞰 hover tooltip 與廠內資訊卡顯示**供應鏈上下游**(進料來自誰、出貨給誰,缺料 / 阻塞即時標記;資料自 WS snapshot 的 supply,前端不自存) |
| **鑄造 / 鍛造上游 5 機種(2026-08-21)** | 使用者提供的「手工具製程主要流程圖」前段(原料與成形)在型別庫裡是空的 —— 鑄造與鍛造是台灣手工具業的核心製程。產業型別庫 15 → **20 種**:**熔煉爐**(1450 °C 熔湯、每 72 秒傾轉出一籃;爐襯磨蝕 → 爐殼外壁溫升 —— 現場最直接的「該重砌爐襯」徵候)、**壓鑄機**(模具熱疲勞 → 縮孔、真空密封劣化 → 氣孔,**兩條品質線分別對應兩種維修**,只看不良率分不出來)、**感應加熱爐**(出料溫度不足 → 鍛出摺疊裂紋;耦合劣化不只讓均值掉、也讓分散變大)、**鍛造壓機**(欠肉跟鍛模走、壓入氧化皮跟除鱗壓力走,對症是清噴嘴不是換模具)、**毛胚整修機**(刀口鈍化時**切斷力先升、殘毛刺後升** —— 教「哪個指標先動」)。維修手冊新增 `reline_refractory`(重砌爐襯 24 h)與 `clear_blockage`(清除堆積 2 h)。場景尾端附加課堂版 c70/c71 與示範版 x01-f4/f5,各一條 **5 站產線**(熔煉→手臂→壓鑄→手臂→輸送帶 / 加熱→手臂→鍛造→手臂→切邊);`derive_line` 擴充成多站交錯,兩站的舊配方結果完全相同。既有 device id / unit_id / 供應鏈 41 段**零位移**。**刻意不接供應鏈**:引擎供應鏈是 1 件換 1 件,但一籃熔湯連鑄可出多支棒料,硬接會讓鍛造廠一天餓料 4.5 小時 —— 那是模型單位的假象,不是工廠事實(理由寫在產生器裡)|
| **資料鏈落地(2026-08-21)** | 盤點指出「訊號層完整、資料層不完整」後的 P1 補完([docs/資料盤點_生產數據完整性.md](資料盤點_生產數據完整性.md)):① **停機原因碼** —— 每台多一支 `stop_reason_code`(9 種碼:餓料 / 滿料 / 無工單 / 班外 / 教師停機 / 保養 / 故障 / 空閒待命),事件也帶 `stop_reason`;先前這些全落成同一個 `idle`,停機 Pareto 做不出來。碼表進 `/api/catalog` 的 `enums`。原因碼與實際狀態一致由 CI 守著。② **事件表落地** —— `_detect_events()` 的 fault / state_change 多接一個訂閱者寫進 historian 的 `events` 表,開 `GET /api/history/events`(可依設備 / 公司 / 型別 / 停機原因篩)→ MTBF / MTTR / 停機 Pareto 可算。**不帶故障元件名**(那是 ground-truth)。③ **逐件生產紀錄 + 良/不良計數** —— producer 的累積量每進一位 = 完成一件,當場由 `quality_fn` 判良/不良並產一筆帶序號的明細(`production` 表,2 天保留)+ 每小時彙總(`production_hourly`,永久);每台 producer 多 `good_count` / `reject_count`,**產出 = 良 + 不良**由 CI 守著。判良呼叫的是**同一支訊號 driver**(毛邊率 / 飛濺率 / 掛渣率 / 封口不良率…)由健康度重算的乾淨值,不是另外亂數、也不吃感測器故障層。CNC 補 `dimension_deviation` / `surface_roughness`、射出補 `short_shot_rate` / `part_weight_deviation`(健康機台仍有 0.4~0.5% 隨機不良底線 —— 真工廠沒有 100.00% 良率)。品質訊號覆蓋 39 → **79/165 台**,狀態域 **165/165 台**。**工件序號不進 Modbus**(使用者決定:真工廠序號在 MES 不在 PLC);新 tag 一律附加在既有 tag 之後,既有位址零位移,學生程式零回歸。CI:`tests/test_production_records.py` |
| **設備動畫圖鑑(2026-08-20)** | 全 15 種機型的圖文對照文件([docs/設備動畫圖鑑.md](設備動畫圖鑑.md)):每台一組「健康 ↔ 劣化」實際渲染截圖(CNC 另有故障閂鎖、沖壓與風機另有教師停機態,共 32 張)+ 動畫綁定表(視覺元素 → 引擎欄位 → L1/L2/L3)+ 退化線與徵兆,外加 8 種產線佈局視圖。由 `tools/make_device_atlas.py` 從 `web/preview` 的真實渲染產生(**不手寫**,截圖零 console error、圖檔轉 webp 共 0.57 MB),要調內容改產生器再重跑。用途:開學介紹園區有哪些設備與各自怎麼壞、學生查詢用設備圖鑑、動畫改動後的視覺驗收留底 |
| **新產業四機種(2026-08-19)** | 產業型別庫 11 → **15 種**:**AOI 光學檢測站**(蛇形掃描龍門;鏡頭污染 / 光源衰減 → 誤判率 —— 「量測系統本身劣化」教學題)、**焊接機器人工作站**(電弧沿焊道;送絲輪磨損 → 電流波動、噴嘴堵 → 飛濺,對症是清潔不是換件)、**雷射切割機**(矩形輪廓;保護鏡片污損 → 鏡溫升 + 降速,冷卻迴路劣化 → 降額)、**包裝機**(產線終站;封口加熱器老化 → 溫度到不了設定點,與熱處理爐同款語彙不同尺度)。每種都是完整垂直切片:引擎物理(隱藏健康 + 相關訊號)、維修手冊對症、產線計數(四種都可入線,包裝機為 sink)、NL 建廠關鍵字、2D sprite + 3D 動畫(位置 tag 全 L1,動畫綁定表 §4.14–4.17)、**每種一條物理不變量進 CI**、動畫回歸驗證 +10 項(48 項全過,R²=1.00000)。場景以**尾端附加**接入(課堂 c66–c69 自成一條「雷切→焊接→檢測→包裝」供應鏈、示範 x01-f1..f3)—— 既有公司 device id / unit_id / 供應鏈 38 段**零位移**,週包種子與動畫錄製不受影響。**順手修掉的真缺陷**:①(引擎)tick 粒度下產線 mid/sink 站一拍可完成多件、入料卻只消耗帳上那幾件 —— AOI 檢數會超過實際送達(工件憑空出現);gate 改「料要夠本拍完成量才開工」(need = ceil(dt/節拍),dt ≤ 節拍時與原行為完全等價)。②(週包)被產線餵料的站退化只在運轉時累積、稼動被上游卡住,注入的故障在觀測窗內物理上長不到可偵測量 —— 產生器不再挑 mid/sink 當注入對象(不出無解的題)。③(NL 建廠)同義詞重複命中會多建設備(「CNC 加工中心」= cnc + 加工中心 → 2 台);同 template 相鄰命中間無分隔詞即合併 |
| **整合建廠自動上線 commissioning(2026-08-19)** | 「指定 A+B+C → 新工廠自動上線」一條龍(`api/commissioning.py`):① `POST /api/factory/compose`(教師)吃結構化設備組合(順序 = 製程順序),白名單驗證 → 自動配 device id / unit_id / OPC-UA folder / MQTT topic → producer+手臂+producer/輸送帶**自動接產線物料流** → 熱上線免重啟;② **點位表自動產出**:逐台全點位(tag / setpoint / coil / DI / IR 的位址、FC、型別、存取權)+ 連線資訊,JSON / CSV(Excel 開不亂碼)/ Markdown 連線指引三種格式可下載(`GET /api/commissioning/{cid}`,公開唯讀,不含 ground-truth);③ **試連自測**:上線後真的用三協定 client 連回 loopback 逐台讀值 —— adapter 是下一拍廣播才掛上,自測輪詢到全通或超過一個廣播週期,通不通誠實回報(實測 Modbus/OPC-UA/MQTT 3/3/3);④ 教師控制台「🧩 整合建廠」卡(勾選組合 → 一鍵上線 → 點位表下載連結);⑤ 規則式 NL 建廠與 compose 共用同一套白名單 / 配置(`compose_company`)。CI:`tests/test_commissioning.py`(白名單 / 熱上線配址 / 下游守恆 / 點位表不洩答案 / REST 401·422·404) |
| **產線層 KPI + 產線視圖空間對位修正(2026-08-04)** | ① **T3 線層 KPI**:`engine/line.py::kpi()` 從帳上與節拍 tag 自算 WIP / 瓶頸站 / 線平衡率 / 各站利用率 / 出貨速率(不另存狀態,隨 `snapshot.lines` 流到 WS 與 API),前端產線統計列顯示,CI 驗「正常流動」與「塞住」兩態的帳務自洽。② **「設備沒有在對的位置上動作」根修**(使用者回報):(a) 佈局改用**非對稱佔地邊界** `EXTENT_X`(measure.mjs 新量測「相對原點的左右延伸」)—— 射出機原點偏心 1.1 單位,對稱 halfW 讓整台凸出料道、取件箭頭飄在走道上;爐 / 風機同理。(b) **AGV compact 模式只平移沒縮比例**,車體照 20×14 m 原路線在產線裡滿場開、直接穿過別台機器 —— 改路線縮尺 0.25、地上畫縮小巡迴標線與站點(空間版「換算標倍率」,契約 §1),並新增 `?line=agv` 驗收配方。(c) 手臂伸入深度 1.0→0.4:夾爪停在出料口口沿,前臂不再穿過 CNC 鈑金 / 沖壓機架。動畫 38 項驗證全過、無 console error |
| **課程 18 週補滿 + 教材綁定(2026-08-04)** | `course_weeks.yaml` 從 8 週補滿 **18 週全定義**(與使用者確認過的教學決定:W1/W2 乾淨開場、停課週 W3/W5/W16/W17 與 W13/W18 明確 `keep` 且不設 order_density —— 教師誤按套用也不會動到條件、W5 尤其保護整合②的乾淨基線、W9 期中 clear、W15 期末啟動 clear+high)。**週次 ↔ 作業 ↔ 練習題對應表**:每週新增 `submissions:`(自動批改 type)與 `exercises:`(課堂練習 id)綁定欄位,凍結包與活廠共用同一張表;CI 驗證綁定指到的 id / type 真的存在(23 筆)。**統一學號種子表** `tools/course_seed.py`:`make_assignment.py` 與 `make_week_packs.py --student` 同源推導(sha256 公式與既有作業逐位相同,已發答案金鑰不受影響),同一學號在作業與週包之間可對上、可稽核。`make_week_packs.py` 一次產完整學期 18 週且產後驗證全過 |
| **跨 tag 不變量掃描(2026-08-04)** | `verify_scenario.py` 新增 `check_tag_invariants()`:**11 種 template 每種至少一條物理不變量**逐廠逐台進 CI(電表三相功率自洽 + 電能核帳、空壓機 flow↔電流負載耦合、CNC 電流隨負載 + 計件核帳、熱處理爐能耗核帳、沖壓噸位↔滑塊同相 + 行程核帳、風機功率曲線 + 發電核帳、AGV 不瞬移 + SOC 記帳方向、腔體腔壓自洽 + 計片核帳、射出計模核帳、輸送帶停帶不出貨主動探針;手臂運動學為既有檢查)。取樣設計:離散推進逐拍精確核帳、dt 帶小數破解行程相位 aliasing、8 小時窗讓班表負載有可觀變化;容忍值全部寫了理由(雜訊 3σ~5σ + 窗內退化包絡),不是湊的。**抓到並修好的真缺陷**:沖壓機 `tonnage` 尖峰原用 `\|sin ph\|` 落在**行程中點**而非滑塊下死點 —— 學生畫 ram/tonnage 相圖會得出「離下死點越遠力越大」的錯誤物理;改為與 `ram_position` 同相(尖峰在下死點)。另確立兩條驗證方法論:continuous 班表負載近乎常數,「健康時正相關」的統計檢定會被濾網緩堵主導出 r≈−0.3(誠實物理),改逐拍函數檢定;故障閂鎖發生在該拍訊號算完之後,轉換拍 tag/state 天生一拍歪斜,零值斷言需連續兩拍非運轉 |
| **離線教材資料包(2026-08-01)** | 平台不在線也能上課、已發教材不受重啟 / 改程式影響:① **離線備援包** `tools/make_offline_pack.py`(W4 Plan B)—— 11 種產業各一台、7 sim 天乾淨基線,每台 CSV/JSON + `catalog.json`(離線也能教「查規格書」)+ manifest(seed / engine commit 可溯源)。② **每週凍結資料包** `tools/make_week_packs.py` —— 讀 `course_weeks.yaml` 逐週預產:clear 週乾淨基線、注入週**半數注入半數留乾淨對照**、`keep` 週沿用前一定義週;**產後驗證**(設備注入要健康度顯著下降 ≥0.10、感測器注入要有可偵測趨勢 t≥6、clear 週零故障,**驗不過拒產**——沒驗就發下去可能整週的題目是無解的);學生包**不含 ground-truth**,教師答案卷另存 `packs/answers/`;以學號當 `--seed` 即每人不同資料。CI:`tests/test_week_packs.py` |

兩個教學階段皆可開課。Both teaching stages are classroom-ready.

---

## ⏳ 待辦 · TODO(依優先序 by priority)

> **給排程 / 自動化的可執行版本在 [`.claude/NEXT_TASKS.yaml`](../.claude/NEXT_TASKS.yaml)** ——
> 同一份優先序,但每項多了自主程度(自己做 / 先問)、完成定義、驗證指令與涉及檔案。
> 本節是**敘事版**(為什麼要做);兩邊出入時以本節為準,並回頭修佇列。

### ★ 下一階段:資料鏈補完 Data chain(2026-08-21 使用者定調)

**設備動畫與機型擴充到此告一段落。** 15 種機型、圖鑑、L1/L2/L3 綁定契約與 48 項自動驗證都在
(見 Done 表與 [docs/設備動畫圖鑑.md](設備動畫圖鑑.md));除非教學上真的需要新機型,不再往這條線加東西。
課程要教的是**雲端生產數據** —— 重心回到「設備吐出來的訊號」「設備之間的連結」,
以及一個更根本的問題:**這套系統真的產得出一座工廠 / 工業區需要的資料嗎?**

實測盤點在 [docs/資料盤點_生產數據完整性.md](資料盤點_生產數據完整性.md)(數字由
`tools/audit_data_coverage.py` 產生)。結論一句話:**訊號層很完整,資料層不完整。**
165 台每 5 秒吐 1872 個數值點、三協定都讀得到、歷史撈得回來;但「一件產品從投料到出貨
發生過什麼」這條鏈只存在於即時視圖,沒有落地成可查詢的資料。最刺眼的三格:

- **品質只有 39/165 台有訊號**,而且是「率」不是「良/不良計數」—— 佔園區 24% 的 CNC(31 台)
  與射出成型(9 台)完全沒有品質資料。學生連 OEE 的良率都算不出來(可用率、表現都推得出來)。
- **停機原因分不出來**:餓料、滿料、無工單、班外全落成同一個 `idle`;故障只知道 `fault`,
  不知道是哪個元件。停機 Pareto、六大損失這類最基本的生產分析做不了。
- **事件與物料流沒有歷史**:`_detect_events()` 的 fault / state_change 只廣播給工單 / 預測 /
  告警評分,沒寫進 historian;`lines` / `supply` / 完工工單(每台只留最近 8 張)同理。
  MTBF、WIP 曲線、供應中斷影響分析都沒有資料可算。

補完順序(可執行版見 [`.claude/NEXT_TASKS.yaml`](../.claude/NEXT_TASKS.yaml) T13–T15):
**✅ P1 資料鏈落地**(停機原因碼 + 事件表 + 逐件生產紀錄與良/不良計數 —— 三件一起做,
2026-08-21 完成,見 Done 表「資料鏈落地」)→ **P2 取數介面**(多設備多 tag / 降採樣 / CSV 或唯讀 SQL)
→ **P3 能耗歸屬與廠級彙總**。上面三格「最刺眼的缺口」P1 都補掉了;還沒補的是
物料流 / 供應鏈 / 工單的**歷史**(只有當下)、以及取數介面本身。

### 0. 移動件到位精準化 Motion precision ★使用者指定的下一步(2026-08-03)

> ✅ **已實作(同日)**:AGV 弧長鎖定(`deviceMotion.agvLockS` —— 回報位置投影成路徑
> 弧長、前進向趨近、到位貼齊;實測連續播放離路徑 **max 0.000 m**、收斂後與遙測座標差
> **0.0000 m**);補間函式加 `snapEps` 貼齊,漸近殘差歸零(手臂下探落站實測 **1.4 mm**);
> `tests/animation` 新增 3 項**到位斷言**(收斂後座標一致 / 連續播放不離路徑 / 下探落站),
> 全套 **38 項**通過。手臂**刻意不做** keyframe 鎖相 —— 活廠取樣(5 s/拍)對 8 s 循環
> 低於 Nyquist,鎖相只會不停硬同步成瞬移;且畫面改吃本地重建曲線會讓 `encoder_drift`
> 「夾偏」的教學效果消失(理由記錄在 [tests/animation/README.md](../tests/animation/README.md))。
> 以下保留當時的診斷:

畫面上「會移動的點」(AGV 車體、手臂夾爪)位置**還沒有完全到位**。根因不在引擎 ——
引擎回報的 `pos_x/pos_y` / `joint_angle_*` 是對的 —— 在前端兩拍遙測之間的補間方式:

- **AGV**:目前對「最新一筆位置」做**直線**指數趨近(`deviceMotion.approach`,τ=0.25 s)。
  telemetry 每 5 秒一拍,兩拍跨過巡迴路線轉角時,補間會切對角線**離開路徑**;
  指數趨近是漸近的,永遠差最後一小段;收斂後靜止等下一拍,節奏變成「衝刺→停頓」。
- **手臂**:對 1 Hz 樣本做**關節空間**直線趨近(τ=0.12 s),與引擎 `_KEYFRAMES` 的實際
  軌跡不同;漸近還會削掉下探最低點 —— 夾爪看起來差一點才碰到料箱。
- **為什麼 35 項驗證沒抓到**:線性回歸(slope / R²)對「系統性落後一小段」不敏感,
  lag 會被吸收進截距與略低的 R²,不會紅。

**解法已有先例**:CNC 刀尖的相位鎖定(`lockCncPhase`)解的就是同一類問題。
AGV 比照辦理 —— 巡迴路線是已知折線,把回報位置投影成**路徑弧長 s**,本地以
`speed×timeScale` 沿路徑推進、每拍 delta-based 拉回引擎值,車體任何時刻都在路上、
停站準確落站;手臂對 keyframe 週期做同款相位鎖定。並在 `tests/animation` 新增
**到位斷言**(停站拍車體與站點距離 < ε、下探最低拍 TCP 與取/放站距離 < ε),
讓這類缺陷從此進 CI。可執行細節見 [`.claude/NEXT_TASKS.yaml`](../.claude/NEXT_TASKS.yaml) `T0-motion-precision`。

### 1. 其餘 template 的資料自洽性掃描 Cross-tag consistency sweep ★最高優先(資料面)

> ✅ **已完成(2026-08-04,見 Done 表「跨 tag 不變量掃描」)**:11 種 template 每種至少
> 一條不變量進 CI,並抓到沖壓機 `tonnage` 尖峰不在下死點的真缺陷(已修引擎)。
> 先前已完成:手臂 `tcp` ↔ 六軸角度(2026-07-28)、故障語意統一(2026-07-29)、
> correlation 批改的時間戳對齊(2026-08-01)。以下保留當時的規劃:

手臂的 `tcp` 缺陷(與六軸角度互相矛盾,相關係數 −0.82)是靠一個**物理不變量**抓到的。
其餘 10 種 template 應該也有可查的不變量,例如:

- 電表:`active_power ≈ √3 × V × I × power_factor`
- 空壓機:`flow` 與 `motor_current` 的關係(濾網阻塞時兩者應脫鉤 —— 這正是要教的)
- CNC:`part_count` 的增速應與 `cycle_time` 一致
- 熱處理爐:`heating_power` 與 `furnace_temp` 對 setpoint 的追隨關係

成本低、風險小,而且如果真的還有「兩套互相矛盾的資料」,那是**會直接教錯學生**的問題,
優先度高於任何視覺改善。作法比照 `verify_scenario.py::check_kinematics`。

### 2. 教材資料包的收尾 Course-pack follow-ups

> ✅ **已完成(2026-08-04,見 Done 表「課程 18 週補滿 + 教材綁定」)**:18 週全定義、
> 週次↔作業↔練習題綁定進 YAML 與 CI、作業與週包統一學號種子(`tools/course_seed.py`)。
> 以下保留當時的規劃:

- `course_weeks.yaml` 目前只定義 **8 週**(W4 / W6–W8 / W10–W12 / W14),18 週規劃裡其餘
  上課週還沒有條件 —— 補齊即可整學期一次產完。
- **週次 ↔ 作業 ↔ 練習題的綁定**:目前課堂即時練習是對**線上活廠**出的,尚未對應到
  「當週的凍結資料包」。兩邊都在了,差一層對應表。
- 作業出題(`make_assignment.py` / `grade_assignment.py`,每學號私有測試集)與週包目前
  各走各的 seed,可統一成同一份學號種子表。

### 3. 產線物料流的延伸 Line-flow follow-ups

> 基礎已完成(見 Done 表「引擎產線物料流」)。後續可做:

- **AGV 也能當產線搬運者** —— 目前 handler 只支援六軸手臂;AGV 入線可做「跨廠區物流」
  (取貨點 / 卸貨點與巡迴路線掛勾),教學上對應廠內 vs 廠間物流。
- **MES 多站路由(一單多站)** —— 工單目前一張綁一台;與 `line:` 串起來即可做
  「一張單沿產線走」的製程路由、每站報工,對應 ISA-95 的 production routing。
- **餓料 / 堵料課堂情境與評分** —— 產線帳(緩衝 / 出貨 / 搬運)都在 snapshot.lines,
  可出「找出瓶頸站」「算節拍不匹配損失」這類題並自動批改(瓶頸分析、Little's Law)。
- **產線層 KPI** —— 線平衡率、瓶頸站利用率、WIP 曲線,從 lines 帳自算即可。

### 4. 對外接入 External access

Cloudflare Tunnel(HTTP)+ Tailscale(原生協定),ACL 限校內 / 學生群組。
*暫緩,待能存取校內 5090 主機。* 見 [docs/部署_對外連線.md](部署_對外連線.md);骨架見 `deploy/cloudflared/`。

### 5. 其他

- ✅ **生產管理 KPI 自動批改**(2026-08-01)—— `production` 作業型別已上線:
  `metric: on_time_rate`(準交率,自當週資料窗起算的完工單)與 `wip`(未完成工單數),
  支援 device / company 兩種範圍,真值與 `/api/orders` 公開資料一致。前置時間(lead time)未做,需要再提。
- **字體離線化** —— HTML 以 Google Fonts 載入 Lora / Noto Sans TC / JetBrains Mono,LAN 無外網會回退
  系統字體(版面 / 顏色不受影響)。**3D 層已完全不依賴外網**,此項只剩 HTML 字體。
- **動畫綁定契約落實到俯瞰層** —— [animation_binding.md](animation_binding.md) 目前規範廠內 3D;
  PixiJS 俯瞰層(公司量體 / 燈號 / 煙囪)仍是純裝飾動畫,未來可比照納管。
- **OPC-UA multi_port** —— 目前 multi_port 只做 Modbus;OPC-UA per-device endpoint 為進階選項(較重)。
- **更多產業 template** —— 15 種(2026-08-19 補 AOI / 焊接 / 雷切 / 包裝)已涵蓋主要教學需求;後續可補廢水 / 環控、鑄造、噴塗。

> 已完成而從待辦移除:真 LLM 建廠、熱載入補完、產業庫擴充(10→11→15 種)、整合建廠自動上線(A+B+C)。

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
- **示範廠 c65 Demo company**:`scenarios/class_park.yaml` 有一間額外的「上下料示範廠」
  (c65:2 CNC + 手臂,**已接引擎產線物料流** —— 工件真實傳遞,搭配「🎬 慢速觀察」
  即為完整的上下料演示)。屬**教師展示用**,不需要時可刪除該公司。
  Teacher-demo company with a real engine-level material-flow line; remove it if not needed.
- **4D 字體 Fonts**:見上 TODO §5 —— LAN 無外網,HTML 會回退系統字體;**3D 層不受影響**(不依賴外網)。
- **動畫的時間換算 Animation time scaling**:場景預設 `time_multiplier: 120`,多數設備的真實循環在牆鐘上
  只有零點幾秒,直接畫會變閃爍。因此週期性動作與高轉速件會夾在可讀區間並**在畫面標出倍率**
  (例:「動畫慢放 ×8」「轉速視覺 ×1/10667」)。**數值一律以點位為準,畫面節拍是換算後的**。
  這時 1 Hz 的 `pos_*` / `ram_position` 已低於該循環的 Nyquist,因此不做相位鎖定;
  倍率≈1(慢速 sim)時才會把畫面相位鎖回遙測。見 [docs/animation_binding.md](animation_binding.md) §1 鐵則三。
- **每週情境:活廠與凍結包兩條路 Live engine vs frozen packs**:`scenarios/course_weeks.yaml` 的每週條件
  可以**套用到正在跑的引擎**(教師控制台按「套用第 N 週情境」,平台沒開就沒有當週資料),
  也可以用 `tools/make_week_packs.py` **離線預產成凍結包**(平台在不在線都不影響已發教材,
  且產後有驗證擋著)。發教材建議走凍結包,現場示範走活廠。**注意兩者不要混用同一份題目** ——
  凍結包的答案卷是產包當下決定的,活廠是即時的。Weekly conditions run either on the live engine
  or as pre-generated frozen packs; don't mix the two for the same question set.
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
