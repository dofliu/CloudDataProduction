r"""出作業:依名冊產「每學號各自一份、可重現、含私有測試集」的 PdM 資料(Kaggle 式)。

每個學生拿到:
  assignments/<sid>/train_<device>.csv   訓練集(含 ground-truth 標籤,supervised 用)
  assignments/<sid>/test_features.csv    私有測試集(**去掉標籤欄**),學生對它預測後繳交
老師留(不發):
  assignments/_answer/<sid>_test_full.csv   測試集含標籤(評分用)
  assignments/_answer/answer_key.json       每學號的 device/component/故障日/seed

設計理念(防「叫 AI 做完就結束」):
  - **每學號 seed = 學號雜湊** → 故障時間/訊號各不同,同學互相 copy 不了、各自可重現。
  - **私有測試集**(不同 seed 的同型故障)→ 學生在沒看過的資料上被評,AI 也得真的會泛化。
  - 配合**線上活廠驗收**(見 docs/作業範本_預測性維護.md)才是完整評分。

跑法(用 venv python):
  .\.venv\Scripts\python.exe tools\make_assignment.py --roster roster.txt
  .\.venv\Scripts\python.exe tools\make_assignment.py --students S001,S002,S003 --device comp-01 --component motor_bearing
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GEN = ROOT / "tools" / "generate_dataset.py"
# 學生看不到的「答案/真值」欄位 → 從測試集移除,只留觀測值給學生預測
LABEL_COLS = ["gt_health_min", "gt_rul_sim_s", "is_sensor_fault", "ttf_sim_s", "fail_within_24h"]


def stable_seed(s: str) -> int:
    """穩定雜湊(非 Python hash,跨機跨進程一致)→ 每學號固定但各不同的種子。"""
    return int(hashlib.sha256(s.encode("utf-8")).hexdigest(), 16) % (2 ** 31)


def run_gen(out: Path, *, device: str, component: str, onset_day: int, seed: int,
            scale: float, sensor: float, days: float, step: float) -> None:
    subprocess.run(
        [sys.executable, str(GEN),
         "--devices", device, "--inject", f"{device}:{component}:{onset_day}",
         "--degradation-scale", str(scale), "--sensor-fault-prob", str(sensor),
         "--sim-days", str(days), "--step-min", str(step), "--seed", str(seed),
         "--out", str(out)],
        check=True, cwd=str(ROOT), stdout=subprocess.DEVNULL,
    )


def strip_labels(src: Path, dst: Path) -> int:
    """把測試集的標籤欄拿掉 → 給學生的 test_features.csv。回傳列數。"""
    with open(src, encoding="utf-8", newline="") as f:
        rows = list(csv.reader(f))
    header = rows[0]
    keep = [i for i, c in enumerate(header) if c not in LABEL_COLS]
    with open(dst, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        for r in rows:
            w.writerow([r[i] for i in keep])
    return len(rows) - 1


def read_roster(args) -> list[str]:
    if args.students:
        return [s.strip() for s in args.students.split(",") if s.strip()]
    if args.roster:
        return [ln.strip() for ln in Path(args.roster).read_text(encoding="utf-8").splitlines()
                if ln.strip() and not ln.startswith("#")]
    return ["S001", "S002", "S003"]   # 預設示範名冊


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--roster", help="名冊檔(每行一個學號)")
    ap.add_argument("--students", help="逗號分隔學號(覆寫 roster)")
    ap.add_argument("--out", default="assignments")
    ap.add_argument("--device", default="comp-01", help="作業設備(如 comp-01 / cnc-08)")
    ap.add_argument("--component", default="motor_bearing", help="要預測的故障元件")
    ap.add_argument("--master", default="course-2026S1", help="課程鹽,換它整批換實現")
    ap.add_argument("--sim-days", type=float, default=35.0)
    ap.add_argument("--step-min", type=float, default=10.0)
    ap.add_argument("--degradation-scale", type=float, default=0.12, help="放慢自然退化 → 乾淨單一故障")
    ap.add_argument("--sensor-prob", type=float, default=0.0, help=">0 埋感測器故障陷阱")
    args = ap.parse_args()

    roster = read_roster(args)
    out = ROOT / args.out
    ans_dir = out / "_answer"
    ans_dir.mkdir(parents=True, exist_ok=True)
    answer = {}
    print(f"== 出作業:{len(roster)} 位學生 · 設備 {args.device} · 故障 {args.component} ==")

    for sid in roster:
        sdir = out / sid
        sdir.mkdir(parents=True, exist_ok=True)
        base = stable_seed(f"{args.master}|{sid}")
        tseed = stable_seed(f"{args.master}|{sid}|test")
        train_onset = 12 + base % 16          # 故障日各學號不同(12~27 天)
        test_onset = 12 + tseed % 16

        # 訓練集(含標籤,發給學生)
        run_gen(sdir, device=args.device, component=args.component, onset_day=train_onset,
                seed=base, scale=args.degradation_scale, sensor=args.sensor_prob,
                days=args.sim_days, step=args.step_min)
        (sdir / f"{args.device}.csv").rename(sdir / f"train_{args.device}.csv")

        # 測試集(老師留含標籤;發給學生的去標籤)
        tmp = ans_dir / f"_tmp_{sid}"
        run_gen(tmp, device=args.device, component=args.component, onset_day=test_onset,
                seed=tseed, scale=args.degradation_scale, sensor=args.sensor_prob,
                days=args.sim_days, step=args.step_min)
        full = ans_dir / f"{sid}_test_full.csv"
        (tmp / f"{args.device}.csv").rename(full)
        (tmp / "manifest.json").unlink(missing_ok=True)
        tmp.rmdir()
        n_test = strip_labels(full, sdir / "test_features.csv")

        answer[sid] = {"device": args.device, "component": args.component,
                       "train_onset_day": train_onset, "test_onset_day": test_onset,
                       "seed": base, "test_seed": tseed, "test_rows": n_test,
                       "test_full": f"_answer/{sid}_test_full.csv"}
        print(f"  {sid:8} train 故障@day{train_onset} · test {n_test} 列(私有故障@day{test_onset})")

    (ans_dir / "answer_key.json").write_text(
        json.dumps({"master": args.master, "students": answer}, ensure_ascii=False, indent=2),
        encoding="utf-8")
    print(f"\n學生資料夾:{out}/<學號>/(發給學生)")
    print(f"答案金鑰:{ans_dir}/(老師留,**勿發**)→ 評分用 tools/grade_assignment.py")


if __name__ == "__main__":
    main()
