"""產生示範園區 scenarios/default_park.yaml(勤益老師示範廠)。

與 class_park 的差別:這裡的**老師姓名是刻意保留的**(系上老師的示範廠,不是佔位字串),
所以只重寫「內容」—— 產業別、產品線、設備組合。

原本的問題:
  · `industry` 亂標 —— 沖壓機工廠掛 `wind_energy`、射出廠掛 `utility`。
  · `product` 37 間全部都是「綜合智慧自動化產線」,等於沒有內容。
  · 廠名是「{老師} 第 N 工廠」,看不出這條線在做什麼。
  · 設備組合只有 7 種 / 37 間,而且完全沒有 semi_process_chamber 與 heat_treat_furnace。

用法:
    python3 scenarios/scripts/gen_default_park.py [--check]
"""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scenarios" / "scripts"))
OUT = ROOT / "scenarios" / "default_park.yaml"

from gen_class_park import ARCHETYPES, ZH, ALL_TEMPLATES, derive_line, line_note  # noqa: E402

# 系上老師與各自的示範廠數(沿用原檔,不更動姓名與 id)
TEACHERS = [
    ("t01", "彭達仁老師", 3), ("t02", "翁偉翰老師", 3), ("t03", "劉瑞弘老師", 3),
    ("t04", "陳智榮老師", 3), ("t05", "李坤穎老師", 3), ("t06", "吳崇民老師", 3),
    ("t07", "李榮茂老師", 3), ("t08", "黃秋杰老師", 4), ("t09", "吳俊毅老師", 4),
    ("t10", "謝式娜老師", 4), ("t11", "陳鵬仁老師", 4),
]

# 示範園區走「每位老師一條主題產線」,主題之間盡量不同,涵蓋全部 11 種 template
THEME_ORDER = [
    "machine_tool", "green_energy", "metal_forming", "plastics", "semiconductor",
    "heat_treat", "motion_robotics", "logistics", "precision_parts", "cutting_tools", "optics",
]

INTRO = ("{teacher}指導的**合成**示範工廠;{label} · 主力產品:{product}。"
         "製程:{story}{line_note}所有數據皆為模擬產生,非真實場域量測。")


def build() -> list[dict]:
    companies: list[dict] = []
    dev_no = 0
    for ti, (tid, teacher, n_factories) in enumerate(TEACHERS):
        theme = THEME_ORDER[ti % len(THEME_ORDER)]
        arch = ARCHETYPES[theme]
        for f in range(1, n_factories + 1):
            # 同一位老師的各廠走同主題的不同配方 → 主題一致但組合不同。
            # 產品從該配方自己的清單選(設備要能支撐掛出來的產品);配方數 < 廠數而
            # 繞回同一配方時,靠該配方的多個產品錯開(唯一性由 _assert_unique_names 把關)。
            recipe = arch["recipes"][(f - 1) % len(arch["recipes"])]
            product = recipe["products"][(f - 1) % len(recipe["products"])]
            devices = []
            for tmpl in recipe["devices"]:
                dev_no += 1
                devices.append({"id": f"{tid}-d{dev_no:03d}", "template": tmpl})
            line = derive_line(devices)
            company = {
                "id": f"{tid}-f{f}",
                # 廠名要說得出這條線在做什麼(而不是「第 N 工廠」),老師掛在後面當負責人。
                # 每位老師一個主題、廠內產品各不相同,所以廠名天然唯一。
                "name": f"{product}廠({teacher}負責)",
                "industry": theme,
                "product": product,
                "product_icon": recipe.get("icon", "📦"),
                "intro": INTRO.format(teacher=teacher, label=arch["label"], product=product,
                                      story=recipe["story"],
                                      line_note=line_note(line, devices)),
                "devices": devices,
            }
            if line:
                company["line"] = line
            companies.append(company)

    # 新產業示範廠(2026-08 追加:焊接 / 雷切+包裝 / AOI)。附加在尾端 ——
    # 既有廠的 device id / unit_id 零位移;id 用 x01 前綴,不掛任何老師姓名。
    NEW_DEMOS = [
        ("x01-f1", "焊接工作站示範廠(新產業展示)", "welding", "焊接自動化工作站", "🔥",
         "管件在焊接工作站沿焊道電弧熔填,六軸手臂上下料,輸送帶送出焊件。",
         ["welding_cell", "robot_arm_6axis", "conveyor"]),
        ("x01-f2", "雷切包裝示範廠(新產業展示)", "laser_cutting", "鈑金雷切包裝線", "🔆",
         "板材在雷射切割機沿輪廓下料,六軸手臂取件,包裝機封裝出貨。",
         ["laser_cutter", "robot_arm_6axis", "packaging_machine"]),
        ("x01-f3", "光學檢測示範廠(新產業展示)", "inspection", "CNC 加工全檢線", "🔍",
         "工件在 CNC 加工中心銑削成形,六軸手臂送檢,AOI 光學檢測站逐件全檢。",
         ["cnc_machining_center", "robot_arm_6axis", "aoi_inspection"]),
        # 鑄造 / 鍛造上游(2026-08-21):手工具製程流程圖的「原料與成形」段。
        ("x01-f4", "熔煉鑄造示範廠(新產業展示)", "casting", "鋁合金壓鑄毛胚", "🔥",
         "回爐料在熔煉爐熔成 1450 °C 熔湯、每 72 秒出一籃,六軸手臂送進壓鑄機成形,"
         "再由手臂搬上輸送帶出貨。熔煉爐是全線瓶頸,壓鑄機的稼動會誠實反映等湯的時間。",
         ["melting_furnace", "robot_arm_6axis", "die_casting_machine",
          "robot_arm_6axis", "conveyor"]),
        ("x01-f5", "熱模鍛造示範廠(新產業展示)", "forging", "手工具鍛造胚料", "🔨",
         "棒料在感應加熱爐加熱到 1180 °C,六軸手臂送進鍛造壓機一擊成形,"
         "再送到毛胚整修機切除飛邊。加熱溫度不足的棒料會鍛出摺疊裂紋 —— "
         "出料溫度是這條線的第一個品質關卡。",
         ["induction_heater", "robot_arm_6axis", "forging_press",
          "robot_arm_6axis", "trimming_press"]),
    ]
    for cid, name, industry, product, icon, story, tmpls in NEW_DEMOS:
        devices = []
        for tmpl in tmpls:
            dev_no += 1
            devices.append({"id": f"x01-d{dev_no:03d}", "template": tmpl})
        line = derive_line(devices)
        company = {
            "id": cid, "name": name, "industry": industry,
            "product": product, "product_icon": icon,
            "intro": (f"新產業**合成**示範工廠;主力產品:{product}。製程:{story}"
                      f"{line_note(line, devices)}所有數據皆為模擬產生,非真實場域量測。"),
            "devices": devices,
        }
        if line:
            company["line"] = line
        companies.append(company)
    return companies


def _assert_unique_names(companies: list[dict]) -> None:
    """廠名撞名要在產生時就爆,不要等到場景驗證才發現。

    撞名的原因通常是:某位老師的工廠數 > 該產業的產品數,`products[(f-1) % n]` 繞回去
    重複。補產品或減工廠數都可以,但不能默默產出兩間同名的廠。
    """
    from collections import Counter
    dup = [n for n, c in Counter(x["name"] for x in companies).items() if c > 1]
    if dup:
        raise SystemExit(f"廠名重複:{dup} —— 對應產業的 products 數量不夠,請補足")


def to_yaml(companies: list[dict]) -> str:
    lines = [
        "# 示範園區(系上老師各一條主題產線)。",
        "# ⚠ 全為合成(synthetic)教學資料,非任何真實產線量測。",
        "#   老師姓名為刻意保留的示範標示;產業別 / 產品線 / 設備組合由產生器指派。",
        "#",
        "# 本檔由 scenarios/scripts/gen_default_park.py 產生,要調組合請改那支再重跑。",
        "park:",
        '  name: "國立勤益科技大學 智慧自動化工程園區(示範)"',
        "  sim:",
        "    tick_hz: 2",
        "    time_multiplier: 120",
        "    broadcast_interval_s: 5",
        "  mes:",
        "    enabled: true",
        "  protocol_mode: channel_mux",
        "  ports:",
        "    modbus: 6020",
        "    opcua: 6041",
        "    mqtt: 6083",
        "  companies:",
    ]
    for c in companies:
        lines.append(f"    - id: {c['id']}")
        lines.append(f'      name: "{c["name"]}"')
        lines.append(f"      industry: {c['industry']}")
        lines.append(f'      product: "{c["product"]}"')
        lines.append(f'      product_icon: "{c["product_icon"]}"')
        lines.append(f'      intro: "{c["intro"]}"')
        if c.get("line"):
            lines.append(f"      line: [{', '.join(c['line'])}]   # 產線物料流(engine/line.py)")
        lines.append("      devices:")
        for d in c["devices"]:
            lines.append(f"        - {{id: {d['id']}, template: {d['template']}}}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    companies = build()
    _assert_unique_names(companies)
    devices = [d for c in companies for d in c["devices"]]
    combos = {tuple(sorted(d["template"] for d in c["devices"])) for c in companies}
    used = {d["template"] for d in devices}
    print(f"{len(companies)} 公司 / {len(devices)} 設備 / {len(combos)} 種設備組合 / {len(used)} 種 template")
    missing = ALL_TEMPLATES - used
    if missing:
        print(f"  ⚠ 未使用的 template:{sorted(missing)}")
        sys.exit(1)
    if "--check" in sys.argv:
        print("check only, 未寫檔")
        return
    OUT.write_text(to_yaml(companies), encoding="utf-8")
    print(f"寫入 {OUT}")


if __name__ == "__main__":
    main()
