"""處置 / 保養動作字典 —— 學生面的「維修手冊」。

本檔只有**靜態知識與純函式**,不持有任何設備狀態(鐵則一):誰壞了、修好沒有,一律問引擎。

為什麼要有這一層:先前工單的 resolve 是「按一下就修好」,學生不必判斷,處置變成打卡。
改成必須**選一個處置動作**之後,resolve 才有教學意義 ——

  - 選對 → 修好,佔用該動作的維修工時(停機)。
  - 選錯 → **設備照樣是壞的**,但拆檢的工時照樣算,可用率照樣掉(白花)。
  - `overhaul`(整機大修)一定修得好,但停機最久 —— 給診斷不出來的人一條保底路,
    代價寫在可用率上。「可以不診斷,但要付錢」本身就是要教的事。

每個動作帶 `signature`(這種故障**在數據上長什麼樣**),學生要先看資料再選動作。
這份 signature 就是課堂教材:對照 docs/02 的訊號模型,振動走高 ≠ 壓差上升 ≠ 讀值脫鉤。
"""
from __future__ import annotations

from typing import Dict, List, Optional

# 動作字典。duration_h 是**模擬小時**的維修停機(對 sim_clock 積,不對 wall clock)。
# 停機期間設備不產出且計入可用率損失,所以「工時長 = 代價大」是誠實反映在 OEE 上的。
REPAIR_ACTIONS: Dict[str, dict] = {
    "replace_bearing": {
        "label": "更換軸承",
        "duration_h": 6.0,
        "signature": "振動 RMS 持續走高,常伴隨溫度上升;負載沒變但振動變大,停機再開仍不改善。",
    },
    "replace_wear_part": {
        "label": "更換磨耗件(刀具 / 模具 / 刀刃 / 螺桿 / 皮帶)",
        "duration_h": 3.0,
        "signature": "切削力 / 扭矩 / 電流緩步上升,良率或尺寸精度下滑;振動變化相對不明顯。",
    },
    "clean_filter": {
        "label": "清潔 / 更換濾網",
        "duration_h": 2.0,
        "signature": "壓差或出口壓力上升、流量 / 風量下降,溫度跟著爬升。",
    },
    "service_fluid_system": {
        "label": "液壓 / 真空 / 潤滑系統保養",
        "duration_h": 5.0,
        "signature": "壓力建立變慢或壓不上去、洩漏率上升、循環時間拉長。",
    },
    "recalibrate_process": {
        "label": "製程參數重新校正",
        "duration_h": 4.0,
        "signature": "製程量測值整體偏移(溫度 / 流量 / 厚度),但機構訊號(振動 / 電流)正常。",
    },
    "replace_electrical": {
        "label": "更換電氣元件",
        "duration_h": 5.0,
        "signature": "電流 / 功因 / 絕緣阻抗異常,電池或電容容量衰退;機械訊號正常。",
    },
    "calibrate_sensor": {
        "label": "感測器校正 / 更換",
        "duration_h": 1.5,
        "signature": "單一訊號與其他相關訊號**脫鉤**:卡住不動、整條平移、或憑空出現漂移;"
                     "但同機其他訊號與產出一切正常。",
    },
    "reline_refractory": {
        "label": "重砌 / 修補耐火爐襯",
        "duration_h": 24.0,
        "signature": "爐殼外壁溫度一路上升、同樣功率維持不住熔湯溫度;爐溫與功率的關係整個走樣。"
                     "這是熱設備最貴的一次停機 —— 拖到爐襯破損就不是停一天而已。",
    },
    "clear_blockage": {
        "label": "清除堆積 / 疏通(爐渣 / 氧化皮 / 噴嘴 / 水路結垢)",
        "duration_h": 2.0,
        "signature": "流量或壓力掉、堆積物指標(含渣量 / 氧化皮)升,但驅動端的電流與振動都正常 ——"
                     "機構沒壞,是通道被堵住了。清乾淨就恢復,換件是白花錢。",
    },
    "replace_bath_chemistry": {
        "label": "更換 / 調配製程槽液(清洗液 · 鍍液)",
        "duration_h": 8.0,
        "signature": "槽液本身的指標走樣:導電度 / pH 單調漂移、鍍層孔隙率或殘留污染升;"
                     "但泵、整流器、加熱器的電氣訊號都正常 —— 機器沒壞,是**液**該換了。",
    },
    "replenish_anode": {
        "label": "補掛 / 更換陽極",
        "duration_h": 3.0,
        "signature": "陽極質量掉到下限、電流密度不足、槽電壓上升(同樣電流要更高電壓推),"
                     "鍍層因此變薄。整流器紋波正常 —— 電源是好的,是**料**消耗完了。",
    },
    "overhaul": {
        "label": "整機大修(不需診斷)",
        "duration_h": 24.0,
        "signature": "萬用解:一定修得好,但停機最久、可用率代價最大。診斷不出來時的保底手段。",
    },
}

# 退化元件 → 對症動作。元件名見 engine/templates/*.py 的 degradation 預設。
# tests/test_repair_actions.py 會檢查「場景裡出現的每個元件都在這裡有對應(且不是 overhaul)」,
# 新增產業模板時若忘了補這張表,CI 會擋下來。
_COMPONENT_ACTION: Dict[str, str] = {
    # 軸承類
    "spindle_bearing": "replace_bearing",
    "motor_bearing": "replace_bearing",
    "joint_bearing": "replace_bearing",
    "generator_bearing": "replace_bearing",
    "bearing_wear": "replace_bearing",
    "stage_bearing": "replace_bearing",
    # 磨耗件
    "tool_wear": "replace_wear_part",
    "die_wear": "replace_wear_part",
    "blade_erosion": "replace_wear_part",
    "screw_wear": "replace_wear_part",
    "wheel_wear": "replace_wear_part",
    "clutch_brake_wear": "replace_wear_part",
    "gearbox_wear": "replace_wear_part",
    "reducer_wear": "replace_wear_part",
    "tension_loss": "replace_wear_part",
    "wire_feeder_wear": "replace_wear_part",
    "nozzle_wear": "replace_wear_part",
    "protective_lens_fouling": "replace_wear_part",   # 雷射保護鏡片是耗材,污損即換
    "film_feed_wear": "replace_wear_part",
    "cutter_blade_wear": "replace_wear_part",
    # 濾網 / 流阻
    "filter_clog": "clean_filter",
    "nozzle_clog": "clean_filter",           # 焊槍噴嘴飛濺堆積:清潔即恢復氣護
    # 流體系統(液壓 / 真空 / 潤滑 / 氣密)
    "seal_leak": "service_fluid_system",
    "valve_wear": "service_fluid_system",
    "hydraulic_pump": "service_fluid_system",
    "chiller_degradation": "service_fluid_system",   # 雷射冷卻迴路
    "vacuum_pump_wear": "service_fluid_system",
    "lube_pump_wear": "service_fluid_system",
    # 製程漂移(讀值真的變了,不是感測器騙人)
    "heater_drift": "recalibrate_process",
    "heating_element_aging": "recalibrate_process",
    "mfc_drift": "recalibrate_process",
    "process_drift": "recalibrate_process",
    "lens_contamination": "recalibrate_process",     # AOI 鏡頭清潔 + 光學重校
    # 電氣
    "capacitor_aging": "replace_electrical",
    "insulation_degradation": "replace_electrical",
    "battery_capacity_fade": "replace_electrical",
    "led_aging": "replace_electrical",
    "torch_cable_aging": "replace_electrical",
    "sealer_heater_aging": "replace_electrical",
    "coil_insulation": "replace_electrical",          # 感應線圈絕緣:漏電流升、功因掉
    # 耐火 / 堆積(2026-08-21 鑄造 / 鍛造上游)
    "refractory_wear": "reline_refractory",
    "slag_buildup": "clear_blockage",                 # 爐渣:清渣即恢復,不是換爐
    "descaler_clog": "clear_blockage",                # 除鱗噴嘴堵:清噴嘴,不是換鍛模
    "cooling_scale": "clear_blockage",                # 冷卻水路結垢:除垢即恢復流量
    "electrode_wear": "replace_wear_part",            # 電極是消耗品
    "die_thermal_fatigue": "replace_wear_part",       # 壓鑄模熱疲勞龜裂
    "trim_die_edge": "replace_wear_part",             # 切邊刀口鈍化
    "ejector_wear": "replace_wear_part",
    "ram_guide_wear": "replace_wear_part",            # 滑塊導軌 / 銅板
    "hydraulic_accumulator": "service_fluid_system",
    "vacuum_seal_wear": "service_fluid_system",
    "coupling_drift": "recalibrate_process",          # 線圈耦合走樣:重新校正加熱配方
    # 手工具後段(2026-08-22)
    "spindle_bearing_wear": "replace_bearing",
    "pump_bearing_wear": "replace_bearing",
    "abrasive_wear": "replace_wear_part",             # 砂輪 / 拋光輪是消耗品
    "dust_extraction_clog": "clean_filter",           # 集塵管路堵:清管路,不是換主軸
    "bath_contamination": "replace_bath_chemistry",   # 清洗液髒了:換液
    "bath_aging": "replace_bath_chemistry",           # 鍍液老化:調 / 換鍍液
    "nozzle_clog": "clear_blockage",                  # 噴嘴堵:疏通即恢復
    "heater_aging": "replace_electrical",             # 烘乾加熱器老化
    "rectifier_aging": "replace_electrical",          # 整流器老化:紋波升 + 自身發熱
    "anode_consumption": "replenish_anode",           # 陽極消耗:補掛,不是換鍍液
    "drive_motor_wear": "replace_bearing",
    "press_actuator_wear": "replace_bearing",
    # 感測器漂移:**量測系統**的病。修機構沒有用,要校正 ——
    # 這是 torque_tester 刻意設計的陷阱(退回率升 ≠ 上游品質變差)。
    "torque_sensor_drift": "calibrate_sensor",
    "fixture_wear": "replace_wear_part",              # 夾具磨耗 → 打滑
    "feeder_jam": "clear_blockage",                   # 振動盤卡料:清一清,不是換伺服
    "screwdriver_torque_drift": "recalibrate_process",  # 電動起子扭力衰退:重設 / 校正
}

# 關鍵字後援:新模板取了沒登記的元件名時,盡量還是猜得到對症動作,
# 而不是直接掉到 overhaul(那會讓學生「只有大修有效」,失去診斷的意義)。
_KEYWORD_ACTION = (
    ("bearing", "replace_bearing"),
    ("filter", "clean_filter"),
    ("drift", "recalibrate_process"),
    ("heater", "recalibrate_process"),
    ("heating", "recalibrate_process"),
    ("seal", "service_fluid_system"),
    ("valve", "service_fluid_system"),
    ("pump", "service_fluid_system"),
    ("hydraulic", "service_fluid_system"),
    ("vacuum", "service_fluid_system"),
    ("capacitor", "replace_electrical"),
    ("insulation", "replace_electrical"),
    ("battery", "replace_electrical"),
    ("wear", "replace_wear_part"),
    ("erosion", "replace_wear_part"),
    ("loss", "replace_wear_part"),
)

# 感測器層故障(engine/sensor_faults.py)一律靠校正處理 —— 它不動 health,修機構沒有用。
SENSOR_ACTION = "calibrate_sensor"
# 萬用動作:一定成功,但工時最長。
UNIVERSAL_ACTION = "overhaul"


def action_for_component(component_name: str) -> str:
    """退化元件 → 對症的處置動作。查不到就用關鍵字猜;真的猜不到才回 overhaul。"""
    if component_name in _COMPONENT_ACTION:
        return _COMPONENT_ACTION[component_name]
    low = component_name.lower()
    for kw, action in _KEYWORD_ACTION:
        if kw in low:
            return action
    return UNIVERSAL_ACTION


def is_known_action(action: str) -> bool:
    return action in REPAIR_ACTIONS


def duration_h(action: str) -> float:
    return float(REPAIR_ACTIONS.get(action, {}).get("duration_h", 1.0))


def manual(include_universal: bool = True) -> List[dict]:
    """公開維修手冊(學生面):動作 id / 名稱 / 工時 / 數據上的徵候。**不含**哪台設備該用哪個 ——
    那要學生自己從資料判斷,所以這份手冊給出去不會洩答案。"""
    return [
        {"action": a, "label": s["label"], "duration_h": s["duration_h"], "signature": s["signature"]}
        for a, s in REPAIR_ACTIONS.items()
        if include_universal or a != UNIVERSAL_ACTION
    ]


def describe(action: str) -> Optional[dict]:
    spec = REPAIR_ACTIONS.get(action)
    return {"action": action, **spec} if spec else None
