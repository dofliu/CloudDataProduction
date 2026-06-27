"""P2 學生工單流程範例:認領公司 → 偵測故障 → 開/結工單。

階段一學生實際要做的事:認領一間公司,持續監看,故障時 ack 工單、處置後 resolve。
(這裡用輪詢 /api/tickets 偵測;進階版可改成自寫 client 抓遙測判斷再開單。)

用法:python student_kit/p2_tickets_demo.py --student S001 --company c01
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.request

API = "http://127.0.0.1:8077"


def req(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(API + path, data=data,
                               headers={"Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(r) as resp:
        return json.loads(resp.read())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--student", default="S001")
    ap.add_argument("--company", default="c01")
    ap.add_argument("--watch", type=int, default=60, help="監看秒數")
    args = ap.parse_args()

    print(req("POST", f"/api/companies/{args.company}/claim", {"student_id": args.student}))
    print(f"[{args.student}] 已認領 {args.company},開始監看工單…(老師注入故障後會自動開單)")

    handled = set()
    t_end = time.time() + args.watch
    while time.time() < t_end:
        tickets = req("GET", f"/api/tickets?owner={args.student}").get("tickets", [])
        for t in tickets:
            if t["id"] in handled:
                continue
            if t["status"] == "open":
                req("POST", f"/api/tickets/{t['id']}/ack")
                print(f"  ⚠ 偵測到故障 {t['device']}（{t['component']}）→ ack 工單 {t['id']}")
                time.sleep(2)  # 模擬處置耗時
                r = req("POST", f"/api/tickets/{t['id']}/resolve")
                print(f"  ✓ 處置完成 {t['id']},MTTR={r['mttr_sim_s']:.0f} sim s,設備已修復")
                handled.add(t["id"])
        time.sleep(1)

    scores = req("GET", "/api/scores")["ranking"]
    mine = next((s for s in scores if s["owner"] == args.student), None)
    print(f"[{args.student}] 目前成績:{mine}")


if __name__ == "__main__":
    main()
