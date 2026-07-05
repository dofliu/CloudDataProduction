# Handoff:雲端生產數據平台 — UI 全面重新設計

## Overview
本包是「勤益智慧工業區 / 虛擬工業區教學平台」前端(`claudDataProduction/web`)的**視覺重新設計**,涵蓋:

1. **主監控畫面(2D 世界 + 遙測側欄)** — 沿用原本的頂欄分頁 + 世界/側欄佈局,但視覺精緻化。
2. **2.5D 俯瞰園區** — 保留原本的等距街道/俯瞰方式,升級成有量體、窗光、屋頂燈號的擬真園區。
3. **廠內設備動畫** — CNC、射出機、六軸手臂、輸送帶、製程腔體、沖壓機、空壓機、熱處理爐、風力機、電表、AGV 全部重繪,更精緻真實。
4. **其餘頁面** — 學生面、設備目錄、戰情版、OEE 榜、教師控制台,統一到同一套深色工業風。

目標:**以新視覺取代目前的 UI**,維持所有既有功能與資料流不變。

## About the Design Files
本包內的 `design-reference.dc.html` 是**用 HTML + Canvas 製作的設計參考稿**(呈現最終外觀與動態行為的原型),**不是要直接搬進專案的產品程式碼**。

你的專案已經是 **React + TypeScript + Vite + PixiJS** 的環境。任務是:**在既有的 React/PixiJS 架構下,依照本設計稿的外觀與動態,改寫既有的元件檔**(見下方「檔案對應」),沿用專案現有的資料層(`api.ts` 的 REST/WebSocket、telemetry、事件流)完全不動。

> 換句話說:資料與邏輯保留,替換的是「怎麼畫」。設計稿裡的資料都是合成示範值,實作時請接回真實 telemetry。

## Fidelity
**High-fidelity(高擬真)**。顏色、字體、間距、圓角、動態都是最終值,請盡量像素級重現。設計稿裡標示的 hex、字級、尺寸即為規格。

## 檔案對應(Design → 你的 codebase)
設計稿的每個畫面對應到既有檔案。原則:**改視覺,不改資料/流程**。

| 設計稿代號 | 畫面 | 對應既有檔案 | 改動重點 |
|---|---|---|---|
| 2a | 主監控外殼 + 側欄 | `web/src/App.tsx` + `web/src/styles.css` | 頂欄、分頁、右側 `aside.side` 遙測面板改版;新增全域燈號摘要 |
| 2a | 2.5D 俯瞰園區 | `web/src/world/WorldView.tsx`(`buildOverview` / `isoBox` / `drawTree` / `tickOverview`) | 建築量體漸層、窗光、屋頂燈號 mast、道路/車道 |
| 3a/3b | 廠內設備動畫 | `web/src/world/WorldView.tsx`(`buildInterior` / `drawStation` / `updateFlow` / belt) | 每種 machine 的繪法升級為金屬漸層 + 發光 + 陰影 |
| 2b | 學生面 | `web/src/student/StudentView.tsx` | 身分列、公司認領卡、工單表、右側競賽榜 |
| 2c | 設備目錄 | `web/src/catalog/CatalogView.tsx` | 改兩欄:左設備清單 + 右規格/點位表 |
| 2d | 戰情版 | `web/src/diagnostics/DiagnosticsView.tsx` | 協定摘要卡 + 設備×協定矩陣 |
| 2e | OEE 榜 | `web/src/oee/OeeView.tsx` | 前三名卡 + 分項長條 + 明細表 |
| 2f | 教師控制台 | `web/src/teacher/TeacherView.tsx` | 分區卡片:建廠 / 注入故障 / 情境 / ground-truth / 工單 / 評分 |

> 方案 1(1a/1b/1c)是早期探索,**可忽略**。以「方案 2 + 方案 3」為準(設計稿最上方兩區)。

## Design Tokens

### 字體
- UI / 中文標題內文:`'IBM Plex Sans TC', system-ui, sans-serif`(權重 400/500/600/700)
- 數字 / 代號 / register / tag / 時鐘:`'IBM Plex Mono', monospace`(權重 400/500/600)
- 載入:`https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans+TC:wght@400;500;600;700&display=swap`
- Pixi `Text` 標籤字體同步改為 `IBM Plex Sans TC`(原為 Microsoft JhengHei / Segoe UI)。

### 色彩(取代 `styles.css` 的 `:root`)
| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#07090d` | 頁面最底 |
| `--frame` | `#0b0f15` | 內容區底 |
| `--panel` | `#10151d` | 卡片 / 頂欄 / 側欄 |
| `--panel-2` | `#0c1017` | 次級面板 / 事件區 |
| `--panel-3` | `#0c1219` | 輸入框 / 內嵌卡 |
| `--line` | `#202836` | 主要分隔線 / 邊框 |
| `--line-2` | `#2a3340` | 較亮邊框(輸入、hover) |
| `--line-3` | `#1a212c` | 表格列分隔 |
| `--text` | `#e8edf4` | 主要文字 |
| `--text-2` | `#c7d0dd` | 次要文字 |
| `--muted` | `#8a94a6` | 弱化文字 |
| `--dim` | `#6d7686` | 更弱 / label |
| `--faint` | `#5c6675` | 提示 / 註腳 |
| `--accent` | `#4c9ce8` | 主色(active tab、主按鈕、連結) |
| `--accent-grad` | `linear-gradient(140deg,#4c9ce8,#2c6fb0)` | logo 方塊 |
| `--ok` | `#35d07a` | running / 正常 / 綠燈 |
| `--warn` | `#f2c14e` | 警告 / 黃燈 |
| `--pred` | `#f0883c` | 預測故障 / 橘燈 |
| `--fault` | `#e0503f` | 故障 / 紅燈 |

狀態底色(卡片/badge 用):故障 `#1a1113`/border `#4a2620`;警告 `#221a0d`/`#4a3a1a`;正常 `#0f2018`/`#1e4230`。

### 尺寸 / 間距 / 圓角
- 頂欄高 `56px`;側欄寬 `346px`;左設備清單寬 `262px`。
- 圓角:卡片 `11–14px`、按鈕/輸入 `6–7px`、badge/pill `12–20px`、燈點 `50%`。
- 卡片陰影(浮起):`0 24px 60px -20px rgba(0,0,0,.7)`。
- active 分頁:底線 `box-shadow: inset 0 -2px 0 #4c9ce8`,底色 `#1a212c`。
- 字級:標題 15–22px / 內文 12.5–13px / label 10.5–11px(Mono, letter-spacing .5px)/ 大數字 20–36px(Mono 600–700)。
- 表格數字一律 `IBM Plex Mono` 靠右,`font-variant-numeric: tabular-nums`。

## Screens / Views(逐畫面規格)

### 2a — 主監控畫面外殼
- **頂欄**:logo 方塊(26px,圓角 7,accent 漸層,內含「勤」)+ 站名 15/600 → 「合成數據 SYNTHETIC」pill(橘,`#20160d` 底、`#6b4324` 邊)→ 分頁 nav → 右側**全域燈號摘要**(綠 18 / 黃 3 / 紅 2,紅點 `blink` 1.4s)→ 時鐘 `sim 42.6 h · 3600×`(Mono)→「名詞速查」按鈕。
- **主體 flex**:左世界(`flex:1`)+ 右側欄(`346px`)。
- **側欄**(對應 `aside.side`,由上而下):設備標題 + 狀態 badge → 教師停機/重置按鈕列 → **關鍵訊號**(振動/電流/溫度:標籤 + 門檻條 + 值,超標紅色)→ 保持暫存器表(HOLDING FC03)→ 離散輸入 pills(FC02)→ 設定點寫入卡(FC06)→ 底部事件流(`232px`,依狀態上色)。

### 2.5D 俯瞰園區(WorldView `buildOverview`)
- 保留等距投影與街道格。升級:
  - **建築**:三面(屋頂最亮 = `roof×1.12`、右牆 `×0.72`、左牆 `×0.5`),牆面畫樓層橫線 + 窗格,部分窗「亮」(冷藍 `#7fd0e6` / 暖黃,低 alpha)。接地陰影往右下偏移。屋頂加空調機、受光邊 rim 高光。
  - **道路**:路面比地磚略亮(`#22272f`,交叉口 `#262c36`),中央虛線 `#3a4658` dash。
  - **燈號**:每間公司屋頂上方一支細 mast + 燈珠(綠/黃/橘/紅),外圈柔光;紅=有設備故障(閃)、橘=有預測(脈動)、綠=正常。名牌:深色小膠囊 + 狀態點 + 公司名。
  - 樹木保留(三層樹冠受光/背光雙色 + 高光)。

### 3a/3b — 廠內設備動畫(WorldView `buildInterior` / `drawStation`)
所有機台改為「等距量體(金屬漸層)+ 接地徑向陰影 + 發光細節」。等距立方體通用畫法:每面用線性漸層(受光端亮、背光端暗),頂面最亮並描亮邊。**發光**用徑向漸層(`shadowBlur` 或疊加 radial)。關鍵機台:
- **六軸手臂**:底座立方 + 轉盤橢圓 + 兩節 IK(大臂橘 `#f0883c` 粗 11px、小臂銀 `#cdd9ec` 7px)+ 藍關節 + 夾爪(夾件時收合並顯示金黃工件);沿 pickup→drop 用 smoothstep 緩動,4.5s 循環。
- **CNC**:外殼立方 + 主軸箱 + 控制柱 + HMI 小螢幕(運轉綠、故障紅)+ 觀景窗(暗玻璃)+ 內部主軸旋轉(運轉時暖黃發光 `#ffd479` + 冷卻火花粒子)。
- **射出機**:鎖模單元 + 射出料桶 + 料斗;鎖模板隨 `sin` 開合;加熱段橘光 `rgba(255,140,60)`。
- **輸送帶**:等距帶身漸層 + 側軌 + 移動人字紋(chevron)+ 流動的發光金黃工件(`#d9a441`/`#f0c674`,底部橘光)。
- **製程腔體**:腔身 + 圓形觀景窗(電漿紫 `#8f6bd6` 脈動輝光)+ 氣管 + 真空泵小立方。
- **沖壓機**:C 型機架(立柱 + 上樑)+ 工作台 + 滑塊上下往復(`abs sin`)+ 衝壓瞬間亮點。
- **空壓機**:桶身 + 馬達 + 四葉風扇旋轉 + 壓力綠燈脈動。
- **熱處理爐**:耐火磚色爐體 + 爐門橘紅輝光脈動 + 排氣管 + 上升熱氣粒子。
- **風力機**:塔 + 機艙 + 三葉旋轉(轉速 ∝ `rotor_rpm`)。
- **電表**:箱體 + 綠色數字面板 + 三相 LED(紅/黃/綠)閃爍。
- **AGV**:車體 + 頂載金黃貨件 + 綠色狀態燈,沿固定矩形軌跡巡走。
- 廠內另有:輸送帶末端「出貨 →」標記、巡走 + 定點作業的人員(身體 + 手臂擺動 + 頭)。

> 這些動態在原碼已存在(`tickInterior` / `computeArmCtx` / `updateFlow`),**幾何與時序可沿用**,只需把 `drawStation` 內每個 template 的 `Graphics` 繪法換成本設計的量體 + 漸層 + 發光版本;`isoBox` 概念可抽成通用「等距立方體 + 三面漸層」helper。

### 2b — 學生面
- 頂:身分卡(頭像方塊 + 學生 id + 我的公司 + 未結案工單數紅字)。
- 公司認領:4 欄卡片格(我的=綠邊綠底、未認領=認領按鈕、已被認領=灰化)。卡右上狀態點。
- 我的工單:grid 表(單號 Mono / 設備·元件 / 狀態色點 / 偵測延遲 / MTTR / ack·resolve 按鈕)。
- 右側欄(`400px`)三張競賽榜:故障管理 / 預測(lead time)/ OEE,自己那列綠底綠邊高亮,第一名金色序號。

### 2c — 設備目錄
- 左清單(`262px`):每項狀態點 + 設備 id(Mono)+ 公司;選中項左側 accent 條 + `#132029` 底。
- 右規格:標題 + 狀態 badge → 連線 meta 小卡(Modbus host:port、unit_id、位元組序、ModScan 對應)→ HOLDING 表(FC03,附 reg/ModScan/mqtt field/即時值,超標上色)→ 下方兩欄:離散輸入(FC02)、線圈(FC01/FC05)。FC 標籤用彩色小 tag。

### 2d — 戰情版
- 標題 + 「▶ 執行連線診斷」主按鈕。
- 4 張協定摘要卡(Modbus 共用/專屬、OPC-UA、MQTT):協定名 + port + `可達/總數`大數字(全綠 `#35d07a`、有失敗 `#e0503f`,卡片邊框同色調)。
- 設備×協定矩陣:每格 `✓ 值 tag·latency` 綠 / `✗ error` 紅。底部一行摘要說明。

### 2e — OEE 榜
- 說明列(OEE = 可用率 × 表現 × 良率)。
- 前三名卡(#1 金色調漸層底):公司 + owner·台數 + 大 OEE%(依值上色)+ 分項小字。
- 完整排名:每列 序號 + 公司(故障中標紅)+ 大 OEE% + 可用/表現/良率三條長條(>85 綠、>60 黃、否則紅)。下方各設備明細表。

### 2f — 教師控制台
- 頂欄右側:「教師 token 已載入」黃 pill + 時鐘倍率按鈕(60/600/3600/⏸,600 為 active 藍)。
- 左欄(actions):建廠(自然語言輸入 + 建立按鈕)/ 注入故障(設備·型態·目標·severity 下拉 + 注入紅、⚡快速故障橘、reset)/ 情境腳本(下拉 + ▶執行/停止)/ ground-truth 健康條(元件 h 值長條,依健康上色)。
- 右欄(`452px`):工單板(ack/resolve)+ 評分榜 + 「🧹 重置課堂資料」紅色警示卡。

## Interactions & Behavior
- **分頁切換**:沿用 `App.tsx` 的 `view` state(start/world/student/catalog/diag/oee/teacher),active 樣式如上。
- **世界互動**:hover 公司→tooltip;點公司→進廠內(`focus`);點設備→`onSelect`→側欄。返回鈕清 `focus`。全部沿用既有事件。
- **動畫**:世界/廠內走 Pixi `ticker`(既有),依 `animT` 驅動,與遙測節流脫鉤。燈號閃爍 1.3–2s;手臂 4.5s 循環;帶/主軸/風扇連續旋轉。
- **狀態上色**:`colorOf(state)` / `worstState` 沿用;新增「預測中」以橘色(`predicted` Set 判斷)。
- CSS 過場建議:hover 背景/邊框 `transition: .15s ease`。

## State Management
無新增。全部沿用既有:`park`、`telemetry`(WS)、`catalog`、`selected`、`predicted`、`view`、教師 token、各榜輪詢(2–4s)。設計未改變任何 API 契約。

## Assets
無圖片資產。全部為 CSS/Canvas/Pixi 向量繪製 + Google Fonts(IBM Plex)。logo 為 CSS 漸層方塊 + 「勤」字,可日後替換為真實 logo。狀態色/emoji(🏭🔮⚠✅🎛🧹)沿用原專案既有用法。

## Files
- `design-reference.dc.html` — 完整設計稿(可直接用瀏覽器開啟)。畫布最上方:
  - **方案 3**:`3a` 廠內即時(即時動畫)、`3b` 設備動畫圖鑑 — 對應 `WorldView.tsx` 廠內。
  - **方案 2**:`2a`–`2f` — 對應各頁面與俯瞰世界。
  - 方案 1(`1a`–`1c`):早期探索,可略。
- 設計稿的 Canvas 機台繪製程式(等距立方體 helper、各 machine drawer、六軸手臂 IK、輸送帶)在檔案內 `class Component` 的 `componentDidMount` 中,可直接參考數值與畫法移植到 `drawStation`。
- `IMPLEMENTATION_MAP.md` — 逐檔實作建議與順序。

## 實作順序建議
1. 先套 `styles.css` 的 tokens + IBM Plex 字體(全站基調立刻對齊)。
2. `App.tsx` 外殼 + 側欄(2a)。
3. 五個表單頁(2b–2f)— 純 React/CSS,最快看到成果。
4. `WorldView.tsx` 俯瞰建築量體/燈號(2a 世界)。
5. `WorldView.tsx` 廠內 `drawStation` 機台重繪(3a/3b)— 視覺提升最大、工最細,建議最後做。
