"""課程統一學號種子表 —— 作業出題與每週凍結包共用同一份種子推導(T2)。

為什麼:make_assignment.py 與 make_week_packs.py 原本各走各的 seed,同一個學號在
「作業資料」與「週包資料」之間對不上,老師也沒有一份可以存檔的種子清單。
統一成同一個推導式之後:同一 (course master, 學號) 在所有工具產出同一個 base seed,
可重現、可稽核、換課程鹽(master)即整批換實現。

推導式**與 make_assignment.py 沿用已久的公式逐位相同**(sha256("{master}|{sid}")),
所以已經發出去的作業與答案金鑰完全不受影響。

用法(印出名冊的種子表,老師可存檔):
  python tools/course_seed.py --students S001,S002
  python tools/course_seed.py --roster roster.txt --master course-2026S1 --json
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

DEFAULT_MASTER = "course-2026S1"   # 課程鹽:與 engine tag / make_assignment 預設一致


def stable_seed(s: str) -> int:
    """穩定雜湊(非 Python hash,跨機跨進程一致)→ 固定但各不同的種子。"""
    return int(hashlib.sha256(s.encode("utf-8")).hexdigest(), 16) % (2 ** 31)


def student_seed(master: str, student_id: str, purpose: str = "") -> int:
    """學號 → 種子。purpose 留空 = base seed(作業訓練集、週包共用);
    "test" = 作業私有測試集(與 base 不同批實現,學生看不到)。"""
    key = f"{master}|{student_id}" + (f"|{purpose}" if purpose else "")
    return stable_seed(key)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--roster", help="名冊檔(每行一個學號)")
    ap.add_argument("--students", help="逗號分隔學號(覆寫 roster)")
    ap.add_argument("--master", default=DEFAULT_MASTER)
    ap.add_argument("--json", action="store_true", help="輸出 JSON(預設表格)")
    args = ap.parse_args()

    if args.students:
        roster = [s.strip() for s in args.students.split(",") if s.strip()]
    elif args.roster:
        roster = [ln.strip() for ln in Path(args.roster).read_text(encoding="utf-8").splitlines()
                  if ln.strip() and not ln.startswith("#")]
    else:
        roster = ["S001", "S002", "S003"]

    table = {sid: {"seed": student_seed(args.master, sid),
                   "test_seed": student_seed(args.master, sid, "test")} for sid in roster}
    if args.json:
        print(json.dumps({"master": args.master, "students": table},
                         ensure_ascii=False, indent=1))
    else:
        print(f"master = {args.master}")
        for sid, row in table.items():
            print(f"  {sid:12} seed={row['seed']:<11} test_seed={row['test_seed']}")


if __name__ == "__main__":
    main()
