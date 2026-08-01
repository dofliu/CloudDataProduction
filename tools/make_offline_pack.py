"""離線備援資料包 —— W4 教學指引 Plan B(平台 / 網路出狀況時的整堂課備案)。

各產業(template)各挑一台設備,headless 快轉一週**乾淨**資料(正常運轉、無故障注入,
自然退化放慢以保證整週健康),每台輸出:

  offline_pack/
  ├── manifest.json            # seed / engine commit / 參數 / 設備清單(可溯源、可重現)
  ├── README.txt               # 給學生的說明(欄位、單位、合成資料聲明)
  ├── catalog.json             # 這些設備的目錄規格(離線也能教「查規格書」)
  └── <device>.csv / .json     # 一週資料:sim_t, sim_h, state, <各觀測 tag>

W4 的課堂活動(敘述統計 / 分佈 / 日週期)全部可以在這包上離線完成。
⚠ 全部為合成數據(synthetic),檔頭與 manifest 都有標示。

用法:
  python tools/make_offline_pack.py                          # 預設 default_park、7 sim 天、1 分鐘取樣
  python tools/make_offline_pack.py --zip                    # 另外打包 offline_pack.zip
  python tools/make_offline_pack.py --sim-days 7 --step-min 1 --seed 20260101
"""
from __future__ import annotations

import argparse
import csv
import json
import subprocess
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from engine.world import World  # noqa: E402


def _git(root: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=root, capture_output=True,
                              text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="scenarios/default_park.yaml")
    ap.add_argument("--out", default="offline_pack")
    ap.add_argument("--sim-days", type=float, default=7.0, help="資料長度(sim 天)")
    ap.add_argument("--step-min", type=float, default=1.0, help="取樣解析度(sim 分鐘)")
    ap.add_argument("--seed", type=int, default=20260101, help="主種子(同 seed 完全可重現)")
    ap.add_argument("--degradation-scale", type=float, default=0.2,
                    help="自然退化倍率(預設 0.2:放慢,保證整週乾淨健康 —— 這是 W4 的正常基線包)")
    ap.add_argument("--zip", action="store_true", help="另外打包成 <out>.zip")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    world = World.from_yaml(root / args.scenario, seed=args.seed)

    # 各 template 挑一台(依設備 id 排序取第一台 → 確定性,同 seed 同一批)
    by_tmpl: dict = {}
    for d in sorted(world.devices.values(), key=lambda x: x.id):
        by_tmpl.setdefault(d.template, d)
    devs = sorted(by_tmpl.values(), key=lambda d: d.id)
    print(f"{len(devs)} 種產業各一台:{', '.join(f'{d.id}({d.template})' for d in devs)}")

    # 放慢**全部**設備的自然退化(不只選中的):整包是「正常運轉基線」,
    # 不能有任何一台在觀測窗內故障(產線上游壞了會讓選中的下游餓料,資料就不正常了)。
    if args.degradation_scale != 1.0:
        for d in world.devices.values():
            for c in d.components.values():
                c.rate *= args.degradation_scale

    out_dir = root / args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    dt = args.step_min * 60.0
    n_steps = int(args.sim_days * 86400.0 / dt)
    tag_names = {d.id: [t.name for t in d.tags if t.name != "state"] for d in devs}
    rows: dict = {d.id: [] for d in devs}

    for _ in range(n_steps):
        world.clock._sim_t += dt
        sim_t = world.clock.now()
        snap = world.step(dt)
        for d in devs:
            pub = snap["devices"][d.id]
            rows[d.id].append({
                "sim_t": round(sim_t, 1),
                "sim_h": round(sim_t / 3600.0, 3),
                "state": pub["state"],
                **{k: round(v, 4) for k, v in pub["tags"].items() if k != "state"},
            })

    # 乾淨性檢查:備援包裡不允許任何故障(這是 W4 的「正常基線」教材)
    faulted = [d.id for d in world.devices.values() if d.state == "fault"]
    if faulted:
        raise SystemExit(f"觀測窗內有設備故障:{faulted} —— 請調低 --degradation-scale 後重產")

    for d in devs:
        cols = ["sim_t", "sim_h", "state"] + tag_names[d.id]
        with open(out_dir / f"{d.id}.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(cols)
            for r in rows[d.id]:
                w.writerow([r.get(c, "") for c in cols])
        (out_dir / f"{d.id}.json").write_text(
            json.dumps({"synthetic": True, "device": d.id, "template": d.template,
                        "rows": rows[d.id]}, ensure_ascii=False), encoding="utf-8")

    # 目錄規格(離線也能教「查規格書」;連線資訊以佔位 host 呈現)
    catalog = {"synthetic": True, "note": "離線備援包附帶目錄;連線欄位僅供格式參考",
               "devices": [d.catalog_entry() for d in devs]}
    (out_dir / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=1),
                                          encoding="utf-8")

    manifest = {
        "synthetic": True,
        "purpose": "W4 Plan B 離線備援(正常運轉基線,無故障)",
        "scenario": args.scenario,
        "seed": args.seed,
        "engine_commit": _git(root, "rev-parse", "HEAD"),
        "sim_days": args.sim_days,
        "step_min": args.step_min,
        "degradation_scale": args.degradation_scale,
        "devices": [{"id": d.id, "template": d.template, "company": d.company_id,
                     "rows": len(rows[d.id])} for d in devs],
    }
    (out_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                                           encoding="utf-8")
    (out_dir / "README.txt").write_text(
        "離線備援資料包(W4 Plan B)\n"
        "==========================\n"
        "⚠ 全部為合成數據(synthetic),由模擬引擎產生,非真實場域量測。\n\n"
        f"內容:{len(devs)} 種產業各一台設備、{args.sim_days:g} 個模擬天(取樣 {args.step_min:g} 分鐘)。\n"
        "每台各有 CSV 與 JSON 兩種格式,欄位:\n"
        "  sim_t  模擬時間(秒)   sim_h  模擬時間(小時)   state  設備狀態\n"
        "  其餘欄位為該機種的觀測訊號,單位見 catalog.json 的 tags[].unit。\n\n"
        "課堂用法(W4):敘述統計(平均/標準差/分位數)、分佈圖、日週期觀察。\n"
        "分組時間請用 sim_t(平台的模擬時間),不要用你電腦的時鐘。\n"
        "可重現:manifest.json 記了 seed 與 engine commit,同參數重產得到完全相同的資料。\n",
        encoding="utf-8")

    total_rows = sum(len(v) for v in rows.values())
    print(f"寫入 {out_dir}:{len(devs)} 台 × {n_steps} 筆 = {total_rows} 列 + catalog/manifest/README")

    if args.zip:
        zpath = out_dir.with_suffix(".zip")
        with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
            for p in sorted(out_dir.iterdir()):
                z.write(p, arcname=f"{out_dir.name}/{p.name}")
        print(f"打包 {zpath}({zpath.stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
