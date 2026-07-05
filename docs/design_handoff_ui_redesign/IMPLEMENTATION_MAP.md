# IMPLEMENTATION_MAP — 逐檔實作建議

> 環境:React 18 + TypeScript + Vite + PixiJS(v8,`Application/Container/Graphics/Text`)。
> 原則:**只改視覺,不動 `api.ts` 與資料流**。設計稿的示範數值換成真實 telemetry。

---

## 1. `web/src/styles.css` — 設計基調(先做)
把 `:root` 換成 README「Design Tokens」的色票,並改字體堆疊為 IBM Plex。
- 在 `index.html` `<head>` 加 IBM Plex 的 Google Fonts `<link>`(見 README)。
- `body { font-family: 'IBM Plex Sans TC', system-ui, sans-serif; background: var(--bg); }`
- 數字/代號類元素(`.clock`、`code`、表格數值、設備 id)套 `font-family: 'IBM Plex Mono'; font-variant-numeric: tabular-nums;`
- 表格:列分隔 `--line-3`、表頭 `--panel` 底 + Mono label(letter-spacing .5px、色 `--dim`)。
- `.badge`/pill:圓角 12–20px,狀態色見 `STATUS_COLOR_CSS`。
- 新增卡片浮起陰影 util:`0 24px 60px -20px rgba(0,0,0,.7)`。

## 2. `web/src/App.tsx` — 外殼 + 側欄(2a)
- 頂欄:logo 方塊(漸層 + 「勤」)、站名、SYNTHETIC pill、`nav` 分頁(active = `#1a212c` 底 + `inset 0 -2px 0 var(--accent)`)。
- 分頁右側新增**全域燈號摘要**:從 `telemetry.devices` 統計 running/warn/fault 數,三顆色點 + 數字(Mono);fault 點加閃爍 keyframe。
- `aside.side` 依 README 2a 順序重排:標題+badge → 教師控制列 → 關鍵訊號(門檻條)→ HOLDING 表 → DISCRETE pills → SETPOINT 卡 → 事件流。
  - 門檻條:外層 `--line-3` 底,內層依 `值/門檻` 寬度填色(<門檻用 accent→ok 漸層,超標 red);門檻位置畫一條 1px 灰線。門檻值可沿用 catalog/telemetry 既有欄位或先用常數。

## 3. `web/src/world/WorldView.tsx` — 俯瞰世界(2a)
既有 `isoBox` 已畫三面 + 樓層線 + 窗格;強化為:
- **三面漸層**:把三面 `fill(單色)` 換成沿面向的線性漸層(Pixi 用 `FillGradient`,或以兩三個多邊形分段模擬)。屋頂 `roof×1.12`、右牆 `×0.72`、左牆 `×0.5`,受光端再 ×1.1。
- **窗光**:部分窗格改用亮色(冷藍 `#7fd0e6`/暖黃 `#e2b24e`)低 alpha,製造夜間廠房感。
- **道路**:`isRoad` 的地磚色提亮到 `#22272f`(交叉口 `#262c36`),中央虛線 `#3a4658`。
- **燈號**:`lightsRef` 的燈改為「屋頂上一支 mast + 燈珠 + 柔光圈」;維持 `tickOverview` 的閃/脈/常亮邏輯(紅閃、橘脈、綠常亮),色改為 `#e0503f/#f0883c/#35d07a`。
- 公司名牌:改深色小膠囊 + 狀態點 + 名字(`IBM Plex Sans TC`)。
- 建議把「等距立方體 + 三面漸層 + 描邊」抽成 `isoBoxShaded(g, ...)` 供俯瞰與廠內共用。

## 4. `web/src/world/WorldView.tsx` — 廠內機台(3a/3b,重點)
`drawStation(g, tmpl, ...)` 內每個 template 分支重繪。共用 helper(可從設計稿 `componentDidMount` 移植):
- `isoBoxShaded(g, ox,oy, w,d,h, {top,left,right})` — 三面線性漸層 + 頂面亮邊。
- `contactShadow(g, cx,cy, rx,ry, alpha)` — 徑向漸層接地陰影(Pixi 用多層同心橢圓遞減 alpha,或一個 radial fill)。
- `emissiveGlow(g, cx,cy, r, color, alpha)` — 徑向發光(用於主軸/電漿/爐火/工件)。

各 template 對照設計稿數值(README「3a/3b」段落列了每台的組成與顏色):
- `robot_arm_6axis`:沿用 `solveArm` + `computeArmCtx` 時序;繪法改大臂橘粗、小臂銀、藍關節、夾爪收合 + 金黃工件。
- `cnc_machining_center`:外殼 + 主軸箱 + 控制柱 + HMI 螢幕 + 觀景窗(暗玻璃)+ 主軸旋轉 + 運轉暖黃發光 + 冷卻火花。
- `injection_molding`:鎖模單元 + 料桶 + 料斗 + 鎖模板開合 + 加熱橘光。
- 輸送帶(`beltRef`/`updateFlow`):帶身漸層 + 側軌 + 移動 chevron + 發光工件。
- `semi_process_chamber` / `stamping_press` / `air_compressor` / `heat_treat_furnace` / `wind_turbine`(轉速 ∝ `rotor_rpm`)/ `energy_meter` / `agv_mobile_robot`:見 README 對應描述與色值。
- 幾何時序全部沿用既有 `tickInterior`;只換 `Graphics` 畫法。

> Pixi 漸層提醒:v8 的 `FillGradient` 以世界座標運作;若在 `Container` 內平移,漸層需用相對座標或每次重建。若嫌麻煩,可用「同色分 2–3 段多邊形(亮→暗)」近似漸層,效果足夠。

## 5. 五個頁面(2b–2f)— 純 React/CSS
這些是最直接的移植(表格/卡片/長條),沒有 Canvas。逐檔:
- `student/StudentView.tsx`(2b):身分卡、公司認領 4 欄格、工單 grid 表、右側三榜。既有 `Leaderboard` 元件可保留,套新樣式。
- `catalog/CatalogView.tsx`(2c):改成左清單 + 右規格兩欄;register 表沿用 `40001/10001/30001` 換算與即時值。
- `diagnostics/DiagnosticsView.tsx`(2d):協定摘要卡 + 設備×協定矩陣(既有資料結構 `protocols`/`devices` 直接對應)。
- `oee/OeeView.tsx`(2e):前三名卡 + 分項長條(`barColor` 門檻沿用)+ 明細表。
- `teacher/TeacherView.tsx`(2f):把現有一長串表單拆成分區卡片;所有 handler(`injectFault`/`resetDevice`/`runScenario`/`createFactory`/`resetSession`/`setClock`)不變。

## 驗收檢查
- [ ] 全站字體為 IBM Plex;數字等寬對齊。
- [ ] 分頁 active 樣式、SYNTHETIC pill、全域燈號摘要。
- [ ] 俯瞰:建築量體漸層 + 窗光 + 屋頂燈號閃/脈/亮;道路可辨識。
- [ ] 廠內:各機台量體 + 發光 + 動態(手臂/主軸/帶/風扇/沖壓/爐火/電漿)。
- [ ] 五頁面版面與色彩對齊設計稿;資料接回真實 telemetry。
- [ ] 深色對比:小字 ≥ `--muted`,狀態色僅用於狀態,不濫用。
- [ ] 無 API/資料流改動。
