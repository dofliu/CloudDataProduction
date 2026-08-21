#!/usr/bin/env python3
"""資料盤點:這座園區「產得出什麼資料」——逐機型訊號覆蓋 + 資料域缺口。

跑法(不需要活廠,直接載場景推幾拍):
    python tools/audit_data_coverage.py                       # 課堂版
    python tools/audit_data_coverage.py scenarios/default_park.yaml
    python tools/audit_data_coverage.py --json                # 機器可讀

輸出的數字就是 docs/資料盤點_生產數據完整性.md 引用的那些 —— 文件改了要回頭重跑對數,
不要手寫覆蓋率。本工具**只讀**引擎狀態,不寫任何檔、不動世界。

判定用「tag 名稱關鍵字」做分類:名稱是學生唯一看得到的線索,若一支訊號的名字讓人
分不出它屬於哪個資料域,對學生就等於不存在 —— 所以這裡刻意不查程式碼語意。
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import yaml  # noqa: E402

from engine.world import World  # noqa: E402

# 資料域 → 判定用的 tag 名稱關鍵字。順序即報表順序。
DOMAINS: dict[str, tuple[str, ...]] = {
    "產出計數": ("count", "produced", "shipped", "throughput"),
    "節拍/速率": ("cycle_time", "rate", "speed", "rpm", "index"),
    "品質": ("reject", "defect", "scrap", "yield", "burr", "dross", "spatter",
             "particle", "false_call", "focus", "uniformity", "good_count",
             "short_shot", "dimension_deviation", "surface_roughness", "weight_deviation"),
    "能耗": ("power", "energy", "kwh", "current", "voltage"),
    "狀態": ("state", "stop_reason"),
    "劣化徵兆": ("vibration", "temp", "wear", "load", "pressure"),
}

WARMUP_TICKS = 30
WARMUP_DT_SIM = 12.0


def load_world(path: str) -> World:
    park = yaml.safe_load(Path(path).read_text(encoding="utf-8"))["park"]
    world = World(park)
    for _ in range(WARMUP_TICKS):
        world.step(WARMUP_DT_SIM)
    return world


def collect(world: World) -> dict:
    snap = world._make_snapshot()
    devs = snap["devices"]

    tmpl_tags: dict[str, list[str]] = {}
    tmpl_n: collections.Counter = collections.Counter()
    for dev in devs.values():
        tmpl = dev.get("template", "?")
        tmpl_n[tmpl] += 1
        tmpl_tags.setdefault(tmpl, sorted(dev["tags"]))

    per_tmpl = {}
    for tmpl, tags in tmpl_tags.items():
        per_tmpl[tmpl] = {
            "devices": tmpl_n[tmpl],
            "tags": tags,
            "domains": {
                dom: [t for t in tags if any(k in t for k in keys)]
                for dom, keys in DOMAINS.items()
            },
        }

    points = sum(len(d["tags"]) for d in devs.values())
    sim = world.park.get("sim", {}) or {}
    broadcast = float(sim.get("broadcast_interval_s", 0.0)) or 0.5
    return {
        "companies": len(world.park.get("companies", []) or []),
        "devices": len(devs),
        "templates": len(per_tmpl),
        "unique_tags": len({t for tags in tmpl_tags.values() for t in tags}),
        "points_per_snapshot": points,
        "broadcast_interval_s": broadcast,
        "rows_per_s": points / broadcast,
        "lines": len(snap.get("lines") or []),
        "supply_links": len(snap.get("supply") or []),
        "per_template": per_tmpl,
    }


def report(data: dict) -> None:
    print(f"公司 {data['companies']} / 設備 {data['devices']} / 機型 {data['templates']}"
          f" / 不重複 tag {data['unique_tags']}")
    print(f"產線 {data['lines']} 條 / 供應鏈 {data['supply_links']} 段")
    print(f"每份 snapshot {data['points_per_snapshot']} 個數值點,廣播間隔"
          f" {data['broadcast_interval_s']:g} s → historian 約 {data['rows_per_s']:.0f} 列/秒"
          f"({data['rows_per_s'] * 86400 / 1e6:.0f} M 列/天)")

    doms = list(DOMAINS)
    width = max(len(t) for t in data["per_template"])
    print(f"\n{'機型':<{width}} {'台':>4}  " + "  ".join(f"{d:^6}" for d in doms))
    for tmpl in sorted(data["per_template"]):
        info = data["per_template"][tmpl]
        cells = "  ".join(f"{('✔' if info['domains'][d] else '—'):^7}" for d in doms)
        print(f"{tmpl:<{width}} {info['devices']:>4}  {cells}")

    print("\n各資料域的機型覆蓋:")
    for dom in doms:
        hit = [t for t, i in data["per_template"].items() if i["domains"][dom]]
        miss = [t for t, i in data["per_template"].items() if not i["domains"][dom]]
        n_dev = sum(i["devices"] for t, i in data["per_template"].items() if i["domains"][dom])
        print(f"  {dom:<8} {len(hit):>2}/{data['templates']} 機型、"
              f"{n_dev:>3}/{data['devices']} 台" + (f" — 缺:{', '.join(sorted(miss))}" if miss else ""))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("scenario", nargs="?", default="scenarios/class_park.yaml")
    ap.add_argument("--json", action="store_true", help="輸出 JSON(給其他工具吃)")
    args = ap.parse_args()

    data = collect(load_world(args.scenario))
    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        report(data)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
