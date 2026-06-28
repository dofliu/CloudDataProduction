r"""階段二 基準 ML 範例:證明「合成資料學得起來」,並當學生的起點。

用資料集產生器([tools/generate_dataset.py](../tools/generate_dataset.py))產的帶標籤 CSV,訓兩個模型:
  1. 故障分類(fail_within_24h):從「當下可觀測訊號」判斷 24h 內會不會故障 → F1 / ROC-AUC。
  2. RUL 迴歸(ttf_sim_s):預測「距實際故障還有多久」→ MAE / RMSE(小時)。

誠實的評估:**特徵只用學生看得到的觀測訊號**(不碰 ground-truth 的 health/RUL);
**滾動特徵在每個 run-to-failure 循環內計算**(不跨循環洩漏);**train/test 依「機台」切**
(測試機台訓練時沒看過 → 驗證能不能類推到沒看過的同型設備)。

⚠ 資料為合成(synthetic):模型學的是「我們假設的退化物理」,適合教 ML 工作流程,
   不保證直接遷移到真實設備(domain gap)。這正是「合成資料教學」的標準定位。

用法(先產資料,再訓練):
    .\.venv\Scripts\python.exe tools\generate_dataset.py --sim-days 120 --step-min 10 --out dataset
    .\.venv\Scripts\python.exe student_kit\p4_train_baseline.py --pattern "cnc-*.csv"

相依:pandas / scikit-learn / matplotlib(見 student_kit/requirements-ml.txt)。
"""
from __future__ import annotations

import argparse
import glob
import json
import math
import os
import re
import sys

try:                                   # Windows 主控台常是 cp950,中文 / R² 會炸 → 強制 UTF-8
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier, RandomForestRegressor
from sklearn.metrics import (accuracy_score, confusion_matrix, f1_score,
                             mean_absolute_error, mean_squared_error,
                             precision_score, r2_score, recall_score, roc_auc_score)

# 不可當特徵的欄位:meta、字串狀態、ground-truth 標籤、單調計數器(會洩漏循環進度)
_LABELS = {"gt_health_min", "gt_rul_sim_s", "is_sensor_fault", "cycle_id",
           "ttf_sim_s", "fail_within_24h"}
_META = {"sim_t", "sim_h", "state"}


def _device_id(path: str) -> str:
    return os.path.splitext(os.path.basename(path))[0]


def load_frames(pattern: str, data_dir: str):
    files = sorted(glob.glob(os.path.join(data_dir, pattern)))
    if not files:
        raise SystemExit(f"找不到資料:{os.path.join(data_dir, pattern)}(先跑 generate_dataset.py)")
    frames = []
    for f in files:
        df = pd.read_csv(f)
        df["device"] = _device_id(f)
        frames.append(df)
    return files, frames


def feature_columns(df: pd.DataFrame) -> list[str]:
    cols = []
    for c in df.columns:
        if c in _LABELS or c in _META or c == "device":
            continue
        if not np.issubdtype(df[c].dtype, np.number):
            continue
        if re.search(r"count|energy|part_count|shot_count|total", c):  # 單調計數器 → 洩漏
            continue
        cols.append(c)
    return cols


def add_rolling(df: pd.DataFrame, cols: list[str], window: int) -> tuple[pd.DataFrame, list[str]]:
    """每個 (device, cycle) 內算滾動 mean/std/slope —— 不跨循環洩漏。"""
    out = df.copy()
    feats = list(cols)
    g = out.groupby(["device", "cycle_id"], sort=False)
    for c in cols:
        out[f"{c}_rmean"] = g[c].transform(lambda s: s.rolling(window, min_periods=1).mean())
        out[f"{c}_rstd"] = g[c].transform(lambda s: s.rolling(window, min_periods=2).std().fillna(0.0))
        out[f"{c}_slope"] = g[c].transform(lambda s: s.diff(window).fillna(0.0) / window)
        feats += [f"{c}_rmean", f"{c}_rstd", f"{c}_slope"]
    return out, feats


def rmse(y, p) -> float:
    return float(math.sqrt(mean_squared_error(y, p)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="dataset")
    ap.add_argument("--pattern", default="cnc-*.csv", help='同型設備 glob,如 "cnc-*.csv" / "wt-*.csv"')
    ap.add_argument("--window", type=int, default=12, help="滾動視窗(步);10 分/步 → 12=2h")
    ap.add_argument("--test-frac", type=float, default=0.3, help="保留多少比例的機台當測試集")
    ap.add_argument("--out", default="dataset/baseline_report.json")
    args = ap.parse_args()

    files, frames = load_frames(args.pattern, args.data)
    devices = [_device_id(f) for f in files]
    n_test = max(1, round(len(devices) * args.test_frac))
    train_dev, test_dev = devices[:-n_test], devices[-n_test:]
    print(f"== 基準 ML:{args.pattern}  {len(devices)} 台機台 ==")
    print(f"   train 機台 {len(train_dev)}:{train_dev}")
    print(f"   test  機台 {len(test_dev)}(訓練時沒看過):{test_dev}\n")

    raw = pd.concat(frames, ignore_index=True)
    base_cols = feature_columns(raw)
    data, feats = add_rolling(raw, base_cols, args.window)
    data = data.dropna(subset=["ttf_sim_s"])            # 沒有故障標籤的尾段循環不納入

    tr = data[data["device"].isin(train_dev)]
    te = data[data["device"].isin(test_dev)]
    Xtr, Xte = tr[feats].fillna(0.0), te[feats].fillna(0.0)

    # ── 1) 故障分類:fail_within_24h ──────────────────────
    ytr_c, yte_c = tr["fail_within_24h"].astype(int), te["fail_within_24h"].astype(int)
    clf = RandomForestClassifier(n_estimators=120, max_depth=14, min_samples_leaf=20,
                                 class_weight="balanced", n_jobs=-1, random_state=0)
    clf.fit(Xtr, ytr_c)
    proba = clf.predict_proba(Xte)[:, 1]
    pred_c = (proba >= 0.5).astype(int)
    pos_rate = float(yte_c.mean())
    cls = {
        "positive_rate": round(pos_rate, 3),
        "accuracy": round(accuracy_score(yte_c, pred_c), 3),
        "precision": round(precision_score(yte_c, pred_c, zero_division=0), 3),
        "recall": round(recall_score(yte_c, pred_c, zero_division=0), 3),
        "f1": round(f1_score(yte_c, pred_c, zero_division=0), 3),
        "roc_auc": round(roc_auc_score(yte_c, proba), 3) if yte_c.nunique() > 1 else None,
        "confusion_matrix": confusion_matrix(yte_c, pred_c).tolist(),
    }
    print("【故障分類 fail_within_24h】(held-out 機台)")
    print(f"  正樣本率 {cls['positive_rate']}(多數類基準 acc={max(pos_rate,1-pos_rate):.3f})")
    print(f"  accuracy {cls['accuracy']} · precision {cls['precision']} · recall {cls['recall']} "
          f"· F1 {cls['f1']} · ROC-AUC {cls['roc_auc']}")
    print(f"  confusion [[TN,FP],[FN,TP]] = {cls['confusion_matrix']}\n")

    # ── 2) RUL 迴歸:ttf_sim_s(→ 小時)────────────────────
    ytr_r = tr["ttf_sim_s"].to_numpy() / 3600.0
    yte_r = te["ttf_sim_s"].to_numpy() / 3600.0
    reg = RandomForestRegressor(n_estimators=120, max_depth=16, min_samples_leaf=20,
                                n_jobs=-1, random_state=0)
    reg.fit(Xtr, ytr_r)
    pred_r = reg.predict(Xte)
    naive = rmse(yte_r, np.full_like(yte_r, ytr_r.mean()))      # 預測訓練平均的基準
    rg = {
        "mae_h": round(mean_absolute_error(yte_r, pred_r), 2),
        "rmse_h": round(rmse(yte_r, pred_r), 2),
        "r2": round(r2_score(yte_r, pred_r), 3),
        "naive_rmse_h": round(naive, 2),
    }
    print("【RUL 迴歸 ttf(剩餘壽命,小時)】(held-out 機台)")
    print(f"  MAE {rg['mae_h']} h · RMSE {rg['rmse_h']} h · R² {rg['r2']} "
          f"(只猜平均的基準 RMSE={rg['naive_rmse_h']} h → 模型勝出)\n")

    # ── 3) 提前量(lead time):分類器在故障前多久首次告警 ──
    leads = []
    for (dev, cyc), grp in te.groupby(["device", "cycle_id"], sort=False):
        grp = grp.sort_values("sim_t")
        p = clf.predict_proba(grp[feats].fillna(0.0))[:, 1]
        fire = np.where(p >= 0.5)[0]
        if len(fire):
            leads.append(float(grp["ttf_sim_s"].iloc[fire[0]]) / 3600.0)
    lead = {"cycles": int(len(leads)),
            "median_lead_h": round(float(np.median(leads)), 1) if leads else None,
            "p25_lead_h": round(float(np.percentile(leads, 25)), 1) if leads else None}
    print("【提前量 lead time】分類器在實際故障前首次告警的領先時間")
    print(f"  測試循環數 {lead['cycles']} · 中位提前 {lead['median_lead_h']} h "
          f"· 25 百分位 {lead['p25_lead_h']} h\n")

    # 重要特徵(教學:看模型學到什麼)
    imp = sorted(zip(feats, clf.feature_importances_), key=lambda x: -x[1])[:6]
    print("【分類器 top 特徵】", ", ".join(f"{n}={w:.2f}" for n, w in imp))

    report = {"synthetic": True, "pattern": args.pattern, "window": args.window,
              "train_devices": train_dev, "test_devices": test_dev,
              "classification": cls, "rul_regression": rg, "lead_time": lead,
              "top_features": [[n, round(float(w), 4)] for n, w in imp],
              "note": "合成資料;模型學的是假設物理,適合教學,不保證遷移真實設備(domain gap)。"}
    os.makedirs(os.path.dirname(args.out) or ".", exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n報告已存:{args.out}")

    _try_plot(te, reg, feats, args)


def _try_plot(te, reg, feats, args):
    try:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
    except Exception:
        return
    # 取一個測試循環,畫 真實 RUL vs 預測 RUL + 振動
    for (dev, cyc), grp in te.groupby(["device", "cycle_id"], sort=False):
        if len(grp) < 30:
            continue
        grp = grp.sort_values("sim_t")
        h = grp["sim_t"].to_numpy() / 3600.0
        true_rul = grp["ttf_sim_s"].to_numpy() / 3600.0
        pred_rul = reg.predict(grp[feats].fillna(0.0))
        vib_col = next((c for c in grp.columns if "vibration" in c), None)
        fig, ax1 = plt.subplots(figsize=(8, 4))
        ax1.plot(h, true_rul, label="真實 RUL", color="#2f7a4f")
        ax1.plot(h, pred_rul, label="預測 RUL", color="#b5743a", ls="--")
        ax1.set_xlabel("sim 時間 (h)"); ax1.set_ylabel("剩餘壽命 RUL (h)"); ax1.legend(loc="upper right")
        if vib_col:
            ax2 = ax1.twinx(); ax2.plot(h, grp[vib_col], color="#888", alpha=0.5)
            ax2.set_ylabel(vib_col, color="#888")
        ax1.set_title(f"{dev} cycle {cyc}(合成資料)— RUL 預測 vs 真實")
        out_png = os.path.join(args.data, "baseline_rul_example.png")
        fig.tight_layout(); fig.savefig(out_png, dpi=110); plt.close(fig)
        print(f"範例圖已存:{out_png}")
        return


if __name__ == "__main__":
    main()
