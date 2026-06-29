r"""評分:把學生對「私有測試集」的預測,對答案金鑰算分(離線部分;線上部分走 /api/predictions/scores)。

學生繳交一份 CSV(對 test_features 的每列預測),欄位:
    sim_t, pred_fail_within_24h            分類預測(0/1),且 / 或
    sim_t, pred_rul_h                       RUL 預測(剩餘壽命,小時)

評分(離線,滿分 100;線上活廠另計,見 rubric):
    分類 50 分 = 50 × F1
    RUL  50 分 = 50 × max(0, 1 − MAE_h / 48)   # MAE 48h 內線性給分

跑法:
    .\.venv\Scripts\python.exe tools\grade_assignment.py --sid S001 --pred submissions\S001_pred.csv
    .\.venv\Scripts\python.exe tools\grade_assignment.py --subs-dir submissions   # 整批
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pandas as pd
from sklearn.metrics import f1_score, mean_absolute_error

ROOT = Path(__file__).resolve().parents[1]


def grade_one(sid: str, pred_path: Path, ans: dict, ans_dir: Path) -> dict:
    info = ans["students"].get(sid)
    if info is None:
        return {"sid": sid, "error": "答案金鑰沒有此學號"}
    truth = pd.read_csv(ans_dir.parent / info["test_full"])
    truth = truth[truth["ttf_sim_s"].notna()].copy()        # 去掉末段 censored 列
    truth["k"] = truth["sim_t"].round(1)
    pred = pd.read_csv(pred_path)
    pred["k"] = pred["sim_t"].round(1)
    m = truth.merge(pred, on="k", how="inner", suffixes=("", "_p"))
    if len(m) == 0:
        return {"sid": sid, "error": "預測的 sim_t 對不到測試集(檢查是否用 test_features 的列)"}

    out = {"sid": sid, "matched_rows": int(len(m)), "fault_component": info["component"]}
    score = 0.0
    if "pred_fail_within_24h" in m.columns:
        yt = m["fail_within_24h"].astype(int)
        yp = (m["pred_fail_within_24h"].astype(float) >= 0.5).astype(int)
        f1 = f1_score(yt, yp, zero_division=0)
        out["f1"] = round(float(f1), 3)
        score += 50 * f1
    if "pred_rul_h" in m.columns:
        mae = mean_absolute_error(m["ttf_sim_s"] / 3600.0, m["pred_rul_h"].astype(float))
        out["rul_mae_h"] = round(float(mae), 2)
        score += 50 * max(0.0, 1.0 - mae / 48.0)
    out["offline_score"] = round(score, 1)
    return out


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

    print(f"{'學號':<10}{'匹配列':>7}{'F1':>8}{'RUL MAE(h)':>12}{'離線分':>8}")
    results = []
    for sid, p in jobs:
        r = grade_one(sid, p, ans, ans_dir)
        results.append(r)
        if "error" in r:
            print(f"{sid:<10}  ERROR: {r['error']}")
        else:
            print(f"{sid:<10}{r['matched_rows']:>7}{r.get('f1','—'):>8}"
                  f"{r.get('rul_mae_h','—'):>12}{r['offline_score']:>8}")
    (ROOT / args.assignments / "grades.json").write_text(
        json.dumps(results, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n成績已存:{args.assignments}/grades.json(線上活廠分另計,見 rubric)")


if __name__ == "__main__":
    main()
