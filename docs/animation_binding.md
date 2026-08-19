# 設備動畫綁定契約 · Animation Binding Contract

> 目的:讓 2D / 3D 動畫**精準呈現設備當下的動作、狀態與資料**,而不是「看起來很忙」的裝飾。
> 本檔是前端動畫的唯一依據。任何人(或任何 AI)要改動畫,先改這張表,再改程式碼。
> 相關:[02-simulation-engine.md](02-simulation-engine.md)(訊號怎麼來)、[03-industry-templates.md](03-industry-templates.md)(產業型別)。

---

## 0. 三條鐵則

1. **只畫引擎給的東西**。動畫的每一個會動的部位,都必須對應 `snapshot.tags` /
   `snapshot.setpoints` / `snapshot.coils` / `snapshot.state` 的某個具體欄位。
   找不到欄位的動作,不可以憑空捏造 —— 要嘛去引擎補 tag,要嘛不要畫。
2. **前端不重算引擎已經算過的物理**。引擎算好的位置 / 角度 / 相位(`pos_x`、`ram_position`、
   `joint_angle_*`…)一律直接用。前端只做「兩次遙測之間的補間」,不做第二套模擬。
3. **視覺換算必須標示**。人眼看不了 8000 rpm,也看不清 0.4 秒一次的加工循環。
   做了降頻 / 慢放的地方,**畫面上要寫出換算倍率**,學生才知道「畫面被縮放、但資料沒有」。

---

## 1. 綁定等級

| 等級 | 意義 | 例子 | 驗收方式 |
|------|------|------|----------|
| **L1 直接映射** | 畫面幾何量 = 資料值(僅換單位) | `pos_x`(mm)→ 主軸座 X;`ram_position`(mm)→ 滑塊高度;`joint_angle_3`(deg)→ 第 3 軸角度 | 用 Modbus 讀該 tag,值應與畫面位置一致 |
| **L2 比例映射** | 連續量 → 視覺強度,單調遞增、值域明確 | `vibration_rms` → 機台抖動振幅;`spindle_temp` → 主軸發熱輝光 | 值變大,視覺一定變強;不可反轉 |
| **L3 時間換算** | 因顯示極限而降頻 / 慢放 | 主軸 8000 rpm → 畫面 ≤1.5 rev/s;加工循環 0.4 s → 畫面 4 s | **畫面必須標出倍率**,例如「主軸 ×1/89」「循環 慢放 ×10」 |

> L3 是誠信底線。專案鐵則二說「數據必須誠實」,動畫同理:可以縮放,不可以假裝沒縮放。

---

## 2. 通用狀態語彙(所有設備一致)

前端把 `state` + `coils.run_enable` 正規化成一組旗標(見 `web/src/world/deviceMotion.ts`):

| 旗標 | 來源 | 視覺表現 |
|------|------|----------|
| `running` | `state ∈ {running, moving, charging, tool_change}` 且未故障 | 機構運轉、柱燈綠 |
| `idle` | `state ∈ {idle, maintenance, blocked}` | 機構停止、柱燈黃(恆亮) |
| `fault` | `state == fault`(或 `alarm`) | 機構立即停止、柱燈紅**閃爍**(黃燈同時熄掉,讓紅燈獨佔柱燈;閃爍的暗相不歸零,任何瞬間都看得出是紅的)、機台冒煙、主色轉警示紅 |
| `stopped` | `coils.run_enable == false` | 機構停止、柱燈黃**慢閃**(與自然待機區分) |
| `charging` | `state == charging`(AGV) | 停於充電站、電池圖示脈動 |

退化(健康度)則走三個 0..1 的連續量,由觀測 tag 反推(不碰 ground-truth):

| 量 | 來源 tag | 視覺 |
|----|----------|------|
| `severity` | `vibration_rms`(門檻見 §4) | 機台整體抖動振幅、柱燈由綠轉黃 |
| `heat` | 該機種主要溫度 tag | 熱源部位 emissive 輝光 |
| `wear` | 該機種指標型退化 tag(`tool_wear` / `burr_rate` / `particle_count` …) | 加工火花變多變紅、工件品質外觀 |

**severity 通用門檻**:`warn = 4.5 mm/s`、`fault = 11 mm/s`(對應引擎各 template 的
`base + 10~12 × (1-health)^1.8`)。`severity = clamp((vib - warn) / (fault - warn), 0, 1)`。

---

## 3. 時間軸

- 遙測 1 Hz;渲染 60 fps。中間一律用 **delta-based 指數趨近**
  `x += (target - x) × (1 - exp(-dt/τ))`,不可以用 `x += (target-x) × 0.4`
  (那是 frame-rate 相依的,144 Hz 螢幕會跑得比 60 Hz 快)。
- **到位要貼齊(snap)**:指數趨近是漸近的,數學上永遠到不了目標 —— 要停在定點的機構
  (AGV 停站、手臂下探)會永遠差最後一小段。誤差小於 snap 門檻就直接貼齊,
  靜止時畫面座標 = 遙測座標,一格不差(`deviceMotion.approach*` 的 `snapEps` 參數)。
- **沿已知路徑移動的機構,補間在路徑座標上做**:對「最新一筆位置」做直線趨近,
  兩拍跨過轉角時會切對角線離開路徑。路線是引擎的靜態幾何(前端持同一組常數),
  把回報位置投影成弧長再趨近(AGV:`agvLockS`),機構任何時刻都在路上。
  這不是重算物理 —— 位置與速度仍是引擎回報的值,前端只決定「兩拍之間走哪條路」。
- `sim_clock` 倍率由 `TelemetryMsg.multiplier` 提供(場景預設 `time_multiplier: 120`)。
  週期性動作的**牆鐘週期** = `sim 週期 / multiplier`。
- 可讀區間:`MIN_PERIOD = 3.0 s`、`MAX_PERIOD = 20.0 s`。超出即夾住,並標示倍率(L3)。
- 旋轉:`MAX_SPIN = 1.5 rev/s`。超出即降頻,並標示倍率(L3)。

---

## 4. 逐機種綁定表

> 「引擎欄位」欄若標 ⚙ 表示是 **setpoint**(在 `snapshot.setpoints`,不在 `tags`)。

### 4.1 `cnc_machining_center` — CNC 加工中心

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 龍門 Z 向(前後) | `pos_y` (mm, ±220) | L1 | `/50` → 模型單位 |
| 主軸座 X 向(左右) | `pos_x` (mm, ±220) | L1 | `/50` |
| 主軸頭升降 | `pos_z` (mm, +50 抬刀 / −50 下刀) | L1 | `/50` |
| 加工圖樣 | ⚙ `machining_pattern` (0=刻字 / 1=圓 / 2=方) | L1 | 決定刀路;相位以 `pos_*` 反推鎖定 |
| 刻字文字(pattern 0) | ⚙ `engrave_char_1` .. `engrave_char_8` (ASCII 碼,0=空白) | L1 | 筆畫由引擎與前端同一套筆畫字型生成(A–Z / 0–9 / -);預設「NCUT」。學生逐格 FC06 或 REST `/engrave_text` 寫入 |
| 循環週期 | `cycle_time` (s, 45→60 隨刀具鈍化變長) | L3 | 牆鐘週期 = `cycle_time / multiplier`,夾在 3~20 s |
| 主軸旋轉 | `spindle_speed` (rpm) | L3 | 降頻至 ≤1.5 rev/s,標示倍率 |
| 切削中(火花 / 刻痕 / 冷卻液) | `pos_z < 0` | L1 | 引擎的 z<0 就是下刀切削 |
| 刻痕重置 | `part_count` 變動 | L1 | 換新件 → 清空刻痕 |
| 火花密度 / 顏色 | `tool_wear` (0→100 %) | L2 | 刀越鈍火花越多越紅 |
| 主軸發熱輝光 | `spindle_temp` (25→90 °C) | L2 | |
| 機台抖動 | `vibration_rms` (0.15→13 mm/s) | L2 | |
| 柱燈 / 冒煙 / 停轉 | `state`、`coils.run_enable` | L1 | §2 |

### 4.2 `robot_arm_6axis` — 六軸機械手臂

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| J1~J6 關節角 | `joint_angle_1..6` (deg) | L1 | **六軸全用**,不再由 J1 合成 |
| 取放兩站位置 | ⚙ `pick_x` `pick_y` `place_x` `place_y` (mm) | L1 | 料檯 = 座標 ÷200;引擎逆運動學保證下探時 TCP 落在該座標(學生 FC06 可寫,負值走 int16 二補數) |
| 夾爪開合 / 工件在手 | 由 `joint_angle_*` 經前端 fk 過取放點推得 | L1 | fk 端點貼近下探高度(150 mm)且離哪站近就是在哪站取 / 放 |
| 末端位置校驗 | `tcp_x/y/z` (mm) | L1 | 引擎由 `forward_kinematics(joint_angle_1..6)` 算出;÷200 = 世界單位。畫面夾爪必須對得上(§6) |
| 循環計數 | `cycle_count` | L1 | 產線(`line:`)場景下 = 實際搬運件數(事件驅動,無料時待命) |
| 關節發熱 | `joint_temp_1..6` (°C) | L2 | 取最大值 |
| 機身抖動 | `vibration_rms` (0.1→12) | L2 | |

### 4.3 `agv_mobile_robot` — AGV 搬運車

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 車體位置 | `pos_x`, `pos_y` (m, 2~18 × 2~12 矩形路線) | L1 | 1 m = 1 模型單位;補間走**弧長鎖定**(§3):投影成路徑弧長、前進向趨近、到位貼齊 —— 車體恆在巡迴路徑上,不切轉角 |
| 車頭朝向 | `heading` (deg) | L1 | wrap-aware 補間(0.5° 內貼齊) |
| 輪子轉動 | `speed` (m/s) | L1 | 角速度 = v / r |
| 載貨方塊 | `payload` (kg, 0 / 30) | L1 | >0 顯示 |
| 電量顯示 / 低電紅字 | `battery_soc` (%) | L1 | |
| 充電站脈動 | `state == charging` | L1 | |
| 馬達發熱 | `motor_temp` (°C) | L2 | |

### 4.4 `conveyor` — 輸送帶

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 皮帶捲動 / 工件前進 | `belt_speed` (m/s, ~1.0) | L1 | 1 m/s = 1 模型單位/s |
| 帶上工件數(產線視圖) | `line_on_belt`(FC04;同 snapshot.lines 的 on_belt) | L1 | 產線終站只畫引擎帳上的件數,空帶就是空的;引擎在空帶時讓輸送帶待機(belt_speed→0、state=idle,不空轉) |
| 馬達負載輝光 | `motor_current` (A, 5→7) | L2 | |
| 機身抖動 | `vibration_rms` (0→2) | L2 | 門檻較低:warn 1.2 / fault 2.0 |

### 4.5 `stamping_press` — 沖壓機

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 滑塊高度 | `ram_position` (mm, 0~120) | L1 | **直接用**,不再自己跑 sin |
| 行程節拍 | `stroke_rate` (spm) | L3 | 牆鐘週期 = `60/spm / multiplier`,夾住並標示 |
| 下死點火花 | `ram_position < 8 mm` | L1 | |
| 累積行程數 | `stroke_count` | L1 | |
| 噸位錶 | `tonnage` (ton, ~200) | L1 | |
| 毛邊(工件外觀) | `burr_rate` (%, 0.5→15) | L2 | 毛邊越高工件邊緣越毛躁 / 變色 |
| 潤滑警示 | `lubrication_pressure` (bar, 3→1.5) | L2 | 低於 2.0 亮黃 |
| 模具發熱 | `die_temp` (°C) | L2 | |
| 機身抖動 | `vibration_rms` (0.15→12) | L2 | |

### 4.6 `injection_molding` — 射出成型機

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 循環相位(鎖模 / 射出 / 冷卻 / 開模 / 頂出) | `injection_pressure`(90→160 bar 為射出段)+ `clamping_force` | L1 | 由兩者反推相位 |
| 循環週期 | `cycle_time` (s, 隨螺桿磨耗變長) | L3 | 牆鐘週期 = `cycle_time / multiplier`,夾住並標示 |
| 螺桿轉動 | `screw_speed` (rpm, 120~160) | L3 | 降頻標示 |
| 熔膠顏色 / 料管發熱 | `barrel_temp_1..4` (°C, 225~240) | L2 | |
| 鎖模力錶 | `clamping_force` (ton) | L1 | |
| 累積模數 | `shot_count` | L1 | |
| 液壓油溫輝光 | `oil_temp` (°C) | L2 | |
| 機身抖動 | `vibration_rms` (0.12→11) | L2 | |

### 4.7 `wind_turbine` — 風力發電機

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 轉子轉速 | `rotor_rpm` (rpm, 6~15) | L1 | 6~15 rpm 直接畫得出來,不需降頻 |
| 葉片槳距角 | `pitch_angle` (deg, 0=工作 / 88=順槳停機) | L1 | **原本誤用不存在的 `yaw_angle`** |
| 風速風向指示 | `wind_speed` (m/s, 0~28) | L1 | |
| 發電量顯示 | `power_output` (kW) | L1 | |
| 機艙 / 齒輪箱發熱 | `generator_temp`, `gearbox_temp` (°C) | L2 | |
| 塔架擺動 | `vibration_rms` (0.8→12) | L2 | |

### 4.8 `air_compressor` — 空壓機

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 壓力錶指針 | `outlet_pressure` (bar, 5~9) | L1 | **原本誤用不存在的 `tank_pressure`** |
| 壓力設定點紅線 | ⚙ `pressure_setpoint` (bar) | L1 | 指針 vs 目標一眼可比 |
| 飛輪 / 皮帶轉動 | `state == running` + `motor_current` | L3 | 1500 rpm 降頻標示 |
| 活塞往復 | 同上 | L3 | 與飛輪同相位 |
| 出風流量粒子 | `flow` (m³/min, 0~8) | L2 | |
| 馬達發熱 | `motor_temp` (°C) | L2 | |
| 濾網阻塞警示 | `motor_current` 高但 `flow` 低 | L2 | 兩訊號交叉,對應 `filter_clog` |
| 機身抖動 | `vibration_rms` (0.12→11) | L2 | |

### 4.9 `energy_meter` — 智慧電表

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 有效功率讀數 | `active_power` (kW, 30~220) | L1 | |
| 三相電壓 | `voltage_l1/l2/l3` (V, ~380) | L1 | **原本誤用不存在的 `voltage`**;三相分開顯示 |
| 三相電流 | `current_l1/l2/l3` (A) | L1 | **原本誤用不存在的 `current`**;三相長條圖看不平衡 |
| 功因 | `power_factor` (0.6~0.99) | L1 | <0.85 亮黃、<0.75 亮紅 |
| 累積電能 | `energy_total` (kWh) | L1 | |
| 負載率長條 | `active_power / 220` | L2 | |

### 4.10 `semi_process_chamber` — 半導體製程腔體(新增 3D)

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 電漿輝光強度 | `rf_power` (W, 0~1500) | L2 | |
| 腔壓顯示 / 抽氣粒子 | `chamber_pressure` (mTorr, 5~65) | L1 | |
| 三路 MFC 氣體流線 | `gas_flow_1/2/3` (sccm, 50/30/15) | L1 | 三條線寬度分別對應 |
| 真空泵轉動 / 電流錶 | `vacuum_pump_current` (A, 6~15) | L1 + L3 | 錶 L1、轉動 L3 |
| 泵浦發熱 | `pump_temp` (°C) | L2 | |
| 微粒污染(良率殺手) | `particle_count` (1/wafer, 4→70) | L2 | 腔內飄浮微粒數量與顏色 |
| 產出節拍 | `throughput` (wph) | L3 | 晶圓搬運動畫節拍 |
| 累積片數 | `wafer_count` | L1 | |

### 4.11 `heat_treat_furnace` — 熱處理爐(新增 3D)

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 爐膛火光顏色 / 強度 | `furnace_temp` (°C, 30~900) | L2 | 900 °C = 亮橘白 |
| 爐溫讀數 + 設定點 900 °C 對照 | `furnace_temp` | L1 | 到不了設定點 = 加熱元件老化 |
| 爐內溫差熱斑 | `temp_uniformity` (°C, 4→39) | L2 | 越大爐內色塊越不均 |
| 加熱功率條 | `heating_power` (kW, 60~93) | L1 | |
| 元件電流錶 | `element_current` (A, 120~160) | L1 | |
| 保護氣氛流線 | `atmosphere_flow` (L/min, 2~40) | L1 | |
| 殘氧警示 | `oxygen_ppm` (ppm, 8→230) | L2 | >100 ppm 亮紅(密封洩漏) |
| 累積能耗 | `energy_kwh` | L1 | |

---

### 4.14 `aoi_inspection` — AOI 光學檢測站(2026-08 新增)

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 相機龍門 X(左右) | `camera_pos_x` (mm, ±150) | L1 | `/50` → 模型單位;蛇形掃描 |
| 相機龍門 Y(前後) | `camera_pos_y` (mm, ±100) | L1 | `/50`;逐列步進 |
| 掃描節拍 | `inspect_time` (s, 15→21 隨軸承磨損變長) | L3 | 牆鐘週期 = `inspect_time / multiplier`,夾住並標示;倍率 ≈1 時直接鎖遙測座標 |
| 環形光源亮度 / 檢測光斑 | `light_intensity` (%, 100→68) | L1 | emissive ∝ 值(led_aging 一眼可見) |
| 鏡頭霧化 | `focus_score` (score, 96→41) | L2 | 反向:分數掉 → 鏡片變濁(lens_contamination) |
| 誤判警示 | `false_call_rate` (%, 0.6→20+) | L2 | 良率指標(檢測站「說不準」的代價) |
| 累積檢數 | `inspected_count` | L1 | |
| 機台抖動 | `vibration_rms` (0.3→11) | L2 | |

> 掃描蛇形參數式與 `engine/templates/aoi_inspection.py::_scan_xy` 逐行對應
> (5 列、±150 × ±100,偶數列往右奇數列往左)—— 前端只在 L3 慢放時本地跑同一條曲線。

### 4.15 `welding_cell` — 焊接機器人工作站(2026-08 新增)

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 焊槍 X(沿焊道) | `torch_pos_x` (mm, ±200) | L1 | `/50`;電弧段勻速前進、回程快退 |
| 焊槍 Y(道別) | `torch_pos_y` (mm, ±60) | L1 | `/50`;奇偶道交替 |
| 電弧開關 | `arc_current` (A, >100 = 弧開) | L1 | 遙測說有弧才畫弧光,不自己猜相位 |
| 焊道節拍 | SEAM_S = 16 s(常數) | L3 | 牆鐘週期 = `16 / multiplier`,夾住並標示 |
| 飛濺粒子密度 | `spatter_rate` (%, 0.8→15) | L2 | nozzle_clog + feeder 磨損的品質視覺 |
| 送絲 / 氣流讀數 | `wire_feed_rate`、`gas_flow` | L1 | 弧開時掉 → 對應退化線警示 |
| 電弧電壓讀數 | `arc_voltage` (V, 24→30) | L1 | torch_cable_aging 緩升 |
| 焊槍發熱輝光 | `torch_temp` (°C, 60→340) | L2 | |
| 累積焊道數 | `weld_count` | L1 | |
| 機台抖動 | `vibration_rms` (0.4→11) | L2 | |

### 4.16 `laser_cutter` — 雷射切割機(2026-08 新增)

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 切割頭 X / Y | `head_pos_x` (±150)、`head_pos_y` (±100 mm) | L1 | `/50`;沿矩形輪廓(引擎 `_rect_xy` 同一條參數式) |
| 光束開關 | `laser_power` (W, >1000 = 出光) | L1 | 與引擎不變量檢定同一條界線 |
| 切割節拍 | CUT_S = 24 s(常數) | L3 | 牆鐘週期 = `24 / multiplier`,夾住並標示 |
| 切割頭發熱輝光 | `lens_temp` (°C, 45→110) | L2 | protective_lens_fouling 的主視覺 |
| 冷卻水溫警示 | `chiller_temp` (°C, 22→36;>30 亮黃) | L1 | chiller_degradation |
| 切速讀數 | `cut_speed` (mm/s, 35→19) | L1 | 鏡片污損 → 降速補償 |
| 切口火花密度 / 顏色 | `dross_rate` (%, 0.5→12) | L2 | nozzle_wear 的品質視覺 |
| 輔助氣壓讀數 | `assist_gas_pressure` (bar) | L1 | |
| 累積切件數 | `cut_count` | L1 | |
| 機台抖動 | `vibration_rms` | L2 | |

### 4.17 `packaging_machine` — 包裝機(2026-08 新增)

| 視覺元素 | 引擎欄位 | 等級 | 映射 |
|----------|----------|------|------|
| 封口鉗開度 | `jaw_gap` (mm, 80 全開 → 0 閉合) | L1 | `/50`;上下鉗對開(引擎 `40·(1+cos ph)` 同一條參數式) |
| 封口節拍 | `cycle_time` (s, 15→19 隨加熱器老化變長) | L3 | 牆鐘週期 = `cycle_time / multiplier`,夾住並標示 |
| 封口鉗輝光 / 低溫警示 | `seal_temp` (°C, 145 設定點;<128 亮黃) | L2+L1 | 到不了設定點 = sealer_heater_aging |
| 膜卷轉動 / 出料前進 | `index_rate` (ppm, 4→3.2) | L3 | 與封口節拍同倍率 |
| 膜張力讀數 | `film_tension` (N, 45 ± 波動) | L1 | film_feed_wear → 波動變大 |
| 成品包外觀 | `reject_rate` (%, 0.4→15) | L2 | 皺摺變色(品質視覺) |
| 元件電流讀數 | `motor_current` (A) | L1 | |
| 累積包數 | `package_count` | L1 | |
| 機台抖動 | `vibration_rms` | L2 | |

---

### 4.12 廠內產線佈局(跨設備)

單台設備畫得再準,擺成一排各做各的,學生仍然看不出「這條線在做什麼」。
`web/src/world/processFlow.ts` 依製程角色排線:

| 角色 | template | 在線上的位置 |
|------|----------|--------------|
| `source` 產出 | CNC / 沖壓 / 射出 / 腔體 / 熱處理 | 主線左段 |
| `handler` 搬運 | 六軸手臂 / AGV | 主線中段 |
| `transport` 輸送 | 輸送帶 | 主線右段 |
| `utility` 廠務 | 空壓機 / 電表 / 風機 | **不佔主線**,排在後方 |

手臂轉 90° 讓取放兩點落在主線方向,取件點對到上游機台的出料側(伸進去 1.0 單位)、
放件點壓在輸送帶起點上。上下游有真機台接手時,手臂不再畫自己的料檯。
各機種的佔地半寬(`HALF_W`)是 `node preview/measure.mjs` 從真實場景量回來的,不是估的
—— 改過幾何或 `LINE_SCALE` 要重量一次。

> **誠實邊界(2026-07 更新)**:公司 YAML 有 `line:` 宣告的產線,引擎層**真的有工件
> 在流**(engine/line.py):上游完工進出料緩衝 → 手臂被授予搬運才跑取放循環 → 工件
> 落到下游入料緩衝 → 下游有料才加工;無料 / 滿料的站真的停(state=idle)。畫面上的
> 緩衝方塊(`BufferStack`)顆數 = 引擎帳 = Modbus FC04 的 `line_in_buffer` /
> `line_out_buffer` 讀值,手臂的 `cycle_count` = 實際搬運件數 —— 同一份資料,不做兩套。
> **沒有** `line:` 宣告的公司仍是空間上的對位:各機節拍獨立,前端不假裝同步。
>
> 緩衝方塊擺在 processFlow 算出的**手臂實際取放點**上(取件堆在上游出料側、放件在
> 下游入料 / 輸送帶起點),空間對位與物料帳在同一個點會合。終站輸送帶只畫 `on_belt`
> 件數、工件走完帶長(8 sim 秒)才算出貨;帶上沒工件時引擎讓輸送帶待機,不空轉。
>
> **看得見取放的方法**:×120 下一個手臂循環只有 0.07 牆鐘秒,離散動作本來就不可見
> (L3 的物理極限,不是 bug)。產線視圖對教師提供「🎬 慢速觀察 ×2」鈕(寫 sim 倍率),
> 慢速下「完工 → 待取堆高 → 手臂取件 → 放上輸送帶 → 送出出貨」全部用真實資料自然呈現。

CNC 在產線視圖套鈑金外殼(`enclosed`),讀起來才像一台機器;裸露的刀路動畫留給
點進去的詳情頁 —— 那是兩個不同的觀看層級。

### 4.13 CNC 刻痕的兩個坑

**字面朝向**:引擎 `pos_y` 對到世界 Z,而相機在 +Z 看向原點,所以**世界 +Z 在畫面上
是往下**。字母的「上緣」在引擎座標是 `y = -60`。用 +60 當上緣,畫出來是上下鏡像的
「И Ⅽ ∩ ⊥」。筆畫字型定義在 `engine/templates/_stroke_font.py::GLYPHS`,
前端 `deviceMotion.ts::STROKE_FONT` 必須逐點相同(相位鎖定要拿同一條刀路比對引擎
回報的座標);文字由 ⚙ `engrave_char_1..8` 生成,兩端都用同一套版面規則
(字寬 60 / 字距 40 / 超過 ±220 行程等比縮小)。

**刻痕補點要沿相位,不是沿畫面位置**。用「畫面位置移動超過門檻就放一顆」是 frame-rate
相依的:低幀率時一幀跨過大半個筆畫,一幀只放得到一顆 → 字變成散落的點;球放大到能連成
線又粗到把字糊掉。正確作法是把該幀走過的**相位區間**切細、逐點取同一條刀路曲線 ——
幀率再低疏密都一樣,轉角也不會被直線內插切掉。

## 5. 實作結構

```
web/src/world/
├── deviceMotion.ts      # ★ 資料橋:狀態正規化 / 健康度 / 時間換算 / delta 補間
├── MachineScene.tsx     # 共用 Canvas 外殼(燈光 / 環境 / 地板 / 控制器)——只在這裡出現一次
├── MachineFx.tsx        # 共用視覺語彙:柱燈 / 故障冒煙 / 抖動 / 換算倍率標示
├── FactoryLine3D.tsx    # 廠內產線:一個 Canvas 擺 N 台(燈光只有一組)
└── <Xxx>3D.tsx          # 每機種:export <Xxx>Model(純幾何,不含燈光)+ default(單機 Canvas)
```

**規則**:`<Xxx>Model` 內部**不得**出現 `<Environment>`、`<ContactShadows>`、`<ambientLight>`、
`<directionalLight>`、`<pointLight>`。這些只屬於 Canvas 層級 —— 否則 `FactoryLine3D` 放 N 台就會
建 N 份環境貼圖與陰影 render target,直接把 WebGL context 打爆。

---

## 6. 自動驗收

契約不是寫給人看爽的 —— [tests/animation](../tests/animation/README.md) 有一套端到端測試,
把 `engine.World.step()` 錄下來的**真實 telemetry** 一格一格餵進瀏覽器裡真正的 3D 元件,
再讀出 three.js 場景中機構的**實際世界座標**回來,與引擎的 tag 做線性回歸與還原誤差比對。

```bash
python3 tests/animation/capture_frames.py web/preview
cd web && npx vite &
node tests/animation/verify_animation.mjs        # 失敗回傳 exit 1
```

行程類的檢查(射出機模板、腔體晶圓)在頁面內用 `requestAnimationFrame` 取樣,不從
Node 輪詢 —— 這種「大部分時間停著、只在一小段快速移動」的機構,從 Node 每 120 ms
打一次 evaluate 會直接錯過行程頂點。即使如此,軟體渲染只跑到約 9 fps,量到的行程
仍是真實值的**下界**,所以腔體那項判「進片側與出片側都到達」而不是比對 span 有多接近
6.8 —— 要保證的性質是貫通,那個對幀率免疫。

最近一次結果:**38 項全數通過,11 種機型全覆蓋**(2026-08-03 新增三項**到位斷言**:
收斂後座標必須一格不差、下探最低幀夾爪落站、連續播放不等收斂時車體恆在路徑上 ——
線性回歸對「系統性落後一小段」不敏感,lag 會被吸收進截距,得用到位斷言才抓得到)。關鍵數字:

| 綁定 | 還原誤差 | 相關性 |
|------|----------|--------|
| CNC `pos_x` → 刀尖世界 X | max 1.60 / rms 0.62 mm(行程 ±220 mm) | R² 0.99999 |
| CNC `pos_y` → 刀尖世界 Z | max 4.59 / rms 1.24 mm | R² 0.99929 |
| CNC `pos_z` → 刀尖世界 Y | rms 3.56 mm;**抬刀 / 下刀 27/27 幀與正負號一致** | R² 0.98429 |
| 手臂 `joint_angle_1` → J1 世界 yaw | **最大偏差 0.00°**(90.5° 掃程) | — |
| 手臂 `joint_angle_2` → TCP 高度 | 單調下降 | R² 0.9995 |
| 手臂 `tcp_x` → 夾爪世界 X | max 3.02 / rms 1.67 mm(全長 1600 mm) | R² 0.99957 |
| 手臂 `tcp_y` → 夾爪世界 Z | max 6.26 / rms 2.36 mm | **R² 0.99999** |
| 手臂 `tcp_z` → 夾爪世界 Y | max 8.24 / rms 3.60 mm | R² 0.99988 |
| 手臂 畫面夾爪方位角 = `joint_angle_1` | **最大偏差 0.13°** | — |
| AGV `pos_x` / `pos_y` → 車體世界座標 | **max 0.00 m** | **R² 1.00000** |
| AGV `heading` → 車頭方位角 | **最大偏差 0.00°** | — |
| AGV 收斂後車體 ↔ 遙測座標(到位貼齊) | **最大距離 0.0000 m**(40 幀) | — |
| AGV 連續播放(不等收斂)車體離路徑距離 | **max 0.000 m**(115 幀全程取樣) | — |
| 手臂 下探最低幀夾爪 ↔ 取放站水平距離 | **0.007 單位(1.4 mm)** | — |
| 沖壓機 `ram_position` → 滑塊行程 | 3.000 / 3.0 單位 + 畫面標「動畫慢放 ×3.2」 | — |
| 輸送帶 `belt_speed` → 前進速率 | ×1 → 0.9976(契約 0.9976);×120 → 3.0000(契約 3.0000) | — |
| 風機 `rotor_rpm` / `pitch_angle` | 轉子 2.6 s 轉 169°;pitch −0.08°(未超額定,正確) | — |
| 空壓機 `outlet_pressure` → 錶針角度 | −26.95 °/bar(契約 −27) | **R² 1.0000** |
| 電表 `current_l1/l2/l3` → 三相長條 | max 0.04 A | R² 0.99995 |
| 熱處理爐 `heating_power` → 功率條 | 單調遞增 | **R² 1.0000** |
| 製程腔體 晶圓貫通式進出片 | 進片側到 −3.40、出片側到 3.29(設計 ±3.4) | — |
| 柱燈 `running` | 紅 0.04 / 黃 0.08 / **綠 1.80** | — |
| 柱燈 `fault` | **紅 2.40** / 黃 0.08 / 綠 0.04;閃爍暗相仍有 1.01 | — |
| 柱燈 `run_enable=0` | 紅 0.04 / **黃 2.00** / 綠 0.04 | — |
| 射出機 開模行程 | 1.966 / 2.0 單位 | — |
| 製程腔體 晶圓貫通行程 | 6.715 / 6.8 單位 | — |
| `run_enable=0` → 刀尖靜止 | **位移 0.00000**(停機前 1.199) | — |

另有場景層驗證 [`verify_scenario.py`](../tests/animation/verify_scenario.py) —— **不抽樣**,
把 `class_park`(65 廠 / 133 台)與 `default_park`(37 廠 / 72 台)整個載進引擎逐台檢查:
結構、3D 模型覆蓋、**本綁定表宣告的 72 個 tag 引擎是否真的有發**、跑 60 拍無 NaN/Inf、
producer 都運轉過、累積量只增不減。兩份場景皆全數通過。

**改動畫之後請重跑這套測試**;它同時是「3D 層不得依賴 CDN」的回歸防線
(`node preview/shot3d.mjs` 會攔到)。

## 7. 人工驗收清單

改完動畫後逐項對:

標 🤖 的已由自動測試涵蓋(CI 每次 PR 都跑),其餘要人眼看畫面。

- [ ] 🤖 每個會動的部位都能在本檔 §4 找到對應欄位。
      (`verify_scenario.py::check_binding_tags` 反過來驗:表裡宣告的 tag 引擎必須真的有發)
- [ ] 前端沒有任何一段程式在重算引擎已經算過的物理量。
      手臂的正運動學是例外 —— 關節模型本來就得靠 FK 擺姿勢,那是繪圖不是模擬。
      判準是**算出來的結果必須對得上引擎的 `tcp_x/y/z`**,由 §6 第 [13] 節把關。
- [ ] 🤖 所有補間都是 delta-based(`approach()` 一律要帶 `delta`;
      搜 `* 0.4)` 這類 frame-rate 相依寫法應為 0)。
- [ ] 所有 L3 換算都在畫面上標示了倍率。
- [ ] 🤖 `state = fault` / `coils.run_enable = false` 時機構真的停下來,而不只是換顏色。
      (§6 第 [12] 節:關掉 run_enable 後刀尖 1.2 s 內位移必須為 0)
- [ ] 🤖 柱燈語彙符合 §2:running 只亮綠、fault 亮紅且黃燈熄、run_enable=0 亮黃。
      (§6 第 [14] 節:直接讀三顆燈的 `emissiveIntensity` 峰值)
- [ ] `coils.run_enable = false` 時畫面看得出是「被停機」而非「剛好待機」。
      沖壓機打 STOPPED、風機葉片順槳並標 pitch 角 —— 這類語意標示要人眼確認。
- [ ] 🤖 Model 元件內沒有燈光 / 環境 / 陰影(`grep -E '<(Environment|ContactShadows|ambientLight|directionalLight|pointLight)' web/src/world/*3D.tsx` 應為空)。
- [ ] 🤖 `npx tsc -b` 通過。

視覺驗收可以用預覽頁批次出圖,不必手動點:

```bash
cd web && npx vite &
node preview/shot3d.mjs /tmp/shots     # 24 組情境逐台渲染成 png
```
