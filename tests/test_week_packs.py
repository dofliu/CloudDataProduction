"""每週凍結資料包 smoke(tools/make_week_packs.py,ROADMAP TODO #1 的 glue)。

小參數(2 sim 天、5 分鐘取樣、onset 0.5 天)跑一個 clear 週(W4)+ 一個注入週(W8):
  - 兩週都產得出來且**產後驗證通過**(W8 的健康度下降可偵測);
  - 學生包不含 ground-truth 欄位;教師答案卷與 manifest 齊備;
  - keep 週展開正確(W11 沿用 W10 的感測器條件)。

用法:
    python3 tests/test_week_packs.py
"""
from __future__ import annotations

import csv
import json
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

FAIL: list[str] = []


def check(cond: bool, msg: str) -> None:
    print(f"  {'PASS' if cond else 'FAIL'}  {msg}")
    if not cond:
        FAIL.append(msg)


def main() -> None:
    print("每週凍結資料包 smoke")

    # keep 展開(純函數,不用跑模擬)
    from tools.make_week_packs import resolve_week_specs
    import yaml
    course = yaml.safe_load((ROOT / "scenarios" / "course_weeks.yaml").read_text(encoding="utf-8"))["course"]
    specs = resolve_week_specs(course)
    check(isinstance(specs[11]["faults"], dict) and specs[11]["faults"].get("type") == "sensor_drift",
          "W11(keep)展開為 W10 的感測器漂移條件")
    check(specs[7]["faults"] == "clear", "W7 展開後仍為 clear(教材 ★ 項)")

    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "packs"
        r = subprocess.run(
            [sys.executable, str(ROOT / "tools" / "make_week_packs.py"),
             "--weeks", "4,8", "--sim-days", "2", "--step-min", "5",
             "--onset-day", "0.5", "--out", str(out)],
            capture_output=True, text=True, cwd=ROOT)
        ok = r.returncode == 0
        check(ok, f"W4 + W8 產出且驗證通過(exit {r.returncode})")
        if not ok:
            print(r.stdout[-2000:], r.stderr[-2000:])
            _finish()

        for wk in (4, 8):
            wk_dir = out / f"week{wk:02d}"
            csvs = sorted(wk_dir.glob("*.csv"))
            check(len(csvs) == 11, f"week{wk:02d} 有 11 台設備 CSV(實際 {len(csvs)})")
            check((wk_dir / "manifest.json").exists() and (wk_dir / "README.txt").exists(),
                  f"week{wk:02d} 有 manifest + README")
            head = next(csv.reader(open(csvs[0], encoding="utf-8")))
            leaked = [c for c in head if c.startswith("gt_") or "health" in c or "rul" in c]
            check(not leaked, f"week{wk:02d} 學生包不含 ground-truth 欄位({leaked or 'clean'})")

        ans = json.loads((out / "answers" / "week08.json").read_text(encoding="utf-8"))
        check(len(ans["injected"]) >= 3, f"W8 答案卷列出注入設備({len(ans['injected'])} 台)")
        check(all(i["severity"] == 0.85 and i["kind"] == "equipment" for i in ans["injected"]),
              "W8 注入皆為 equipment severity 0.85(照週次 spec)")
        check(len(ans["clean_controls"]) >= 1, "W8 有乾淨對照組設備")
        ans4 = json.loads((out / "answers" / "week04.json").read_text(encoding="utf-8"))
        check(ans4["injected"] == [], "W4(clear)答案卷無注入")

        m = json.loads((out / "week08" / "manifest.json").read_text(encoding="utf-8"))
        check(m["synthetic"] is True and m["seed"] == 20260101 and m["engine_commit"] != "unknown",
              "manifest 帶合成標示 + seed + engine commit(可溯源)")

    _finish()


def _finish() -> None:
    print(f"\n失敗 {len(FAIL)} 項")
    for f in FAIL:
        print(f"  - {f}")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
