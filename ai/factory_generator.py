"""自然語言建廠(docs/06)。

把「建一間有 3 台 CNC 的公司」這類描述 → 公司 + 設備設定,交給 world.add_company 熱載入。

預設走**規則式解析**(免 LLM key、離線可用、結果可預期);
若設了 GEMINI_API_KEY 則可改走 LLM(此處先留接點)。產出一律經過同一套欄位驗證。
"""
from __future__ import annotations

import re

# 關鍵字 → template(只含已實作的 template)。注意:含子字串的關鍵字要避免誤判。
_TEMPLATE_KEYWORDS = {
    "cnc": "cnc_machining_center", "加工中心": "cnc_machining_center", "工具機": "cnc_machining_center",
    "空壓機": "air_compressor", "壓縮機": "air_compressor", "compressor": "air_compressor",
    "agv": "agv_mobile_robot", "搬運車": "agv_mobile_robot", "自走車": "agv_mobile_robot",
    "機械手臂": "robot_arm_6axis", "手臂": "robot_arm_6axis", "robot_arm": "robot_arm_6axis",
    "robot": "robot_arm_6axis", "六軸": "robot_arm_6axis",
}

# 各 template 的預設退化元件(讓新設備會自然退化,與場景一致)
_DEFAULT_DEGRADATION = {
    "cnc_machining_center": {
        "spindle_bearing": {"rate": 0.0000011, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
        "tool_wear": {"rate": 0.0000014, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    },
    "air_compressor": {
        "motor_bearing": {"rate": 0.0000010, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
        "filter_clog": {"rate": 0.0000018, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    },
    "agv_mobile_robot": {
        "motor_bearing": {"rate": 0.0000011, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
        "battery_capacity_fade": {"rate": 0.0000008, "trajectory": "linear", "sigma": 0.1, "init_health": 1.0, "causes_device_fault": False},
    },
    "robot_arm_6axis": {
        "reducer_wear": {"rate": 0.0000010, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.94},
        "joint_bearing": {"rate": 0.0000009, "trajectory": "exponential", "k": 2.5, "sigma": 0.12, "init_health": 0.96, "causes_device_fault": False},
    },
}
_PREFIX = {"cnc_machining_center": "cnc", "air_compressor": "comp",
           "agv_mobile_robot": "agv", "robot_arm_6axis": "arm"}

_CH_NUM = {"一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}


def _parse_count(text: str) -> int:
    m = re.search(r"(\d+)\s*[台臺套部]", text)
    if m:
        return max(1, min(20, int(m.group(1))))
    for ch, n in _CH_NUM.items():
        if re.search(ch + r"\s*[台臺套部]", text):
            return n
    return 1


def _parse_template(text: str) -> str | None:
    low = text.lower()
    for kw, tmpl in _TEMPLATE_KEYWORDS.items():
        if kw in low:
            return tmpl
    return None


def _parse_name(text: str) -> str | None:
    m = re.search(r"(?:叫|名為|名叫|公司名?[為叫:：]?)\s*([\w一-鿿]{2,10})", text)
    return m.group(1) if m else None


def generate_factory(description: str, existing_company_ids: list[str] | None = None) -> dict:
    """回傳可餵給 world.add_company 的公司設定。解析不出 template 會丟 ValueError。"""
    template = _parse_template(description)
    if template is None:
        raise ValueError(
            "無法從描述判斷設備類型。目前支援:CNC(加工中心)、空壓機、AGV(搬運車)。"
            "例:『建一間有 3 台 CNC 的公司』"
        )
    count = _parse_count(description)
    name = _parse_name(description) or f"AI 新建廠（{template}）"
    prefix = _PREFIX[template]

    devices = []
    for i in range(1, count + 1):
        devices.append({
            "id": f"{prefix}-ai{i:02d}",
            "template": template,
            "duty_cycle": {"profile": "continuous"},
            "degradation": {k: dict(v) for k, v in _DEFAULT_DEGRADATION[template].items()},
        })

    return {
        "name": name,
        "industry": template,
        "devices": devices,
        "_summary": f"{name}:{count} 台 {template}",
    }
