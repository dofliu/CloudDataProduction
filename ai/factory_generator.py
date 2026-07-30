"""自然語言建廠(docs/06)。

把「建一間有 3 台 CNC 的公司」這類描述 → 公司 + 設備設定,交給 world.add_company 熱載入。

兩條路徑,同一套欄位驗證:
  1. **LLM(Gemini)** —— 設了 `GEMINI_API_KEY` 時優先。可讀自由描述、**一句話建多型別工廠**
     (規則式只能單一 template),如「半導體封裝廠:3 台手臂、2 台製程腔體、1 台電表」。
     走 REST(urllib,免加 SDK 依賴),要求結構化 JSON 輸出。
  2. **規則式** —— 沒 key / LLM 任何失敗(斷網、逾時、解析錯、無有效設備)時的回退。離線可用、可預期。

安全:LLM 產出**絕不照單全收** —— template 限白名單、count 夾限、duty 檢核、id 由本模組配,
才餵給 world.add_company。
"""
from __future__ import annotations

import json as _json
import os
import re
import urllib.request

# 關鍵字 → template(只含已實作的 template)。注意:含子字串的關鍵字要避免誤判。
_TEMPLATE_KEYWORDS = {
    "cnc": "cnc_machining_center", "加工中心": "cnc_machining_center", "工具機": "cnc_machining_center",
    "空壓機": "air_compressor", "壓縮機": "air_compressor", "compressor": "air_compressor",
    "agv": "agv_mobile_robot", "搬運車": "agv_mobile_robot", "自走車": "agv_mobile_robot",
    "機械手臂": "robot_arm_6axis", "手臂": "robot_arm_6axis", "robot_arm": "robot_arm_6axis",
    "robot": "robot_arm_6axis", "六軸": "robot_arm_6axis",
    "半導體": "semi_process_chamber", "腔體": "semi_process_chamber", "製程機": "semi_process_chamber",
    "chamber": "semi_process_chamber",
    "電表": "energy_meter", "電錶": "energy_meter", "能源": "energy_meter", "能耗": "energy_meter",
    "meter": "energy_meter",
    "沖壓": "stamping_press", "沖床": "stamping_press", "press": "stamping_press", "鈑金": "stamping_press",
    "熱處理": "heat_treat_furnace", "爐": "heat_treat_furnace", "furnace": "heat_treat_furnace", "退火": "heat_treat_furnace",
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
    "semi_process_chamber": {
        "vacuum_pump_wear": {"rate": 0.0000009, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
        "process_drift": {"rate": 0.0000016, "trajectory": "wiener", "sigma": 0.35, "init_health": 1.0, "causes_device_fault": False},
    },
    "energy_meter": {
        "capacitor_aging": {"rate": 0.0000006, "trajectory": "linear", "sigma": 0.1, "init_health": 1.0, "causes_device_fault": False},
    },
    "stamping_press": {
        "clutch_brake_wear": {"rate": 0.0000011, "trajectory": "exponential", "k": 3.0, "sigma": 0.1, "init_health": 0.93},
        "die_wear": {"rate": 0.0000016, "trajectory": "linear", "sigma": 0.15, "init_health": 1.0, "causes_device_fault": False},
    },
    "heat_treat_furnace": {
        "heating_element_aging": {"rate": 0.0000009, "trajectory": "exponential", "k": 2.6, "sigma": 0.1, "init_health": 0.94},
        "insulation_degradation": {"rate": 0.0000013, "trajectory": "linear", "sigma": 0.12, "init_health": 1.0, "causes_device_fault": False},
    },
}
_PREFIX = {"cnc_machining_center": "cnc", "air_compressor": "comp",
           "agv_mobile_robot": "agv", "robot_arm_6axis": "arm",
           "semi_process_chamber": "chamber", "energy_meter": "em",
           "stamping_press": "press", "heat_treat_furnace": "furnace"}

# LLM 路徑用:全 8 template 的 id 前綴 + 給模型的白話說明(讓它把自由描述映到最接近的型別)。
# 不放 degradation —— 省略時各 template 會用自己的預設 + 個體差異抖動(見 templates/_common.build_components)。
_ALL_PREFIX = {
    "cnc_machining_center": "cnc", "air_compressor": "comp", "agv_mobile_robot": "agv",
    "robot_arm_6axis": "arm", "injection_molding": "im", "semi_process_chamber": "chamber",
    "energy_meter": "em", "stamping_press": "press", "heat_treat_furnace": "furnace",
    "wind_turbine": "wt",
}
_TEMPLATE_DESC = {
    "cnc_machining_center": "CNC 加工中心 / 工具機(主軸、刀具磨耗、軸承振動)",
    "air_compressor": "空壓機 / 壓縮機(廠務動力,馬達軸承、濾網)",
    "agv_mobile_robot": "AGV 自走搬運車 / 物流(電池、驅動馬達)",
    "robot_arm_6axis": "六軸機械手臂 / 自動組裝(諧波減速機、關節)",
    "injection_molding": "塑膠射出成型機(鎖模力、料管溫、液壓泵)",
    "semi_process_chamber": "半導體製程腔體 / 鍍膜機(真空泵、製程漂移→良率)",
    "energy_meter": "電表 / 能源節點 / 變電(三相電壓電流、功因、能耗)",
    "stamping_press": "沖壓機 / 沖床 / 鈑金(噸位、離合器/煞車、模具磨耗→毛邊)",
    "heat_treat_furnace": "熱處理爐 / 退火爐(爐溫、加熱元件老化、保溫/密封→均勻性)",
    "wind_turbine": "風力發電機(風速-功率曲線、齒輪箱)",
}
_DUTY = ("continuous", "single_shift", "two_shift")

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


def _parse_multi(text: str) -> list[tuple[str, int]]:
    """解析多型別描述:「2 台 CNC、1 支手臂、1 台 CNC」→ [(cnc,2), (arm,1), (cnc,1)]。

    依關鍵字在描述中的**出現位置**排序(描述順序 = 產線站序);每個關鍵字往前找
    數量詞(阿拉伯或中文數字),找不到當 1 台。單一型別時退回舊行為(_rule_based)。
    """
    low = text.lower()
    hits: list[tuple[int, str, int]] = []       # (位置, template, count)
    used_spans: list[tuple[int, int]] = []
    for kw, tmpl in _TEMPLATE_KEYWORDS.items():
        for m in re.finditer(re.escape(kw), low):
            s, e = m.span()
            if any(not (e <= us or s >= ue) for us, ue in used_spans):
                continue                        # 已被更早配對的關鍵字涵蓋(如「機械手臂」vs「手臂」)
            used_spans.append((s, e))
            head = text[max(0, s - 8):s]        # 往前找數量詞
            count = 1
            mm = re.search(r"(\d+)\s*[台臺套部支座]?\s*$", head)
            if mm:
                count = int(mm.group(1))
            else:
                for ch, n in _CH_NUM.items():
                    if re.search(ch + r"\s*[台臺套部支座]?\s*$", head):
                        count = n
                        break
            hits.append((s, tmpl, max(1, min(20, count))))
    hits.sort()
    # 「機械手臂」會同時命中「機械手臂」與「手臂」等子字串 —— used_spans 已擋掉重疊;
    # 這裡再壓掉同位置重複的 template
    out: list[tuple[str, int]] = []
    for _, tmpl, count in hits:
        out.append((tmpl, count))
    return out


# 產線推導(與 scenarios/scripts/gen_class_park.py 的規則一致):
# producer + 手臂 + (producer 或輸送帶)就接成引擎物料流(engine/line.py)。
_LINE_PRODUCERS = {"cnc_machining_center", "injection_molding",
                   "stamping_press", "semi_process_chamber"}


def _derive_line(devices: list[dict]) -> list[str] | None:
    producers = [d["id"] for d in devices if d["template"] in _LINE_PRODUCERS]
    arms = [d["id"] for d in devices if d["template"] == "robot_arm_6axis"]
    convs = [d["id"] for d in devices if d["template"] == "conveyor"]
    if not arms:
        return None
    if len(producers) >= 2:
        return [producers[0], arms[0], producers[1]]
    if len(producers) == 1 and convs:
        return [producers[0], arms[0], convs[0]]
    return None


def generate_factory(description: str, existing_company_ids: list[str] | None = None) -> dict:
    """回傳可餵給 world.add_company 的公司設定。

    設了 GEMINI_API_KEY → 先試 LLM(可建多型別);任何失敗回退規則式。
    規則式解析不出 template 時丟 ValueError(交由上層轉 422)。
    """
    if os.getenv("GEMINI_API_KEY"):
        try:
            res = _llm_factory(description)
        except Exception as exc:            # 斷網 / 逾時 / 解析錯 → 不影響課堂,靜默回退規則式
            print(f"[factory] LLM 建廠失敗,回退規則式:{exc}")
        else:
            if res and res.get("devices"):
                res.setdefault("line", _derive_line(res["devices"]))
                return res
    cfg = _rule_based_factory(description)
    cfg.setdefault("line", _derive_line(cfg["devices"]))   # 建得成產線就接上物料流
    return cfg


def _rule_based_factory(description: str) -> dict:
    """規則式:關鍵字挑 template + 數量。免 key、離線、可預期。

    支援**多型別**描述(如「2 台 CNC、1 支手臂」→ 依描述順序建 3 台),
    單一型別時行為與先前相同。
    """
    multi = _parse_multi(description)
    if not multi:
        raise ValueError(
            "無法從描述判斷設備類型。目前支援:CNC(加工中心)、空壓機、AGV(搬運車)、"
            "機械手臂、半導體製程腔體、電表(能源節點)、沖壓、熱處理爐。"
            "例:『建一間有 3 台 CNC 的公司』或『2 台 CNC 加 1 支手臂』"
        )
    if len(multi) == 1:                     # 單一型別:沿用整句數量解析(涵蓋「三套」等寫法)
        multi = [(multi[0][0], _parse_count(description))]
    name = _parse_name(description) or (
        f"AI 新建廠（{multi[0][0]}）" if len(multi) == 1 else "AI 新建廠(多型別產線)")

    devices = []
    seq: dict[str, int] = {}
    for template, count in multi:
        prefix = _PREFIX.get(template, template[:4])
        for _ in range(count):
            seq[template] = seq.get(template, 0) + 1
            devices.append({
                "id": f"{prefix}-ai{seq[template]:02d}",
                "template": template,
                "duty_cycle": {"profile": "continuous"},
                "degradation": {k: dict(v) for k, v in _DEFAULT_DEGRADATION.get(template, {}).items()},
            })

    summary = "、".join(f"{c} 台 {t}" for t, c in multi)
    return {
        "name": name,
        "industry": multi[0][0],
        "devices": devices,
        "_summary": f"{name}:{summary}",
        "_via": "rule",
    }


def _strip_fences(text: str) -> str:
    """保險:去掉模型偶爾包的 ```json ... ``` 圍欄。"""
    t = text.strip()
    if t.startswith("```"):
        t = t.strip("`").strip()
        if t[:4].lower() == "json":
            t = t[4:].strip()
    return t


def _llm_factory(description: str) -> dict | None:
    """LLM(Gemini REST)建廠:自由描述 → 多型別設備。回傳 None 表示應回退規則式。"""
    from engine.templates import available_templates   # 延遲載入,避免匯入期循環

    key = os.getenv("GEMINI_API_KEY")
    if not key:
        return None
    model = os.getenv("GEMINI_MODEL", "gemini-flash-latest")   # 自動追最新 flash;可用 .env 覆寫
    avail = [t for t in available_templates() if t in _ALL_PREFIX]
    desc_lines = "\n".join(f"- {t}:{_TEMPLATE_DESC.get(t, '')}" for t in avail)
    prompt = (
        "你是工廠建置助手。根據使用者描述,規劃這間公司要放哪些設備。\n"
        "只能從下列設備型別(template)挑,選語意最接近的;描述沒提到的別亂加:\n"
        f"{desc_lines}\n\n"
        f"使用者描述:「{description}」\n\n"
        "輸出 JSON:公司名 name、產業 industry、devices 陣列(每項 template、count、duty)。"
        "count 為 1~20;duty 取 continuous / single_shift / two_shift 之一"
        "(製程 / 廠務 / 能源類多用 continuous,離散加工多用 two_shift)。"
        "沒指定數量時每型別給 1~2 台。"
    )
    schema = {
        "type": "object",
        "properties": {
            "name": {"type": "string"},
            "industry": {"type": "string"},
            "devices": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "template": {"type": "string", "enum": avail},
                        "count": {"type": "integer"},
                        "duty": {"type": "string", "enum": list(_DUTY)},
                    },
                    "required": ["template", "count"],
                },
            },
        },
        "required": ["name", "devices"],
    }
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json", "responseSchema": schema, "temperature": 0.2},
    }
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"
    req = urllib.request.Request(url, data=_json.dumps(body).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=20) as resp:
        payload = _json.loads(resp.read().decode("utf-8"))
    text = payload["candidates"][0]["content"]["parts"][0]["text"]
    data = _json.loads(_strip_fences(text))

    # ── 嚴格驗證 + 展開(絕不照單全收 LLM)──────────────────
    avail_set = set(avail)
    devices, per = [], {}
    for g in data.get("devices", []) or []:
        tmpl = g.get("template")
        if tmpl not in avail_set:
            continue
        cnt = max(1, min(20, int(g.get("count", 1) or 1)))
        duty = g.get("duty") if g.get("duty") in _DUTY else "continuous"
        for _ in range(cnt):
            per[tmpl] = per.get(tmpl, 0) + 1
            devices.append({
                "id": f"{_ALL_PREFIX[tmpl]}-ai{per[tmpl]:02d}",
                "template": tmpl,
                "duty_cycle": {"profile": duty},   # 省略 degradation → 用 template 預設 + 抖動
            })
    if not devices:
        return None
    name = (str(data.get("name") or "").strip() or "AI 新建廠")[:30]
    industry = (str(data.get("industry") or "").strip() or "mixed")[:30]
    summary = "、".join(f"{per[t]} 台 {t}" for t in dict.fromkeys(d["template"] for d in devices))
    return {"name": name, "industry": industry, "devices": devices,
            "_summary": f"{name}:{summary}", "_via": "llm"}
