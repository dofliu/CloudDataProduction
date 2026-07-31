"""產生課堂場景 scenarios/class_park.yaml。

為什麼用產生器而不是手改 YAML:64 廠 × 每廠 1~3 台設備要「組合多樣 + 產業邏輯合理 +
全部 11 種 template 都出現」,手改很難保證,也很難重現。這支腳本把規則寫死,
跑一次就得到同一份檔案,規則要調也只改這裡。

設計原則
  1. 一人一廠(c01~c64),外加一間上下料示範廠(c65)。
  2. 每廠至少一台 **producer**(會生產、會退化,學生才有東西可診斷)。
  3. 設備組合要符合該產業的工程邏輯 —— 射出廠配輸送帶出料、半導體廠配 AGV 搬晶圓、
     熱處理廠配大電力電表,而不是隨機湊。
  4. 全部 11 種 template 都必須出現(先前版本缺 conveyor 與 wind_turbine)。
  5. 公司名為**虛構**的台灣精密製造業者。不用真實公司名 —— 這些廠會「故障」,
     資料全是合成的,掛真實廠商名字會變成對真實企業的不實陳述(見 CLAUDE.md 鐵則二)。

用法:
    python3 scenarios/scripts/gen_class_park.py            # 寫回 scenarios/class_park.yaml
    python3 scenarios/scripts/gen_class_park.py --check    # 只驗規則,不寫檔
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "scenarios" / "class_park.yaml"

# ── 產業原型:每個原型有數種設備配方,輪流套用讓組合分散 ────────────────
#    recipe 的第一台一定是 producer(主力機台)。
ARCHETYPES = {
    "machine_tool": {
        "label": "工具機加工",
        "products": ["CNC 立式加工中心", "CNC 車銑複合", "五軸加工中心", "精密模具加工"],
        "recipes": [
            ["cnc_machining_center", "energy_meter"],              # 加工 + 用電監測
            ["cnc_machining_center", "robot_arm_6axis", "conveyor"],   # 手臂下料到輸送帶
            ["cnc_machining_center", "conveyor"],                  # 加工完出料
            ["cnc_machining_center", "air_compressor"],            # 廠務氣源
            ["cnc_machining_center", "cnc_machining_center", "robot_arm_6axis"],
            ["cnc_machining_center", "conveyor", "energy_meter"],
        ],
    },
    "precision_parts": {
        "label": "精密零件",
        "products": ["航太結構件", "自行車傳動件", "工具機滾珠螺桿", "醫療器械零件"],
        "recipes": [
            ["cnc_machining_center", "conveyor"],
            ["cnc_machining_center", "energy_meter"],
            ["cnc_machining_center", "robot_arm_6axis", "conveyor"],
            ["cnc_machining_center", "heat_treat_furnace"],        # 加工後熱處理
        ],
    },
    "metal_forming": {
        "label": "沖壓鈑金",
        "products": ["汽車鈑金件", "電子機殼沖壓", "五金沖壓件", "散熱片沖壓"],
        "recipes": [
            ["stamping_press", "energy_meter"],
            ["stamping_press", "conveyor"],                        # 沖完直接出料
            ["stamping_press", "robot_arm_6axis", "conveyor"],     # 手臂取件到輸送帶
            ["stamping_press", "air_compressor"],                  # 氣壓頂料
            ["stamping_press", "conveyor", "energy_meter"],
            ["stamping_press", "stamping_press", "conveyor"],      # 雙機連線
        ],
    },
    "plastics": {
        "label": "塑膠射出",
        "products": ["家電外殼射出", "汽車內飾件", "精密齒輪射出", "醫材塑件"],
        "recipes": [
            ["injection_molding", "air_compressor"],
            ["injection_molding", "conveyor"],                     # 頂出落料到輸送帶
            ["injection_molding", "robot_arm_6axis", "conveyor"],  # 取件機下料到輸送帶
            ["injection_molding", "energy_meter"],                 # 射出耗電大
            ["injection_molding", "robot_arm_6axis", "conveyor"],
            ["injection_molding", "injection_molding", "energy_meter"],
        ],
    },
    "semiconductor": {
        "label": "半導體製程",
        "products": ["晶圓蝕刻製程", "薄膜沉積製程", "封測前段製程", "化合物半導體製程"],
        "recipes": [
            ["semi_process_chamber", "robot_arm_6axis", "semi_process_chamber"],   # 晶圓傳送手臂串兩腔
            ["semi_process_chamber", "agv_mobile_robot"],          # AGV 搬晶圓盒
            ["semi_process_chamber", "air_compressor"],            # 無塵室廠務
            ["semi_process_chamber", "energy_meter"],
            ["semi_process_chamber", "semi_process_chamber", "agv_mobile_robot"],
        ],
    },
    "heat_treat": {
        "label": "熱處理",
        "products": ["真空熱處理", "滲碳淬火", "退火軟化處理", "時效硬化處理"],
        "recipes": [
            ["heat_treat_furnace", "air_compressor"],
            ["heat_treat_furnace", "agv_mobile_robot"],            # 料籃搬運
            ["heat_treat_furnace", "energy_meter"],                # 爐子是耗電大戶
            ["heat_treat_furnace", "conveyor"],
            ["heat_treat_furnace", "heat_treat_furnace", "energy_meter"],
        ],
    },
    "motion_robotics": {
        "label": "自動化系統",
        "products": ["機械手臂整合", "取放系統整合", "視覺檢測工作站", "產線自動化"],
        "recipes": [
            ["cnc_machining_center", "robot_arm_6axis", "conveyor"],   # 上下料整合示範線
            ["robot_arm_6axis", "conveyor"],
            ["robot_arm_6axis", "cnc_machining_center"],
            ["robot_arm_6axis", "air_compressor"],
            ["robot_arm_6axis", "robot_arm_6axis", "conveyor"],
        ],
    },
    "logistics": {
        "label": "智慧物流",
        "products": ["廠內無人搬運", "自動倉儲揀貨", "產線間物流整合", "成品出貨緩衝區"],
        "recipes": [
            ["agv_mobile_robot", "conveyor"],
            ["agv_mobile_robot", "conveyor", "energy_meter"],
            ["agv_mobile_robot", "agv_mobile_robot", "conveyor"],
        ],
    },
    "green_energy": {
        "label": "綠能發電",
        "products": ["小型風力發電", "廠區自發自用綠電", "風場運維示範", "離岸風機監測示範"],
        "recipes": [
            ["wind_turbine", "energy_meter"],
            ["wind_turbine", "energy_meter"],
            ["wind_turbine", "wind_turbine", "energy_meter"],
        ],
    },
    "facility": {
        "label": "廠務動力",
        "products": ["壓縮空氣站", "廠區能源管理", "動力機房", "廠務用電需量管理"],
        "recipes": [
            ["air_compressor", "energy_meter"],
            ["air_compressor", "air_compressor"],
            ["air_compressor", "air_compressor", "energy_meter"],
        ],
    },
    "optics": {
        "label": "光學元件",
        "products": ["手機鏡頭模組", "光學鍍膜", "車用鏡頭元件", "光學檢測治具"],
        "recipes": [
            ["semi_process_chamber", "cnc_machining_center"],      # 鍍膜腔 + 精密加工
            ["semi_process_chamber", "energy_meter"],
            ["cnc_machining_center", "semi_process_chamber", "air_compressor"],
        ],
    },
}

# 64 間虛構廠商名(台灣精密製造業常見的命名風格:字號 + 業別)。
# 刻意不使用任何真實公司名 —— 理由見檔頭。
NAMES = [
    ("昇泰精機", "machine_tool"), ("鴻鋒工業", "metal_forming"), ("群曜科技", "semiconductor"),
    ("巨鼎金屬", "metal_forming"), ("東昇精密", "machine_tool"), ("立捷自動化", "motion_robotics"),
    ("光鼎光電", "optics"), ("台曜熱處理", "heat_treat"), ("宏程塑膠", "plastics"),
    ("永勤機械", "machine_tool"), ("旭鋼實業", "metal_forming"), ("宇鴻塑膠", "plastics"),
    ("鉅程精密", "precision_parts"), ("華晟能源", "green_energy"), ("信達物流科技", "logistics"),
    ("大衛精機", "machine_tool"), ("聯泰射出", "plastics"), ("金揚沖壓", "metal_forming"),
    ("創鋒智能", "motion_robotics"), ("晶源半導體", "semiconductor"), ("正茂熱工", "heat_treat"),
    ("鼎新精密", "precision_parts"), ("宏泰動力", "facility"), ("清風綠能", "green_energy"),
    ("捷晟自動化", "motion_robotics"), ("順昌工具機", "machine_tool"), ("凱鈺光學", "optics"),
    ("廣鑫金屬", "metal_forming"), ("志程塑膠", "plastics"), ("均豪製程", "semiconductor"),
    ("岡田精機", "machine_tool"), ("興隆熱處理", "heat_treat"), ("智運倉儲", "logistics"),
    ("力麒精密", "precision_parts"), ("華通氣力", "facility"), ("藍天風電", "green_energy"),
    ("盛群機械", "machine_tool"), ("和昌沖壓", "metal_forming"), ("耀陽射出", "plastics"),
    ("宸曜科技", "semiconductor"), ("三和熱工", "heat_treat"), ("翔宇自動化", "motion_robotics"),
    ("明鏡光電", "optics"), ("長弘精密", "precision_parts"), ("大成動能", "facility"),
    ("啟睿智造", "machine_tool"), ("鋼承工業", "metal_forming"), ("聚立高分子", "plastics"),
    ("南科製程", "semiconductor"), ("恆溫熱處理", "heat_treat"), ("捷通物流", "logistics"),
    ("威剛精機", "machine_tool"), ("元鼎金屬", "metal_forming"), ("百川射出", "plastics"),
    ("原晶科技", "semiconductor"), ("火頌熱工", "heat_treat"), ("展翼綠電", "green_energy"),
    ("智臂機器人", "motion_robotics"), ("清源氣站", "facility"), ("澄光學儀", "optics"),
    ("鋒鏵精密", "precision_parts"), ("勝弘工具機", "machine_tool"), ("永固沖壓", "metal_forming"),
    ("環宇智慧工廠", "logistics"),
]

INTRO = ("課堂教學用**合成**工廠(#{n:02d});{label} · 主力產品:{product}。"
         "廠內設備:{devices}。{line_note}所有數據皆為模擬產生,非真實場域量測。")

# ── 產線推導:配方裡有「producer + 手臂 + (producer 或輸送帶)」就接成引擎物料流 ──
# 站序規則與 engine/line.py 一致:手臂夾在兩台 producer 之間,或把成品搬上輸送帶出貨。
LINE_PRODUCERS = {"cnc_machining_center", "injection_molding",
                  "stamping_press", "semi_process_chamber"}


def derive_line(devices: list[dict]) -> list[str] | None:
    """由設備清單推導 line: 站序(引擎 engine/line.py 的物料流宣告)。接不成線回傳 None。"""
    producers = [d["id"] for d in devices if d["template"] in LINE_PRODUCERS]
    arms = [d["id"] for d in devices if d["template"] == "robot_arm_6axis"]
    convs = [d["id"] for d in devices if d["template"] == "conveyor"]
    if not arms:
        return None
    if len(producers) >= 2:
        return [producers[0], arms[0], producers[1]]        # A → 手臂 → B(兩站加工)
    if len(producers) == 1 and convs:
        return [producers[0], arms[0], convs[0]]            # 加工 → 手臂 → 輸送帶出貨
    return None


def line_note(line: list[str] | None, devices: list[dict]) -> str:
    """產線的介紹句(工件真實流動 + 可觀測點位)。沒有產線回傳空字串。"""
    if not line:
        return ""
    zh = {d["id"]: ZH[d["template"]] for d in devices}
    flow = " → ".join(f"{zh[i]}({i})" for i in line)
    return (f"產線:{flow} —— 工件在引擎內真實流動,"
            "上游完工、手臂搬運、下游才有料可加工(緩衝可讀 FC04 line_in/out_buffer)。")

ZH = {
    "cnc_machining_center": "CNC 加工中心", "robot_arm_6axis": "六軸機械手臂",
    "conveyor": "輸送帶", "agv_mobile_robot": "AGV 搬運車", "air_compressor": "空壓機",
    "stamping_press": "沖壓機", "injection_molding": "射出成型機", "wind_turbine": "風力發電機",
    "energy_meter": "智慧電表", "semi_process_chamber": "半導體製程腔體",
    "heat_treat_furnace": "熱處理爐",
}
ALL_TEMPLATES = set(ZH)


def build() -> tuple[list[dict], list[str]]:
    companies: list[dict] = []
    dev_no = 0
    # 每個原型各自的配方輪替指標 → 同產業的廠不會全長一樣
    cursor: dict[str, int] = {k: 0 for k in ARCHETYPES}

    for i, (name, arch_key) in enumerate(NAMES, start=1):
        arch = ARCHETYPES[arch_key]
        recipes = arch["recipes"]
        recipe = recipes[cursor[arch_key] % len(recipes)]
        cursor[arch_key] += 1
        product = arch["products"][(i - 1) % len(arch["products"])]

        devices = []
        for tmpl in recipe:
            dev_no += 1
            devices.append({"id": f"d{dev_no:03d}", "template": tmpl})

        line = derive_line(devices)
        company = {
            "id": f"c{i:02d}",
            "name": name,
            "industry": arch_key,
            "product": product,
            "intro": INTRO.format(n=i, label=arch["label"], product=product,
                                  devices=" + ".join(ZH[t] for t in recipe),
                                  line_note=line_note(line, devices)),
            "devices": devices,
        }
        if line:
            company["line"] = line
        companies.append(company)

    # 上下料示範廠(教師展示:雙 CNC + 手臂)
    demo = []
    for tmpl in ["cnc_machining_center", "cnc_machining_center", "robot_arm_6axis"]:
        dev_no += 1
        demo.append({"id": f"d{dev_no:03d}", "template": tmpl})
    demo_line = derive_line(demo)
    companies.append({
        "id": "c65",
        "name": "上下料示範廠(教師展示)",
        "industry": "machine_tool",
        "product": "CNC 上下料自動化工作站",
        "intro": ("教師展示用:雙 CNC + 六軸手臂上下料工作站。"
                  + line_note(demo_line, demo) + "不屬於一人一廠的個人作業範圍。"),
        "devices": demo,
        "line": demo_line,
    })

    warnings = []
    used = {d["template"] for c in companies for d in c["devices"]}
    missing = ALL_TEMPLATES - used
    if missing:
        warnings.append(f"未被使用的 template:{sorted(missing)}")
    for c in companies:
        if not c["devices"]:
            warnings.append(f"{c['id']} 沒有設備")
    return companies, warnings


# 供應鏈:每 4 間串成一條鏈(c01→c02→c03→c04、c05→…),64 廠剛好 16 條。
# 為什麼是 4 而不是全班一條長鏈:一條 64 節的鏈只要有人停機,後面 60 個人全陪葬,
# 那不是教學是連坐。4 節剛好等於課堂分組的大小,斷鏈的因果也還看得清楚。
CHAIN_LEN = 4
# 只有這些 template 有「完成一件」的累積量 tag,供應鏈才數得出誰出了幾件
# (與 engine/line.py 的 COUNT_TAGS 一致)。沒有這種設備的廠不參與供應鏈 ——
# 電表廠 / 壓縮機房本來就不是在做零件,硬接進去只會在啟動時噴一堆略過警告。
SUPPLY_TEMPLATES = {"cnc_machining_center", "injection_molding", "stamping_press", "semi_process_chamber"}
# 每條鏈的**最後一段**不給外部備援(external_backup_h=0)—— 刻意留一個對照組:
# 有備援的那幾段會看到「靠外購撐著」,沒備援的那段上游一停就真的死給你看。
BACKUP_H = 3.0
# 進料倉容量 / 開場庫存。倉越小,上下游耦合越緊(缺料與阻塞越頻繁);想讓班上耦合鬆一點
# 就把 CAP 調大再重跑這支。開場庫存是為了不讓開學第一分鐘全班一起餓料。
CAP, INITIAL = 45, 18


def build_supply_chain(companies: list[dict]) -> list[dict]:
    """把「做得出零件」的公司每 CHAIN_LEN 間串成一條供應鏈。教師示範廠(c65)不參與。

    鏈上的公司不必是連號 —— 中間跳過的是沒有 producer 的廠(電表 / 壓縮機 / 風機那類)。"""
    pool = [c for c in companies
            if c["id"] != "c65"
            and any(d["template"] in SUPPLY_TEMPLATES for d in c["devices"])]
    links: list[dict] = []
    for start in range(0, len(pool), CHAIN_LEN):
        chain = pool[start:start + CHAIN_LEN]
        if len(chain) < 2:
            break
        for i in range(len(chain) - 1):
            up, down = chain[i], chain[i + 1]
            last_hop = i == len(chain) - 2
            links.append({
                "from": up["id"], "to": down["id"],
                "part": up["product"],
                "cap": CAP, "initial": INITIAL,
                "external_backup_h": 0.0 if last_hop else BACKUP_H,
            })
    return links


def to_yaml(companies: list[dict]) -> str:
    lines = [
        "# 課堂場景(64 廠一人一廠 + 1 間教師示範廠)。",
        "# ⚠ 全為合成(synthetic)教學資料,非任何真實公司產線。",
        "#   公司名為**虛構**廠商 —— 這些廠會故障、數據全是模擬產生的,",
        "#   掛真實廠商名字會變成對真實企業的不實陳述(CLAUDE.md 鐵則二)。",
        "#",
        "# 本檔由 scenarios/scripts/gen_class_park.py 產生,要調組合請改那支再重跑。",
        "park:",
        '  name: "智慧工業區 · 課堂版(64 廠 + 上下料示範)"',
        "  sim:",
        "    tick_hz: 2",
        "    time_multiplier: 120",
        "    broadcast_interval_s: 5",
        "  mes: {enabled: true}",
        "  protocol_mode: channel_mux",
        "  ports: {modbus: 6020, opcua: 6041, mqtt: 6083}",
        "",
        "  companies:",
    ]
    for c in companies:
        lines.append(f"    - id: {c['id']}")
        lines.append(f'      name: "{c["name"]}"')
        lines.append(f"      industry: {c['industry']}")
        lines.append(f'      product: "{c["product"]}"')
        lines.append(f'      intro: "{c["intro"]}"')
        if c.get("line"):
            lines.append(f"      line: [{', '.join(c['line'])}]   # 產線物料流(engine/line.py)")
        lines.append("      devices:")
        for d in c["devices"]:
            lines.append(f"        - {{id: {d['id']}, template: {d['template']}}}")
        lines.append("")

    chain = build_supply_chain(companies)
    lines += [
        "  # 跨公司供應鏈:A 出貨 = B 進料(engine/supply.py)。",
        "  # 上游同學的機台壞了沒人管,你的產線就餓料停機;你停太久,下游的進料倉塞爆,",
        "  # 反過來把你卡住。每 4 間一條鏈(= 課堂分組大小),每條鏈最後一段刻意不給外部備援。",
        "  supply_chain:",
    ]
    for lk in chain:
        lines.append(
            f"    - {{from: {lk['from']}, to: {lk['to']}, part: \"{lk['part']}\", "
            f"cap: {lk['cap']}, initial: {lk['initial']}, external_backup_h: {lk['external_backup_h']}}}")
    lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    companies, warnings = build()
    devices = [d for c in companies for d in c["devices"]]
    combos = {tuple(sorted(d["template"] for d in c["devices"])) for c in companies}
    tmpl_count: dict[str, int] = {}
    for d in devices:
        tmpl_count[d["template"]] = tmpl_count.get(d["template"], 0) + 1

    chain = build_supply_chain(companies)
    print(f"{len(companies)} 公司 / {len(devices)} 設備 / {len(combos)} 種設備組合 / "
          f"{len(chain)} 條供應關係({len(chain) // (CHAIN_LEN - 1)} 條鏈)")
    print("  template 分布:")
    for t in sorted(tmpl_count, key=lambda k: -tmpl_count[k]):
        print(f"    {tmpl_count[t]:3d}  {t}  ({ZH[t]})")
    for w in warnings:
        print(f"  ⚠ {w}")
    if warnings:
        sys.exit(1)

    if "--check" in sys.argv:
        print("check only, 未寫檔")
        return
    OUT.write_text(to_yaml(companies), encoding="utf-8")
    print(f"寫入 {OUT}")


if __name__ == "__main__":
    main()
