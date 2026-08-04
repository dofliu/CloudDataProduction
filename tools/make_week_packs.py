"""每週凍結資料包 —— 把 course_weeks.yaml 的每週情境離線預產成凍結教材(ROADMAP TODO #1)。

為什麼:每週情境原本是「套用到正在跑的引擎」上的,平台必須持續開著才有當週資料。
本工具把每一週**預先產成凍結資料包**,平台在不在線都不影響已發教材;斷電、重啟、
學期中改程式,已發下去的包完全不受影響(manifest 記 seed + engine commit,可重現可溯源)。

規則(讀 scenarios/course_weeks.yaml,週次已對齊《18週教學大綱 v2.1》):
  - faults: clear   → 乾淨基線包(自然退化放慢,整包不允許任何故障)。
  - faults: dict    → 依 spec(kind/type/severity)注入 —— 對包內 producer **半數注入、
                      半數留作乾淨對照組**(答案卷寫明誰被注入),onset 預設第 2 天。
  - faults: keep    → 沿用**前一個有定義的週**的條件(例:W11 沿用 W10 的感測器漂移)。

每週輸出 packs/weekNN/:
  <device>.csv / .json   一週資料(sim_t, sim_h, state, 各觀測 tag;**不含 ground-truth**)
  manifest.json          seed / engine commit / 週次 spec / 設備清單
  README.txt             給學生的說明(當週主題、欄位、合成資料聲明)
另存 packs/answers/weekNN.json(教師答案卷:注入了誰、哪個元件/哪支 tag、onset、severity)。

**產後驗證(沒驗就發下去,可能整週的題目是無解的)**:
  - equipment 注入:該元件真實健康度在窗內顯著下降(drop ≥ 0.10);
  - sensor 注入:被汙染 tag 在 onset 之後有可偵測的線性趨勢(斜率 t 檢定 ≥ 6);
  - clear 週:整包不得有任何設備故障。
任一驗證不過 → 該週拒產(exit 1)。

用法:
  python tools/make_week_packs.py                       # 產全部定義週
  python tools/make_week_packs.py --weeks 4,8 --zip     # 只產 W4/W8 並打包
  python tools/make_week_packs.py --student 41143209    # 課程統一種子表(與作業 base seed 同源)
  python tools/make_week_packs.py --seed 20270101       # 直接換主種子(全班同一份包)
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
from tools.course_seed import DEFAULT_MASTER, student_seed  # noqa: E402

import yaml  # noqa: E402

CLEAN_DEG_SCALE = 0.2           # 放慢自然退化:clear 週保證乾淨、注入週讓指定故障成為唯一訊號


def _git(root: Path, *args: str) -> str:
    try:
        return subprocess.run(["git", *args], cwd=root, capture_output=True,
                              text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


def _first_float_tag(device) -> str | None:
    """與 engine/course.py 的感測器注入選 tag 規則一致(第一個 float32)。"""
    return next((t.name for t in device.tags if t.datatype == "float32"), None)


def _fault_component(device) -> str | None:
    return next((c.name for c in device.components.values() if c.causes_device_fault), None)


def resolve_week_specs(course: dict) -> dict[int, dict]:
    """展開 faults: keep → 沿用前一個有定義的週的條件。回傳 {week: spec(faults 已展開)}。"""
    out: dict[int, dict] = {}
    prev_faults = "clear"
    for w in sorted(course.get("weeks", []) or [], key=lambda x: int(x["week"])):
        spec = dict(w)
        if spec.get("faults") == "keep":
            spec["faults"] = prev_faults
            spec["_kept_from_previous"] = True
        prev_faults = spec["faults"]
        out[int(w["week"])] = spec
    return out


def build_week(root: Path, scenario: str, week: int, spec: dict, seed: int,
               sim_days: float, step_min: float, out_root: Path,
               onset_day: float = 2.0) -> dict:
    """產一週的凍結包 + 驗證。回傳 answers(教師答案卷)。驗證不過丟 SystemExit。"""
    week_seed = seed + week * 1009                     # 每週不同但確定性的種子
    world = World.from_yaml(root / scenario, seed=week_seed)

    # 各 template 挑一台(確定性),涵蓋 11 種產業
    by_tmpl: dict = {}
    for d in sorted(world.devices.values(), key=lambda x: x.id):
        by_tmpl.setdefault(d.template, d)
    devs = sorted(by_tmpl.values(), key=lambda d: d.id)

    faults = spec.get("faults")
    clean_week = faults == "clear"
    injected: list[dict] = []

    # 乾淨基線:全園區放慢自然退化(注入週也放慢背景退化,讓「指定故障」成為唯一訊號)
    for d in world.devices.values():
        for c in d.components.values():
            c.rate *= CLEAN_DEG_SCALE

    if not clean_week:
        kind = str(faults.get("kind", "equipment"))
        ftype = str(faults.get("type", "gradual"))
        sev = float(faults.get("severity", 0.8))
        producers = [d for d in devs if _fault_component(d) is not None]
        targets = producers[::2]                       # 半數注入、半數留乾淨對照
        onset_s = onset_day * 86400.0
        for d in targets:
            if kind == "sensor":
                tag = _first_float_tag(d)
                if tag is None:
                    continue
                ft = ftype if ftype.startswith("sensor_") else "sensor_drift"
                d.inject_fault(ft, tag, severity=sev, onset_sim_s=onset_s)
                injected.append({"device": d.id, "kind": "sensor", "type": ft,
                                 "target": tag, "severity": sev, "onset_day": onset_day})
            else:
                comp = _fault_component(d)
                d.inject_fault(ftype, comp, severity=sev, onset_sim_s=onset_s)
                injected.append({"device": d.id, "kind": "equipment", "type": ftype,
                                 "target": comp, "severity": sev, "onset_day": onset_day})

    # 記注入元件的初始健康度(驗證用)
    h0 = {}
    for inj in injected:
        if inj["kind"] == "equipment":
            d = world.devices[inj["device"]]
            h0[inj["device"]] = d.components[inj["target"]].health

    # 快轉一週
    dt = step_min * 60.0
    n_steps = int(sim_days * 86400.0 / dt)
    tag_names = {d.id: [t.name for t in d.tags if t.name != "state"] for d in devs}
    rows: dict = {d.id: [] for d in devs}
    for _ in range(n_steps):
        world.clock._sim_t += dt
        sim_t = world.clock.now()
        snap = world.step(dt)
        for d in devs:
            pub = snap["devices"][d.id]
            rows[d.id].append({"sim_t": round(sim_t, 1), "sim_h": round(sim_t / 3600.0, 3),
                               "state": pub["state"],
                               **{k: round(v, 4) for k, v in pub["tags"].items() if k != "state"}})

    # ── 產後驗證 ────────────────────────────────────────────
    problems: list[str] = []
    if clean_week:
        bad = [d.id for d in world.devices.values() if d.state == "fault"]
        if bad:
            problems.append(f"clear 週出現故障:{bad}")
    for inj in injected:
        d = world.devices[inj["device"]]
        if inj["kind"] == "equipment":
            drop = h0[inj["device"]] - d.components[inj["target"]].health
            if drop < 0.10:
                problems.append(f"{d.id}.{inj['target']} 健康度僅下降 {drop:.3f}(<0.10),學生偵測不到")
        else:
            # 被汙染 tag:onset 之後要有可偵測的**線性趨勢**(漂移的本質),用斜率 t 檢定。
            # 不能用「後段均值 vs 前段 z 分數」—— 週期性大擺幅的訊號(如爐溫 30↔900°C)
            # 基線 σ 巨大,兩百度的漂移也會被淹沒;學生實際的偵測法(趨勢)不受此影響。
            tag = inj["target"]
            post = [(r["sim_h"], r[tag]) for r in rows[d.id]
                    if r["sim_h"] >= onset_day * 24 and tag in r]
            if len(post) < 100:
                problems.append(f"{d.id}.{tag} 樣本不足,無法驗證漂移")
                continue
            xs = [p[0] for p in post]
            ys = [p[1] for p in post]
            n = len(xs)
            mx, my = sum(xs) / n, sum(ys) / n
            sxx = sum((x - mx) ** 2 for x in xs)
            slope = sum((xs[i] - mx) * (ys[i] - my) for i in range(n)) / sxx
            resid = [ys[i] - (my + slope * (xs[i] - mx)) for i in range(n)]
            se = ((sum(e * e for e in resid) / max(1, n - 2)) / sxx) ** 0.5 or 1e-12
            t_stat = abs(slope) / se
            if t_stat < 6.0:
                problems.append(f"{d.id}.{tag} 漂移趨勢 t={t_stat:.1f}(<6),學生偵測不到")
    if problems:
        raise SystemExit(f"[week {week}] 產後驗證不過,拒產:\n  - " + "\n  - ".join(problems))

    # ── 寫檔 ────────────────────────────────────────────────
    wk_dir = out_root / f"week{week:02d}"
    wk_dir.mkdir(parents=True, exist_ok=True)
    for d in devs:
        cols = ["sim_t", "sim_h", "state"] + tag_names[d.id]
        with open(wk_dir / f"{d.id}.csv", "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(cols)
            for r in rows[d.id]:
                w.writerow([r.get(c, "") for c in cols])
        (wk_dir / f"{d.id}.json").write_text(
            json.dumps({"synthetic": True, "device": d.id, "template": d.template,
                        "rows": rows[d.id]}, ensure_ascii=False), encoding="utf-8")

    manifest = {
        "synthetic": True,
        "week": week,
        "title": spec.get("title"),
        "faults": "clear" if clean_week else {k: v for k, v in (faults or {}).items()},
        "kept_from_previous": bool(spec.get("_kept_from_previous")),
        "scenario": scenario,
        "seed": seed, "week_seed": week_seed,
        "engine_commit": _git(root, "rev-parse", "HEAD"),
        "sim_days": sim_days, "step_min": step_min,
        "onset_day": None if clean_week else onset_day,
        "devices": [{"id": d.id, "template": d.template, "rows": len(rows[d.id])} for d in devs],
        "n_injected": len(injected),      # 只給數量,誰被注入在教師答案卷
    }
    (wk_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1),
                                          encoding="utf-8")
    (wk_dir / "README.txt").write_text(
        f"第 {week} 週凍結資料包:{spec.get('title')}\n"
        "==============================\n"
        "⚠ 全部為合成數據(synthetic),由模擬引擎產生,非真實場域量測。\n\n"
        f"內容:{len(devs)} 台設備、{sim_days:g} 個模擬天(取樣 {step_min:g} 分鐘)。\n"
        "欄位:sim_t(模擬秒)、sim_h(模擬小時)、state,其餘為觀測訊號(單位見平台目錄)。\n"
        "分組時間請用 sim_t,不要用你電腦的時鐘。\n"
        + ("" if clean_week else
           f"本週部分設備存在異常(數量與對象不公布)。異常自第 {onset_day:g} 天起,"
           "之前的資料可當正常基線。你的任務依當週作業說明。\n"),
        encoding="utf-8")

    return {"week": week, "title": spec.get("title"), "week_seed": week_seed,
            "injected": injected,
            "clean_controls": [] if clean_week else
                [d.id for d in devs if _fault_component(d) is not None
                 and d.id not in {i["device"] for i in injected}]}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="scenarios/default_park.yaml")
    ap.add_argument("--course", default="scenarios/course_weeks.yaml")
    ap.add_argument("--out", default="packs")
    ap.add_argument("--weeks", default=None, help="只產這些週(逗號分隔),如 4,8;留空=全部定義週")
    ap.add_argument("--seed", type=int, default=20260101, help="主種子(全班同一份包時用)")
    ap.add_argument("--student", default=None,
                    help="學號:改用課程統一種子表(tools/course_seed.py)推導主種子,"
                         "與 make_assignment 的 base seed 同源 —— 每人不同、可重現")
    ap.add_argument("--master", default=DEFAULT_MASTER, help="課程鹽(配合 --student)")
    ap.add_argument("--sim-days", type=float, default=7.0)
    ap.add_argument("--step-min", type=float, default=1.0)
    ap.add_argument("--onset-day", type=float, default=2.0, help="注入週的異常起始天(之前是乾淨基線)")
    ap.add_argument("--zip", action="store_true", help="每週各打包 weekNN.zip")
    args = ap.parse_args()

    root = Path(__file__).resolve().parents[1]
    if args.student:
        args.seed = student_seed(args.master, args.student)
        print(f"== 學號 {args.student} → 課程種子 {args.seed}(master={args.master})==")
    course = yaml.safe_load((root / args.course).read_text(encoding="utf-8"))["course"]
    specs = resolve_week_specs(course)
    weeks = ([int(x) for x in args.weeks.split(",")] if args.weeks else sorted(specs))
    unknown = [w for w in weeks if w not in specs]
    if unknown:
        raise SystemExit(f"course_weeks.yaml 沒有定義這些週:{unknown}(有:{sorted(specs)})")

    out_root = root / args.out
    ans_dir = out_root / "answers"
    ans_dir.mkdir(parents=True, exist_ok=True)

    for wk in weeks:
        print(f"── week {wk}:{specs[wk].get('title')} ──")
        answers = build_week(root, args.scenario, wk, specs[wk], args.seed,
                             args.sim_days, args.step_min, out_root,
                             onset_day=args.onset_day)
        (ans_dir / f"week{wk:02d}.json").write_text(
            json.dumps(answers, ensure_ascii=False, indent=1), encoding="utf-8")
        n_inj = len(answers["injected"])
        print(f"   ✓ 驗證通過;注入 {n_inj} 台" + (f"(答案卷 answers/week{wk:02d}.json)" if n_inj else ""))
        if args.zip:
            wk_dir = out_root / f"week{wk:02d}"
            zpath = wk_dir.with_suffix(".zip")
            with zipfile.ZipFile(zpath, "w", zipfile.ZIP_DEFLATED) as z:
                for p in sorted(wk_dir.iterdir()):
                    z.write(p, arcname=f"{wk_dir.name}/{p.name}")
            print(f"   打包 {zpath.name}({zpath.stat().st_size / 1e6:.1f} MB)")

    print(f"\n完成:{len(weeks)} 週 → {out_root}(教師答案卷在 {ans_dir},發包時不要一起發)")


if __name__ == "__main__":
    main()
