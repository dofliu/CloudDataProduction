r"""腔體「製程漂移」作業 基準解(給學生的起手式)。

半導體腔體的 process_drift 不會讓設備 fault、也沒單一警報,是「良率悄悄變差」的**迴歸題**:
從可見訊號(particle_count / chamber_pressure / vacuum_pump_current …)回推**隱藏製程健康度** gt_health_min。

這支做完整流程:讀作業訓練集 → 訓迴歸器 → 對私有測試集預測 → 輸出可繳交 CSV。
繳交後老師用 [tools/grade_chamber_assignment.py](../tools/grade_chamber_assignment.py) 評 MAE / R²。
學生要做的是把這個笨基準(RandomForest + 簡單滾動特徵)換成更會抓早期 subtle 區的模型。

誠實做法:**特徵只用可見訊號**(不碰 gt_*);排除單調計數器 wafer_count(會洩漏時間進度);
滾動特徵讓雜訊的 particle_count 平滑,早期趨勢更明顯。

用法(先由老師出題產生 assignments/<學號>/):
    .\.venv\Scripts\python.exe student_kit\p5_chamber_baseline.py --sid S001
    → 印自我評估(train 內時間切) + 產 submissions\S001_pred.csv

相依:pandas / scikit-learn(見 student_kit/requirements-ml.txt)。
"""
from __future__ import annotations

import argparse
import os
import sys

try:                                   # Windows 主控台常是 cp950,中文 / R² 會炸 → 強制 UTF-8
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor
from sklearn.metrics import mean_absolute_error, r2_score

TARGET = "gt_health_min"
# 不可當特徵:meta、字串狀態、ground-truth 標籤、單調計數器(洩漏時間進度)
_DROP = {"sim_t", "sim_h", "state", "gt_health_min", "gt_rul_sim_s",
         "is_sensor_fault", "cycle_id", "ttf_sim_s", "fail_within_24h", "wafer_count"}


def feature_columns(df: pd.DataFrame) -> list[str]:
    return [c for c in df.columns
            if c not in _DROP and np.issubdtype(df[c].dtype, np.number)]


def add_rolling(df: pd.DataFrame, cols: list[str], window: int) -> tuple[pd.DataFrame, list[str]]:
    """滾動 mean/std/slope:平滑雜訊、凸顯趨勢。作業是單一長 run,直接對整段滾動。"""
    out = df.sort_values("sim_t").copy()
    feats = list(cols)
    for c in cols:
        out[f"{c}_rmean"] = out[c].rolling(window, min_periods=1).mean()
        out[f"{c}_rstd"] = out[c].rolling(window, min_periods=2).std().fillna(0.0)
        out[f"{c}_slope"] = out[c].diff(window).fillna(0.0) / window
        feats += [f"{c}_rmean", f"{c}_rstd", f"{c}_slope"]
    return out, feats


def build_model() -> RandomForestRegressor:
    return RandomForestRegressor(n_estimators=80, max_depth=12, min_samples_leaf=15,
                                 n_jobs=-1, random_state=0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sid", default="S001", help="學號(對應 assignments/<sid>/)")
    ap.add_argument("--device", default="chamber-01")
    ap.add_argument("--assignments", default="assignments")
    ap.add_argument("--submissions", default="submissions")
    ap.add_argument("--window", type=int, default=10, help="滾動視窗(步)")
    args = ap.parse_args()

    sdir = os.path.join(args.assignments, args.sid)
    train_path = os.path.join(sdir, f"train_{args.device}.csv")
    test_path = os.path.join(sdir, "test_features.csv")
    if not os.path.exists(train_path):
        raise SystemExit(f"找不到訓練集:{train_path}(先請老師用 make_assignment.py 出題)")

    train = pd.read_csv(train_path)
    test = pd.read_csv(test_path)
    print(f"== 腔體製程漂移 基準解:{args.sid} · {args.device} ==")
    print(f"   train {len(train)} 列 · test {len(test)} 列 · 目標 {TARGET}\n")

    base_cols = [c for c in feature_columns(train) if c in test.columns]
    trd, feats = add_rolling(train, base_cols, args.window)
    ted, _ = add_rolling(test, base_cols, args.window)

    # ── 自我評估:train 內隨機 20% 當內部驗證(涵蓋整段健康度範圍,才有資訊量;
    #    別用時間尾段切 —— 漂移後段 health 飽和在 0、常數無變異,R² 會失真)──
    rng = np.random.default_rng(0)
    mask = rng.random(len(trd)) < 0.8
    a, b = trd[mask], trd[~mask]
    m = build_model(); m.fit(a[feats].fillna(0.0), a[TARGET])
    vp = np.clip(m.predict(b[feats].fillna(0.0)), 0, 1)
    print("【自我評估】train 內隨機 20%(粗估;涵蓋整段健康度範圍)")
    print(f"  健康度 MAE {mean_absolute_error(b[TARGET], vp):.4f} · R² {r2_score(b[TARGET], vp):.3f}")
    imp = sorted(zip(feats, m.feature_importances_), key=lambda x: -x[1])[:6]
    print("  top 特徵:", ", ".join(f"{n}={w:.2f}" for n, w in imp), "\n")

    # ── 用全部 train 重訓 → 對私有測試集預測 → 輸出繳交檔 ──
    full = build_model(); full.fit(trd[feats].fillna(0.0), trd[TARGET])
    pred = np.clip(full.predict(ted[feats].fillna(0.0)), 0, 1)
    os.makedirs(args.submissions, exist_ok=True)
    out = os.path.join(args.submissions, f"{args.sid}_pred.csv")
    pd.DataFrame({"sim_t": test["sim_t"], "pred_health": np.round(pred, 4)}).to_csv(out, index=False)
    print(f"繳交檔已產出 → {out}({len(pred)} 列)")
    print("提醒:particle_count 與製程健康強相關,離線 R² 本來就容易很高 —— 別以為這樣就懂了。")
    print("真正的挑戰在:(1) 早期偵測 —— 漂移剛起(健康 0.9→0.7、particle 還沒明顯動)時就抓到趨勢;")
    print("            (2) 線上活廠 —— 對老師之後才注入、你看不到答案的未知漂移,即時示警且不誤報(rubric 30 分)。")
    print("            老師若開 --sensor-prob,particle 讀值會被感測器故障干擾 → 得靠多訊號穩健判斷。")


if __name__ == "__main__":
    main()
