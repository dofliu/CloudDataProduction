"""P2 學生工單流程範例:認領公司 → 偵測故障 → ack → **診斷選處置動作** → 結案。

階段一學生實際要做的事:認領一間公司,持續監看,故障時 ack 工單,判斷根因後選一個
處置動作結案。工單**不會告訴你哪裡壞了**(那是答案),你要自己看遙測判斷。

本範例故意用最笨的方式示範「不診斷的代價」:直接下 overhaul(整機大修)。
它一定修得好,但停機 24 模擬小時,可用率會很難看。
你的作業是把 `choose_action()` 換成真的看資料判斷 —— 例如振動 RMS 持續走高就換軸承。
動作清單與各自的數據徵候:GET /api/repair/actions。

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


def choose_action(ticket: dict) -> str:
    """★ 這裡是你的作業:看資料判斷該做什麼處置。

    現在的版本擺爛 —— 一律整機大修,不用動腦但停機 24 小時。改進方向:
      1. 讀該設備的遙測(GET /api/devices/{id} 或直接用 Modbus / OPC-UA / MQTT)。
      2. 對照 GET /api/repair/actions 每個動作的 signature(數據上的徵候)。
      3. 例:vibration_rms 明顯高於平時 → replace_bearing;
             壓差上升 + 流量下降 → clean_filter;
             單一訊號與其他訊號脫鉤 → calibrate_sensor。
    選對:停機短、可用率高、分數高。選錯:白花 60% 工時,工單退回處理中。
    """
    return "overhaul"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--student", default="S001")
    ap.add_argument("--company", default="c01")
    ap.add_argument("--watch", type=int, default=60, help="監看秒數")
    args = ap.parse_args()

    print(req("POST", f"/api/companies/{args.company}/claim", {"student_id": args.student}))
    print(f"[{args.student}] 已認領 {args.company},開始監看工單…(老師注入故障後會自動開單)")

    print("維修手冊(選動作前先讀):")
    for a in req("GET", "/api/repair/actions")["actions"]:
        print(f"  · {a['action']:<22} {a['duration_h']:>5}h  {a['signature']}")

    handled = set()
    t_end = time.time() + args.watch
    while time.time() < t_end:
        tickets = req("GET", f"/api/tickets?owner={args.student}").get("tickets", [])
        for t in tickets:
            if t["id"] in handled or t["status"] == "resolved":
                continue
            if t["status"] == "open":
                req("POST", f"/api/tickets/{t['id']}/ack")
                # 工單只給症狀,不給根因 —— component 欄位在學生視圖是看不到的
                print(f"  ⚠ 偵測到故障 {t['device']}:{t.get('symptom', '跳機停線')} → ack 工單 {t['id']}")
            action = choose_action(t)
            r = req("POST", f"/api/tickets/{t['id']}/resolve",
                    {"action": action, "student": args.student})
            rep = r.get("repair") or {}
            if rep.get("success") and not rep.get("still_faulted"):
                mttr = r["ticket"].get("mttr_sim_s") or 0
                print(f"  ✓ {t['id']} 用「{action}」修好了,停機 {rep.get('downtime_h')}h,"
                      f"MTTR={mttr:.0f} sim s")
                handled.add(t["id"])
            else:
                print(f"  ✗ {t['id']} 用「{action}」沒修好 —— 白花 {rep.get('downtime_h')}h。換個動作再試。")
                time.sleep(2)
        time.sleep(1)

    scores = req("GET", "/api/scores")["ranking"]
    mine = next((s for s in scores if s["owner"] == args.student), None)
    print(f"[{args.student}] 目前成績:{mine}")


if __name__ == "__main__":
    main()
