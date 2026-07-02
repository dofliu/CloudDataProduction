r"""評分(製程漂移 subtle-fault 作業):對「製程健康度 gt_health_min」迴歸評分。

半導體腔體的 process_drift 是**指標型退化**(不讓設備進 fault),所以它不是「會不會壞」的
分類題,而是「從可見訊號(particle_count / chamber_pressure / pump_current …)回推**隱藏製程健康度**」
的迴歸題 —— 沒有單一警報跳,要靠多訊號趨勢。故用本評分器(而非 grade_assignment.py 的 F1/RUL)。

學生繳交一份 CSV(對 test_features 的每列預測):
    sim_t, pred_health          預測製程健康度(1=完全正常,0=嚴重漂移;≈良率健康)

評分(離線,滿分 100;線上活廠另計,見 rubric):
    擬合 60 分 = 60 × max(0, 1 − MAE / 0.15)      # 健康度 MAE,0.15 內線性給分
    決定係數 40 分 = 40 × max(0, R²)              # 抓到趨勢的程度

跑法(用 venv python):
    .\.venv\Scripts\python.exe tools\grade_chamber_assignment.py --sid S001 --pred submissions\S001_pred.csv
    .\.venv\Scripts\python.exe tools\grade_chamber_assignment.py --subs-dir submissions   # 整批
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd
from sklearn.metrics import mean_absolute_error, r2_score

ROOT = Path(__file__).resolve().parents[1]
TARGET = "gt_health_min"


def grade_one(sid: str, pred_path: Path, ans: dict, ans_dir: Path) -> dict:
    info = ans["students"].get(sid)
    if info is None:
        return {"sid": sid, "error": "答案金鑰沒有此學號"}
    truth = pd.read_csv(ans_dir.parent / info["test_full"])
    if TARGET not in truth.columns:
        return {"sid": sid, "error": f"測試集缺 {TARGET} 欄(此題應以 process_drift 等指標型故障產生)"}
    truth = truth[truth[TARGET].notna()].copy()
    truth["k"] = truth["sim_t"].round(1)
    pred = pd.read_csv(pred_path)
    if "pred_health" not in pred.columns:
        return {"sid": sid, "error": "繳交檔需有欄位 pred_health(對 test_features 每列的製程健康度預測)"}
    pred["k"] = pred["sim_t"].round(1)
    m = truth.merge(pred, on="k", how="inner", suffixes=("", "_p"))
    if len(m) == 0:
        return {"sid": sid, "error": "預測的 sim_t 對不到測試集(檢查是否用 test_features 的列)"}

    yt = m[TARGET].astype(float).clip(0.0, 1.0)
    yp = m["pred_health"].astype(float).clip(0.0, 1.0)
    mae = float(mean_absolute_error(yt, yp))
    r2 = float(r2_score(yt, yp)) if yt.nunique() > 1 else 0.0
    score = 60.0 * max(0.0, 1.0 - mae / 0.15) + 40.0 * max(0.0, r2)
    return {
        "sid": sid, "matched_rows": int(len(m)), "target": TARGET,
        "health_mae": round(mae, 4), "r2": round(r2, 3),
        "offline_score": round(score, 1),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--assignments", default="assignments")
    ap.add_argument("--sid")
    ap.add_argument("--pred")
    ap.add_argument("--subs-dir", help="整批:資料夾內 <sid>_pred.csv")
    args = ap.parse_args()

    ans_dir = ROOT / args.assignments / "_answer"
    ans = json.loads((ans_dir / "answer_key.json").read_text(encoding="utf-8"))

    jobs = []
    if args.subs_dir:
        for p in sorted(Path(args.subs_dir).glob("*_pred.csv")):
            jobs.append((p.stem.replace("_pred", ""), p))
    elif args.sid and args.pred:
        jobs.append((args.sid, Path(args.pred)))
    else:
        sys.exit("需 --sid + --pred,或 --subs-dir")

    print(f"{'學號':<10}{'匹配列':>7}{'健康MAE':>10}{'R2':>8}{'離線分':>8}")
    results = []
    for sid, p in jobs:
        r = grade_one(sid, p, ans, ans_dir)
        results.append(r)
        if "error" in r:
            print(f"{sid:<10}  ERROR: {r['error']}")
        else:
            print(f"{sid:<10}{r['matched_rows']:>7}{r['health_mae']:>10}{r['r2']:>8}{r['offline_score']:>8}")
    (ROOT / args.assignments / "grades_chamber.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n成績已存:{args.assignments}/grades_chamber.json(線上活廠分另計,見 rubric)")


if __name__ == "__main__":
    main()
