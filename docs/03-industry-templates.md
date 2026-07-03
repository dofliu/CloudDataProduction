# 03 · 產業設備型別庫

工業區內放多種**產業原型**,讓不同公司產生不同訊號特性,學生看見廣度。
每個 template = 一組標準 tag + 預設退化元件。實例化時自動配 unit_id / topic / node。

> 不放風電場(本案為工業區)。涵蓋:離散製造(CNC、機械手臂)、製程設備(半導體機台)、
> 物流(AGV)、廠務動力(空壓機、電表)。離散 vs 製程 vs 動力的對比很有教學價值。

每個設備至少含:狀態 `state`、若干製程/運轉 tag、若干與退化相關的健康指標 tag。
下列為各 template 的 tag 與退化元件規劃。

---

## CNC 加工中心 `cnc_machining_center`

| tag | 單位 | 說明 |
|-----|------|------|
| state | enum | idle / running / tool_change / alarm |
| spindle_speed | rpm | 主軸轉速 |
| spindle_load | % | 主軸負載 |
| spindle_current | A | 隨負載與軸承退化微升 |
| spindle_temp | °C | 一階熱滯後 |
| vibration_rms | mm/s | **軸承退化主指標** |
| axis_pos_x/y/z | mm | 三軸位置 |
| tool_wear | % | 由刀具退化元件映出(切削力 / 表面粗糙度替代量) |
| coolant_temp | °C | |
| part_count | count | 累積加工數 |
| cycle_time | s | 隨刀具磨耗微增 |

退化元件:`spindle_bearing`(exponential,慢)、`tool_wear`(linear,快、隨換刀重置)、
`ballscrew_backlash`(linear,很慢)。

---

## 6 軸機械手臂 `robot_arm_6axis`

| tag | 單位 | 說明 |
|-----|------|------|
| state | enum | idle / running / error / estop |
| joint_angle_1..6 | deg | 六軸角度 |
| joint_current_1..6 | A | 各軸電流 |
| joint_temp_1..6 | °C | 各軸溫度 |
| tcp_x/y/z | mm | 末端位置 |
| vibration_rms | mm/s | 諧波減速機退化指標 |
| cycle_count | count | 動作循環數 |

退化元件:`reducer_wear`(harmonic drive,exponential)、`joint_bearing`、`encoder_drift`(偏感測器型)。

---

## 半導體製程腔體 `semi_process_chamber`

製程設備代表,訊號最「細緻」,製程漂移很適合教 subtle fault。

| tag | 單位 | 說明 |
|-----|------|------|
| state | enum | idle / processing / maintenance / fault |
| chamber_pressure | mTorr | |
| chamber_temp | °C | |
| rf_power | W | |
| gas_flow_1..3 | sccm | 多支 MFC 氣體流量 |
| vacuum_pump_current | A | 真空泵退化指標 |
| pump_temp | °C | |
| wafer_count | count | 累積處理片數 |
| throughput | wph | 每小時片數 |
| particle_count | #/wafer | **良率指標**,隨製程漂移上升 |

退化元件:`vacuum_pump_wear`(exponential)、`process_drift`(wiener,推高 particle_count → 良率掉)、
`mfc_drift`(偏感測器型,氣流讀值漂移)。

---

## AGV / 自走搬運車 `agv_mobile_robot`

物流代表,有電池與移動特性。

| tag | 單位 | 說明 |
|-----|------|------|
| state | enum | idle / moving / charging / blocked / fault |
| battery_soc | % | 電量 |
| battery_voltage | V | |
| battery_temp | °C | |
| motor_current_l/r | A | 左右驅動電流 |
| motor_temp | °C | |
| speed | m/s | |
| pos_x/y | m | 廠區地圖座標(可在 2D 世界畫移動) |
| heading | deg | |
| payload | kg | 載重 |

退化元件:`battery_capacity_fade`(linear,慢,反映可用 SOC 上限下降)、`motor_bearing`、`wheel_wear`。

---

## 空壓機 `air_compressor`(廠務動力)

經典 PdM 目標,訊號乾淨好教,當入門設備很合適。

| tag | 單位 | 說明 |
|-----|------|------|
| state | enum | loaded / unloaded / fault |
| outlet_pressure | bar | |
| flow | m³/min | |
| motor_current | A | |
| motor_temp | °C | |
| vibration_rms | mm/s | 軸承退化指標 |
| running_hours | h | |

退化元件:`motor_bearing`(exponential)、`valve_wear`、`filter_clog`(linear,推高電流)。

---

## 電表 / 能源節點 `energy_meter`(園區動力 / OEE 用)

| tag | 單位 | 說明 |
|-----|------|------|
| active_power | kW | |
| voltage_l1/l2/l3 | V | |
| current_l1/l2/l3 | A | |
| power_factor | — | |
| energy_total | kWh | 累積 |

主要提供能耗 / 負載曲線分析素材;「異常耗電」以對 `active_power` 注入 sensor_bias / drift 實現,
當另類異常偵測題。實作另含一條極輕的 `capacitor_aging`(指標型,緩降 power_factor),給一條可訓練的退化線索;
duty 預設 `two_shift`,呈現日 / 週負載結構。OEE 欄位借用為「負載率 × 功因品質」的用電效率代理(非生產 OEE)。

---

## 沖壓機 `stamping_press`(離散製造,高噸位循環)

台中鈑金 / 沖壓聚落設備。本體故障 + 品質漂移雙線。

| tag | 單位 | 說明 |
|-----|------|------|
| state | enum | idle / running / fault |
| tonnage | ton | 沖壓噸位(離合器退化 → 波動變大) |
| stroke_rate | spm | 每分鐘行程數 |
| ram_position | mm | 滑塊位置(循環) |
| die_temp | degC | 模具溫度 |
| motor_current | A | 主馬達電流 |
| vibration_rms | mm/s | **clutch_brake_wear 退化主指標** |
| lubrication_pressure | bar | lube_pump_wear → 下滑 |
| burr_rate | % | **模具磨耗良率指標**,die_wear → 毛邊率上升 |
| stroke_count | count | 累積行程 |

退化元件:`clutch_brake_wear`(exponential,本體→振動升、噸位波動→fault)、
`die_wear`(linear 指標→毛邊率→良率掉,不 fault)、`lube_pump_wear`(指標→潤滑壓降)。

---

## 熱處理爐 `heat_treat_furnace`(製程 / 熱設備)

金屬退火 / 淬火 / 滲碳,連續運轉、熱慣性大。

| tag | 單位 | 說明 |
|-----|------|------|
| state | enum | idle / running / fault |
| furnace_temp | degC | 爐溫(元件老化 → 到不了設定點) |
| temp_uniformity | degC | **爐內溫差**,insulation 劣化 → 變大(良率指標) |
| chamber_pressure | mbar | |
| heating_power | kW | |
| element_current | A | **heating_element_aging 退化主指標**(電阻升 → 電流升) |
| atmosphere_flow | L/min | 保護氣氛流量 |
| oxygen_ppm | ppm | **殘氧**,seal_leak → 上升(良率指標) |
| energy_kwh | kWh | 累積能耗 |

退化元件:`heating_element_aging`(exponential,本體→電流升、供熱不足→燒斷 fault)、
`insulation_degradation`(linear 指標→溫度均勻性差 + 能耗升)、`seal_leak`(指標→殘氧上升)。

---

## 型別庫設計慣例

- 每個 template 是一個 `engine/templates/<name>.py`,匯出 tag schema、退化元件預設、duty cycle 預設。
- tag 必含協定映射欄位:`modbus_register`、`opcua_node`、`mqtt_field`(見 `docs/04`)。
- 實例化多台時(如「5 套機械手臂」),自動遞增 unit_id / node folder / topic,值域 / 個體差異用 `sigma` 與 `init_health` 隨機化。
- 建議 P1 先完成 **CNC + 空壓機 + AGV**(離散 + 動力 + 移動三型),半導體腔體與機械手臂列 P1 後段。
