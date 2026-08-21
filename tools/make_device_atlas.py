"""設備動畫圖鑑產生器:把 preview 截圖 + 動畫綁定契約組成一份圖文文件。

產出 `docs/設備動畫圖鑑.md` 與 `docs/images/device_atlas/*.webp` —— **不要手改那兩者**,
要調內容改這支再重跑(與 scenarios/scripts/gen_*.py 同一套慣例)。

三個資料來源都是 repo 的既有事實,不另外編:
  · 截圖  = web/preview/models3d.html 逐案渲染(shot3d.mjs / shotline.mjs)
  · 綁定  = docs/animation_binding.md §4 的逐機種綁定表
  · 退化  = engine/templates/*.py 的 _DEFAULT_DEGRADATION

用法(兩步,第一步要瀏覽器):

    cd web && npx vite --port 5173 &
    node preview/shot3d.mjs   /tmp/atlas          # 32 張機台情境
    node preview/shotline.mjs /tmp/atlas cnc inj press weld laserpack aoi agv mixed
    cd .. && python3 tools/make_device_atlas.py --shots /tmp/atlas

Pillow 有裝就轉 webp(約 1/6 大小);沒裝則直接複製 PNG,文件照樣產得出來。
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
IMG_DIR = ROOT / "docs" / "images" / "device_atlas"
OUT_MD = ROOT / "docs" / "設備動畫圖鑑.md"

# ── 機型資料 ────────────────────────────────────────────────
# shots 的 case index 對應 web/preview/models3d.tsx 的 CASES 順序;
# 那份清單**只在尾端追加**(新增機型加在最後),所以既有索引不會位移。
#
# (template, 中文名, 一句話, [(視覺元素, 引擎欄位, 等級)],
#  [(退化元件, 型態, 徵兆)], [(case index, 檔名後綴, 圖說)])
MACHINES = [
    ("cnc_machining_center", "CNC 加工中心",
     "三軸刀路直接吃引擎座標,刻字內容由學生寫 setpoint 決定。", [
         ("主軸座 X / 龍門 Z / 主軸頭升降", "`pos_x` · `pos_y` · `pos_z`", "L1"),
         ("刻字文字(pattern 0)", "⚙ `engrave_char_1..8`", "L1"),
         ("主軸旋轉", "`spindle_speed`", "L3"),
         ("火花密度與顏色", "`tool_wear`", "L2"),
     ], [
         ("spindle_bearing", "本體 · exponential", "振動 RMS 走高 → 最終停機 fault"),
         ("tool_wear", "指標 · linear", "切削力與循環時間上升、火花變紅(設備不會 fault)"),
     ], [(0, "healthy", "健康:刀尖沿刻字刀路走,火花細而金黃"),
         (1, "degraded", "軸承退化 + 刀鈍:機台抖動、火花變多變紅"),
         (22, "fault", "故障閂鎖:機構立即停轉、柱燈轉紅閃爍並冒煙")]),

    ("stamping_press", "沖壓機",
     "滑塊高度直接用 `ram_position`,不再自己跑 sin 曲線。", [
         ("滑塊高度", "`ram_position`", "L1"),
         ("行程節拍", "`stroke_rate`", "L3"),
         ("下死點火花", "`ram_position` < 8 mm", "L1"),
         ("工件毛邊外觀", "`burr_rate`", "L2"),
     ], [
         ("clutch_brake_wear", "本體 · exponential", "振動升、噸位波動變大"),
         ("die_wear", "指標 · linear", "毛邊率上升 → 良率掉"),
         ("lube_pump_wear", "指標 · linear", "潤滑壓力下滑,低於 2 bar 亮黃燈"),
     ], [(8, "healthy", "健康:滑塊落到下死點,撞擊火花四濺"),
         (9, "degraded", "模具磨耗 + 潤滑不足:工件邊緣毛躁變暗、潤滑燈轉黃"),
         (23, "stopped", "教師停機(run_enable=0):滑塊停上死點、柱燈黃燈慢閃")]),

    ("injection_molding", "射出成型機",
     "循環相位由射出壓力與鎖模力反推,不另跑一套計時。", [
         ("循環相位(鎖模 / 射出 / 冷卻 / 開模)", "`injection_pressure` · `clamping_force`", "L1"),
         ("循環週期", "`cycle_time`", "L3"),
         ("熔膠顏色 / 料管發熱", "`barrel_temp_1..4`", "L2"),
         ("累積模數", "`shot_count`", "L1"),
     ], [
         ("screw_wear", "指標 · linear", "循環時間拉長 → 產能掉"),
         ("heater_drift", "指標 · linear", "料管溫度偏移 → 成品品質不穩"),
         ("hydraulic_pump", "本體 · exponential", "油溫升、壓力建立變慢 → fault"),
     ], [(10, "healthy", "健康:射出段壓力峰值,可動模板閉合"),
         (11, "degraded", "螺桿磨耗:循環拉長、油溫輝光變強")]),

    ("semi_process_chamber", "半導體製程腔體",
     "電漿輝光與微粒污染是兩條不同的線:一條看得見,一條殺良率。", [
         ("電漿輝光強度", "`rf_power`", "L2"),
         ("腔壓顯示 / 抽氣粒子", "`chamber_pressure`", "L1"),
         ("三路 MFC 氣體流線", "`gas_flow_1/2/3`", "L1"),
         ("腔內微粒污染", "`particle_count`", "L2"),
     ], [
         ("vacuum_pump_wear", "本體 · exponential", "泵電流升、腔壓抽不下去 → fault"),
         ("process_drift", "指標 · wiener", "微粒暴增 → 良率掉,機構訊號完全正常"),
     ], [(18, "healthy", "健康:電漿穩定、晶圓貫通進出片"),
         (19, "degraded", "製程漂移:腔內微粒暴增(subtle fault,設備不會停)")]),

    ("heat_treat_furnace", "熱處理爐",
     "爐溫到不到得了設定點,就是加熱元件老化的直接證據。", [
         ("爐膛火光顏色 / 強度", "`furnace_temp`", "L2"),
         ("爐內溫差熱斑", "`temp_uniformity`", "L2"),
         ("加熱功率條 / 元件電流錶", "`heating_power` · `element_current`", "L1"),
         ("殘氧警示", "`oxygen_ppm`", "L2"),
     ], [
         ("heating_element_aging", "本體 · exponential", "電流升、到不了 900 °C → 燒斷 fault"),
         ("insulation_degradation", "指標 · linear", "爐內溫差變大 + 能耗升"),
         ("seal_leak", "指標 · linear", "殘氧上升 → 保護氣氛失效"),
     ], [(20, "healthy", "健康:爐溫到 897 °C,爐膛均勻亮橘"),
         (21, "degraded", "元件老化 + 洩漏:爐溫掉、熱斑不均、殘氧警示")]),

    ("welding_cell", "焊接機器人工作站",
     "電弧開關由 `arc_current` 判定 —— 遙測說有弧才畫弧,不猜相位。", [
         ("焊槍沿焊道 / 道別", "`torch_pos_x` · `torch_pos_y`", "L1"),
         ("電弧開關", "`arc_current` > 100 A", "L1"),
         ("飛濺粒子密度", "`spatter_rate`", "L2"),
         ("焊槍發熱輝光", "`torch_temp`", "L2"),
     ], [
         ("wire_feeder_wear", "本體 · exponential", "送絲率下滑 + 電流波動 → 斷弧 fault"),
         ("nozzle_clog", "指標 · linear", "保護氣流量掉 → 飛濺升(對症是清潔,不是換件)"),
         ("torch_cable_aging", "指標 · linear", "電弧電壓緩升,機構訊號正常"),
     ], [(26, "healthy", "健康:電弧沿焊道前進,飛濺細少"),
         (27, "degraded", "噴嘴堵 + 送絲磨損:飛濺暴增、氣流量掉到 10 L/min")]),

    ("laser_cutter", "雷射切割機",
     "光束開關由 `laser_power` 判定,與引擎的不變量檢定同一條界線。", [
         ("切割頭沿矩形輪廓", "`head_pos_x` · `head_pos_y`", "L1"),
         ("光束開關", "`laser_power` > 1000 W", "L1"),
         ("切割頭發熱輝光", "`lens_temp`", "L2"),
         ("切口火花密度 / 顏色", "`dross_rate`", "L2"),
     ], [
         ("protective_lens_fouling", "本體 · exponential", "鏡溫升 + 切速降 → 切不斷 fault"),
         ("chiller_degradation", "指標 · linear", "冷卻水溫升 → 雷射源降額保護"),
         ("nozzle_wear", "指標 · linear", "氣壓波動 → 掛渣率上升"),
     ], [(28, "healthy", "健康:光束沿輪廓出光,切速 34.6 mm/s"),
         (29, "degraded", "鏡片污損 + 冷卻劣化:鏡溫 88 °C、切速掉到 24.8")]),

    ("aoi_inspection", "AOI 光學檢測站",
     "檢測站說不良,不代表工件真的不良 —— 量測系統本身也會劣化。", [
         ("相機龍門蛇形掃描", "`camera_pos_x` · `camera_pos_y`", "L1"),
         ("環形光源亮度 / 檢測光斑", "`light_intensity`", "L1"),
         ("鏡頭霧化", "`focus_score`(反向)", "L2"),
         ("掃描節拍", "`inspect_time`", "L3"),
     ], [
         ("stage_bearing", "本體 · exponential", "振動升、掃描節拍變長 → fault"),
         ("lens_contamination", "指標 · linear", "focus 下滑 → 誤判率升"),
         ("led_aging", "指標 · linear", "光源衰減 → 誤判率也升(要靠兩支 tag 分離根因)"),
     ], [(24, "healthy", "健康:focus 95、誤判率 0.7 %"),
         (25, "degraded", "鏡頭污染 + 光源衰減:focus 掉到 66、誤判率 9.4 %")]),

    ("packaging_machine", "包裝機",
     "產線終站:封口溫度到不了設定點,就是加熱器老化。", [
         ("封口鉗開合", "`jaw_gap`(80 → 0 mm)", "L1"),
         ("封口鉗輝光 / 低溫警示", "`seal_temp`(設定點 145 °C)", "L2"),
         ("膜卷轉動 / 出料前進", "`index_rate`", "L3"),
         ("成品包外觀", "`reject_rate`", "L2"),
     ], [
         ("sealer_heater_aging", "本體 · exponential", "封口溫度到不了設定點 + 節拍變長 → fault"),
         ("film_feed_wear", "指標 · linear", "膜張力波動變大"),
         ("cutter_blade_wear", "指標 · linear", "切口毛邊 → 不良率的另一條徵兆"),
     ], [(30, "healthy", "健康:封口鉗閉合、封口溫度 144.6 °C"),
         (31, "degraded", "加熱器老化:溫度只到 118 °C、不良率 7.8 %")]),

    ("robot_arm_6axis", "六軸機械手臂",
     "六軸角度全用,末端位置由引擎正運動學算出,畫面必須對得上。", [
         ("J1~J6 關節角", "`joint_angle_1..6`", "L1"),
         ("末端位置校驗", "`tcp_x` / `tcp_y` / `tcp_z`", "L1"),
         ("取放兩站位置", "⚙ `pick_x` · `pick_y` · `place_x` · `place_y`", "L1"),
         ("循環計數(= 實際搬運件數)", "`cycle_count`", "L1"),
     ], [
         ("reducer_wear", "本體 · exponential", "諧波減速機磨耗 → 振動升 → fault"),
         ("joint_bearing", "指標 · exponential", "關節發熱 + 定位精度下滑"),
     ], [(2, "healthy", "健康:取件姿態,夾爪落在取料站上方"),
         (3, "degraded", "減速機退化:機身抖動明顯")]),

    ("agv_mobile_robot", "AGV 搬運車",
     "車體補間走弧長鎖定,任何時刻都在巡迴路徑上,不切轉角。", [
         ("車體位置", "`pos_x` · `pos_y`", "L1"),
         ("車頭朝向", "`heading`", "L1"),
         ("輪子轉動", "`speed`", "L1"),
         ("電量顯示 / 低電紅字", "`battery_soc`", "L1"),
     ], [
         ("motor_bearing", "本體 · exponential", "振動升、馬達發熱 → fault"),
         ("battery_capacity_fade", "指標 · linear", "續航掉、充電變頻繁"),
     ], [(4, "healthy", "健康:載貨移動中,車體恆在巡迴路線上"),
         (5, "docked", "停靠上料站:到位貼齊,與遙測座標零誤差")]),

    ("conveyor", "輸送帶",
     "產線終站只畫引擎帳上的件數,空帶就是空的 —— 不空轉。", [
         ("皮帶捲動 / 工件前進", "`belt_speed`", "L1"),
         ("帶上工件數", "`line_on_belt`(FC04)", "L1"),
         ("馬達負載輝光", "`motor_current`", "L2"),
         ("機身抖動", "`vibration_rms`(低門檻)", "L2"),
     ], [
         ("bearing_wear", "本體 · exponential", "振動 + 電流同步升高 → fault"),
         ("tension_loss", "指標 · linear", "皮帶張力下滑 → 打滑"),
     ], [(6, "healthy", "健康:皮帶等速捲動,工件依帳上件數前進"),
         (7, "degraded", "軸承退化:振動與馬達電流同步升高")]),

    ("air_compressor", "空壓機",
     "電流高但流量低 —— 兩支訊號交叉,才讀得出濾網阻塞。", [
         ("壓力錶指針", "`outlet_pressure`", "L1"),
         ("壓力設定點紅線", "⚙ `pressure_setpoint`", "L1"),
         ("出風流量粒子", "`flow`", "L2"),
         ("飛輪 / 活塞往復", "`state` + `motor_current`", "L3"),
     ], [
         ("motor_bearing", "本體 · exponential", "振動升、馬達溫度爬升 → fault"),
         ("filter_clog", "指標 · linear", "流量掉但電流升(交叉徵兆)"),
     ], [(14, "healthy", "健康:出口壓力貼著設定點紅線"),
         (15, "degraded", "濾網阻塞 + 軸承退化:電流升、風量掉")]),

    ("energy_meter", "智慧電表",
     "三相分開顯示,不平衡才看得出來;功因是唯一的退化指標。", [
         ("三相電壓 / 電流", "`voltage_l1/l2/l3` · `current_l1/l2/l3`", "L1"),
         ("有效功率讀數", "`active_power`", "L1"),
         ("功因(<0.85 黃 / <0.75 紅)", "`power_factor`", "L1"),
         ("累積電能", "`energy_total`", "L1"),
     ], [
         ("capacitor_aging", "指標 · linear", "功因下滑 → 無效電流升、電費變貴"),
     ], [(16, "healthy", "健康:三相平衡、功因 0.95 以上"),
         (17, "degraded", "電容老化:功因下滑,三相長條看得出不平衡")]),

    ("wind_turbine", "風力發電機",
     "順槳角是「被停機」與「沒風」的分界,一眼看得出來。", [
         ("轉子轉速", "`rotor_rpm`", "L1"),
         ("葉片槳距角", "`pitch_angle`(0 工作 / 88 順槳)", "L1"),
         ("發電量顯示", "`power_output`", "L1"),
         ("機艙 / 齒輪箱發熱", "`generator_temp` · `gearbox_temp`", "L2"),
     ], [
         ("gearbox_wear", "本體 · exponential", "齒輪箱溫度與振動升 → fault"),
         ("generator_bearing", "指標 · exponential", "發電機軸承發熱"),
     ], [(12, "healthy", "健康:葉片工作角,穩定發電"),
         (13, "stopped", "教師停機:葉片順槳 88°,畫面標示 pitch 角")]),

    # ── 鑄造 / 鍛造上游(2026-08-21:手工具製程主要流程圖的「原料與成形」段)──
    ("melting_furnace", "熔煉爐",
     "爐體傾轉出湯直接吃 `tilt_angle`;爐殼由灰轉暗紅就是「該重砌爐襯」。", [
         ("爐體傾轉", "`tilt_angle`", "L1"),
         ("熔湯液面高度", "`bath_level`", "L1"),
         ("熔湯色溫", "`melt_temp`", "L2"),
         ("爐殼暗紅", "`shell_temp`", "L2"),
         ("浮渣厚度", "`slag_ratio`", "L2"),
     ], [
         ("refractory_wear", "本體 · exponential", "爐殼外壁溫升 + 同功率維持不住爐溫 → 最終 fault"),
         ("electrode_wear", "指標 · linear", "電極電流震盪幅度變大、出湯節拍拉長"),
         ("slag_buildup", "指標 · linear", "含渣量升 → 下游鑄件夾渣(清渣即恢復,不是換爐)"),
     ], [(32, "healthy", "健康:爐體傾轉出湯,熔湯白熾、爐殼仍是灰色"),
         (33, "degraded", "爐襯磨蝕 + 爐渣:爐殼轉暗紅、浮渣變厚、爐溫掉到 1387 °C")]),

    ("die_casting_machine", "壓鑄機",
     "兩側模溫分開上色 —— 溫差拉開就是模具熱疲勞,真空燈轉紅則是密封劣化。", [
         ("移動模板開合", "`clamping_force`", "L2"),
         ("射出衝頭前進", "`shot_speed` > 0.3", "L1"),
         ("兩側模板輝光", "`die_temp_fixed` · `die_temp_moving`", "L2"),
         ("真空指示燈", "`vacuum_level`", "L1"),
     ], [
         ("hydraulic_accumulator", "本體 · exponential", "射出速度掉、循環拉長 → 最終壓不動 fault"),
         ("die_thermal_fatigue", "指標 · linear", "兩側模溫差拉開 → 縮孔率升"),
         ("vacuum_seal_wear", "指標 · linear", "真空抽不下去 → 氣孔率升"),
     ], [(34, "healthy", "健康:鎖模 347 ton、真空 67 mbar、兩側模溫幾乎相同"),
         (35, "degraded", "熱疲勞 + 真空劣化:模溫差 37 °C、真空 232 mbar、縮孔與氣孔都破 6%")]),

    ("induction_heater", "感應加熱爐",
     "棒料位置是本地重建(引擎沒給位置 tag,標倍率不假裝 L1);出料色溫是 L1。", [
         ("棒料沿軌前進", "(無位置 tag)", "**L3**"),
         ("出料棒料色溫", "`billet_temp_out`", "L1"),
         ("線圈輝光", "`coil_current`", "L2"),
         ("冷卻水管亮度", "`cooling_flow`", "L2"),
         ("漏電警示燈", "`leakage_current`", "L1"),
     ], [
         ("coil_insulation", "本體 · exponential", "漏電流升 + 功因掉 → 絕緣失效 fault"),
         ("cooling_scale", "指標 · linear", "水路結垢 → 流量掉、線圈溫升 → 降額運轉"),
         ("coupling_drift", "指標 · linear", "出料溫度偏低**且分散變大** → 鍛件摺疊裂紋"),
     ], [(36, "healthy", "健康:出料 1181 °C 白熾,漏電流 2 mA、功因 0.95"),
         (37, "degraded", "絕緣劣化 + 結垢:出料只剩 1072 °C(不足)、漏電流 39.7 mA")]),

    ("forging_press", "鍛造壓機",
     "滑塊吃 `ram_position`;欠肉看鍛模、壓入氧化皮看除鱗壓力 —— 對症不同。", [
         ("滑塊位置", "`ram_position`", "L1"),
         ("滑塊偏擺", "`ram_deviation`", "L2"),
         ("鍛件色溫", "`billet_temp_in`", "L1"),
         ("鍛件欠肉(變小)", "`underfill_rate`", "L2"),
         ("除鱗噴霧大小", "`descale_pressure`", "L2"),
     ], [
         ("ram_guide_wear", "本體 · exponential", "偏擺變大 + 振動升 → 最終咬死 fault"),
         ("die_wear", "指標 · linear", "欠肉率升(除鱗壓力正常)→ 換 / 修鍛模"),
         ("descaler_clog", "指標 · linear", "除鱗壓力掉 → 壓入氧化皮(清噴嘴,不是換模具)"),
     ], [(38, "healthy", "健康:下死點 1520 ton 成形,鍛件紅熱、除鱗噴霧飽滿"),
         (39, "degraded", "鍛模磨耗 + 噴嘴堵:偏擺 1.42 mm、欠肉 7.6%、氧化皮 8.2%")]),

    ("trimming_press", "毛胚整修機",
     "刀口鈍化時**切斷力先升、殘毛刺後升** —— 兩個指標的時間差就是這台的教學重點。", [
         ("滑塊位置", "`slide_position`", "L1"),
         ("刀座輝光(切斷力)", "`trim_force`", "L2"),
         ("工件邊緣毛刺", "`burr_height`", "L2"),
         ("頂桿伸出量", "`ejector_stroke`", "L1"),
     ], [
         ("slide_bearing_wear", "本體 · exponential", "振動升 + 節拍拉長 → 最終咬死 fault"),
         ("trim_die_edge", "指標 · linear", "切斷力**先**升、殘毛刺**後**超規(規格 0.15 mm)"),
         ("ejector_wear", "指標 · linear", "頂出行程不足 → 變形不良"),
     ], [(40, "healthy", "健康:切斷力 214 ton、毛刺 0.03 mm(規格內),飛邊落進料箱"),
         (41, "degraded", "刀口鈍化:切斷力 336 ton、毛刺 0.35 mm 超規、變形率 5.2%")]),
]

GROUPS = [
    ("切削 · 成形",
     "把原料變成形狀的機台。共同語彙:位置類 tag 直接畫、指標型退化打在良率上。",
     ["cnc_machining_center", "stamping_press", "injection_molding",
      "semi_process_chamber", "heat_treat_furnace"]),
    ("接合 · 下料 · 檢測 · 包裝",
     "2026-08 新增的四種機型。共同教學重點:量測與製程本身也會劣化,而且不一定讓機器停下來。",
     ["welding_cell", "laser_cutter", "aoi_inspection", "packaging_machine"]),
    ("搬運 · 輸送",
     "讓工件在站與站之間真實流動的機構。畫面上的件數 = 引擎帳 = 學生 Modbus 讀到的數字。",
     ["robot_arm_6axis", "agv_mobile_robot", "conveyor"]),
    ("鑄造 · 鍛造上游(原料與成形)",
     "2026-08-21 依「手工具製程主要流程圖」補的前段。共同語彙:溫度是主角 —— "
     "熔湯、棒料、鍛模的顏色就是製程狀態,而爐殼與模具的溫度則是「該保養了」的徵候。",
     ["melting_furnace", "die_casting_machine", "induction_heater",
      "forging_press", "trimming_press"]),
    ("廠務 · 能源",
     "不參與工件流動,但決定整廠能不能跑。故障徵兆常常要靠兩支訊號交叉才讀得出來。",
     ["air_compressor", "energy_meter", "wind_turbine"]),
]

LINES = [
    ("cnc", "CNC 加工 → 手臂取放 → 輸送帶出料", "machine_tool / precision_parts 的主力配方"),
    ("inj", "射出成型 → 手臂取放 → 輸送帶出料", "plastics 配方;手臂取件點對到射出機出料側"),
    ("press", "沖壓成形 → 手臂取放", "metal_forming 配方,兩站直接交接"),
    ("weld", "焊接接合 → 手臂取放 → 輸送帶出料", "新產業 c66 的配方"),
    ("laserpack", "雷射切割 → 手臂取放 → 包裝出貨", "新產業 c67:包裝機當產線終站"),
    ("aoi", "射出成型 → 手臂取放 → AOI 檢測", "新產業 c68:全檢線"),
    ("agv", "CNC 加工 → AGV 搬運 → 輸送帶出料", "AGV compact 模式:巡迴路線縮尺 0.25 並畫縮小標線"),
    ("casting", "熔煉出湯 → 手臂 → 壓鑄成形 → 手臂 → 輸送帶出料",
     "c70 / x01-f4 的五站鑄造線:熔煉爐是全線瓶頸(72 s 一籃)"),
    ("forging", "感應加熱 → 手臂 → 熱模鍛造 → 手臂 → 切邊整修",
     "c71 / x01-f5 的五站鍛造線:出料溫度是第一個品質關卡"),
    ("mixed", "混合壓力測試", "七台同場:驗證燈光只有一組、佈局不互相穿模"),
]


# ── 圖檔搬運 ────────────────────────────────────────────────
def place_image(src: Path, dst_stem: str, quality: int) -> str:
    """把來源截圖放進 docs/images/device_atlas/,回傳檔名。有 Pillow 就轉 webp。"""
    try:
        from PIL import Image
    except ImportError:
        dst = IMG_DIR / f"{dst_stem}.png"
        shutil.copyfile(src, dst)
        return dst.name
    im = Image.open(src).convert("RGB")
    if im.width > 1000:                       # 產線圖 1280 寬 → 文件內 1000 就夠讀
        im = im.resize((1000, round(im.height * 1000 / im.width)), Image.LANCZOS)
    dst = IMG_DIR / f"{dst_stem}.webp"
    im.save(dst, "WEBP", quality=quality, method=6)
    return dst.name


def main() -> None:
    ap = argparse.ArgumentParser(description="產生設備動畫圖鑑(docs/設備動畫圖鑑.md)")
    ap.add_argument("--shots", required=True,
                    help="截圖目錄(shot3d.mjs / shotline.mjs 的輸出:m3d_NN.png 與 line_*.png)")
    ap.add_argument("--quality", type=int, default=82, help="webp 品質(預設 82)")
    args = ap.parse_args()

    shots = Path(args.shots)
    missing = [f"m3d_{i:02d}.png" for m in MACHINES for i, _, _ in m[5]
               if not (shots / f"m3d_{i:02d}.png").exists()]
    missing += [f"line_{k}.png" for k, _, _ in LINES if not (shots / f"line_{k}.png").exists()]
    if missing:
        sys.exit(f"截圖缺少 {len(missing)} 張(先跑 shot3d.mjs / shotline.mjs):{missing[:5]}")

    IMG_DIR.mkdir(parents=True, exist_ok=True)
    for old in IMG_DIR.glob("*"):             # 重跑要乾淨,不留上一版的殘檔
        old.unlink()

    by_id = {m[0]: m for m in MACHINES}
    n_shots = sum(len(m[5]) for m in MACHINES)

    L: list[str] = [
        "# 設備動畫圖鑑",
        "",
        "> ⚠ 本平台所有數據皆為**合成(synthetic)教學資料**,非任何真實場域量測。",
        "> 截圖由 `web/preview` 逐案渲染,畫面內的讀數即為引擎當下發出的遙測值。",
        "",
        "虛擬工業園區的 **20 種產業機型**,每一種都以「健康 ↔ 劣化」對照呈現。",
        "畫面上每一個會動的部位,都對應引擎的一支具體 tag ——",
        "學生用 Modbus 讀到的數字,必須與眼前看到的位置一致。",
        "",
        f"| 機型 | 機台情境截圖 | 產線佈局 | 綁定 tag | 動畫一致性檢查 |",
        "|---|---|---|---|---|",
        f"| {len(MACHINES)} 種 | {n_shots} 張 | {len(LINES)} 張 | 115 支(全數驗過)| 48 項全過 |",
        "",
        "**本檔由 `tools/make_device_atlas.py` 產生,要調內容請改那支再重跑。**",
        "",
        "---",
        "",
        "## 怎麼讀這份圖鑑",
        "",
        "每台機器的「動畫綁定」欄位標了三種等級(定義見 "
        "[animation_binding.md](animation_binding.md) §1)。",
        "這是動畫的誠信底線:可以為了看得清楚而縮放,但不可以假裝沒縮放。",
        "",
        "| 等級 | 意義 | 驗收方式 |",
        "|---|---|---|",
        "| **L1** 直接映射 | 畫面幾何量 = 資料值(僅換單位)| 用 Modbus 讀該 tag,值必須與畫面位置一致 |",
        "| **L2** 比例映射 | 連續量 → 視覺強度,單調遞增、值域明確 | 值變大,視覺一定變強,不可反轉 |",
        "| **L3** 時間換算 | 因顯示極限而降頻 / 慢放 | **畫面上必須標出倍率**,學生才知道被縮放的是畫面不是資料 |",
        "",
        "柱燈語彙(所有機種一致):",
        "",
        "- 🟢 `running` —— 機構運轉,只有綠燈亮",
        "- 🔴 `fault` —— 機構立即停止,紅燈閃爍、黃燈熄滅(故障不可讀成警告)",
        "- 🟡 `stopped` —— 教師寫 `run_enable=0`,黃燈慢閃(與自然待機區分)",
        "",
        "---",
        "",
        "## 機型逐台對照",
        "",
        "同一台機器的兩張圖,差別只在隱藏健康狀態。所有可見的變化 —— 抖動、火花顏色、讀數、警示燈",
        "—— 都是退化經由訊號模型傳導出來的結果,不是另外畫上去的效果。",
        "",
    ]

    for title, desc, ids in GROUPS:
        L += [f"### {title}", "", desc, ""]
        for mid in ids:
            tmpl, name, one, binds, degs, plates = by_id[mid]
            L += [f"#### {name} `{tmpl}`", "", one, ""]
            for idx, suffix, cap in plates:
                fn = place_image(shots / f"m3d_{idx:02d}.png", f"{tmpl}_{suffix}", args.quality)
                L += [f"![{name} — {cap}](images/device_atlas/{fn})", "", f"*{cap}*", ""]
            L += ["| 視覺元素 | 引擎欄位 | 等級 |", "|---|---|---|"]
            L += [f"| {el} | {tag} | {lv} |" for el, tag, lv in binds]
            L += ["", "退化線與徵兆:", ""]
            L += [f"- **`{nm}`**({ty})—— {sx}" for nm, ty, sx in degs]
            L += [""]

    L += [
        "---",
        "",
        "## 產線佈局",
        "",
        "單台機器畫得再準,擺成一排各做各的,仍然看不出「這條線在做什麼」。",
        "有 `line:` 宣告的公司,工件在引擎內**真實流動**:上游完工進緩衝、手臂被授予搬運才動作、",
        "下游有料才加工。畫面上的緩衝方塊顆數 = 引擎帳 = Modbus FC04 `line_in/out_buffer` 讀值。",
        "",
    ]
    for key, flow, note in LINES:
        fn = place_image(shots / f"line_{key}.png", f"line_{key}", args.quality)
        L += [f"### {flow}", "", note, "",
              f"![{flow}](images/device_atlas/{fn})", ""]

    L += [
        "---",
        "",
        "## 這些畫面怎麼驗",
        "",
        "動畫不是「看起來很忙」就算數。[`tests/animation`](../tests/animation/README.md) 把引擎真實跑出來的",
        "telemetry 逐幀餵進瀏覽器裡真正的 3D 元件,再讀回 three.js 場景中機構的**實際世界座標**,",
        "與引擎 tag 做線性回歸與還原誤差比對 —— 一次抓出接錯 tag、軸向對調、換算比例錯、符號反了。",
        "目前 **48 項全數通過,15 種機型全覆蓋**。",
        "",
        "| 項目 | 位置 |",
        "|---|---|",
        "| 動畫綁定契約(唯一依據)| [`docs/animation_binding.md`](animation_binding.md) |",
        "| 逐幀一致性驗證 | `tests/animation/verify_animation.mjs` |",
        "| 逐廠逐台場景驗證(不抽樣)| `tests/animation/verify_scenario.py` |",
        "| 截圖工具(同時是「3D 層不得依賴 CDN」的回歸防線)| `web/preview/shot3d.mjs`、`shotline.mjs` |",
        "| 本文件產生器 | `tools/make_device_atlas.py` |",
        "",
    ]

    OUT_MD.write_text("\n".join(L), encoding="utf-8")
    n_img = len(list(IMG_DIR.glob("*")))
    size = sum(p.stat().st_size for p in IMG_DIR.glob("*")) / 1e6
    print(f"寫入 {OUT_MD.relative_to(ROOT)}")
    print(f"      {n_img} 張圖 → {IMG_DIR.relative_to(ROOT)}/({size:.2f} MB)")


if __name__ == "__main__":
    main()
