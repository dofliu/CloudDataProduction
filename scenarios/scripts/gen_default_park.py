"""產生示範園區 scenarios/default_park.yaml(勤益老師示範廠)。

與 class_park 的差別:這裡的**老師姓名是刻意保留的**(系上老師的示範廠,不是佔位字串),
所以只重寫「內容」—— 產業別、產品線、設備組合。

原本的問題:
  · `industry` 亂標 —— 沖壓機工廠掛 `wind_energy`、射出廠掛 `utility`。
  · `product` 37 間全部都是「綜合智慧自動化產線」,等於沒有內容。
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

from gen_class_park import ARCHETYPES, ZH, ALL_TEMPLATES  # noqa: E402

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
    "heat_treat", "motion_robotics", "logistics", "precision_parts", "facility", "optics",
]

INTRO = ("{teacher}指導的**合成**示範工廠;{label} · {product}。"
         "設備:{devices}。所有數據皆為模擬產生,非真實場域量測。")


def build() -> list[dict]:
    companies: list[dict] = []
    dev_no = 0
    for ti, (tid, teacher, n_factories) in enumerate(TEACHERS):
        theme = THEME_ORDER[ti % len(THEME_ORDER)]
        arch = ARCHETYPES[theme]
        for f in range(1, n_factories + 1):
            # 同一位老師的各廠走同主題的不同配方 → 主題一致但組合不同
            recipe = arch["recipes"][(f - 1) % len(arch["recipes"])]
            product = arch["products"][(f - 1) % len(arch["products"])]
            devices = []
            for tmpl in recipe:
                dev_no += 1
                devices.append({"id": f"{tid}-d{dev_no:03d}", "template": tmpl})
            companies.append({
                "id": f"{tid}-f{f}",
                "name": f"{teacher} 第{f}工廠",
                "industry": theme,
                "product": product,
                "intro": INTRO.format(teacher=teacher, label=arch["label"], product=product,
                                      devices=" + ".join(ZH[t] for t in recipe)),
                "devices": devices,
            })
    return companies


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
        lines.append(f'      intro: "{c["intro"]}"')
        lines.append("      devices:")
        for d in c["devices"]:
            lines.append(f"        - {{id: {d['id']}, template: {d['template']}}}")
        lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def main() -> None:
    companies = build()
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
