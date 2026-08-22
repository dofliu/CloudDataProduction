"""取數範例:一條產線的跨設備資料,一次撈回來(T14)。

先前要做「一條產線的跨設備相關分析」,得一台一支 tag 打幾十次 API,再自己對齊
時間戳 —— 取數本身變成作業的主要難度。這支示範四種取法,挑順手的用:

    python3 student_kit/p6_fetch_data.py                 # 全部示範跑一遍
    python3 student_kit/p6_fetch_data.py --host 10.0.0.5:8000

四種取法:
    ① 多設備 × 多 tag(wide)   時間已對齊,直接進 pandas / Excel
    ② 降採樣                    一週資料用 1 小時桶,avg/min/max/count 四個量
    ③ CSV 匯出                  存檔用 Excel 開
    ④ 唯讀 SQL                  想怎麼撈就怎麼撈(能寫 SQL 才是可轉移的技能)

**降採樣要看 max,不要只看 avg** —— 預測性維護看的是峰值,振動尖峰被 1 小時
平均一抹就不見了,那正是你要偵測的東西。

本平台所有數據皆為**合成教學資料**,非真實場域量測。
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse
import urllib.request


def api(host: str, path: str, **params) -> dict:
    url = f"http://{host}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_text(host: str, path: str, **params) -> str:
    url = f"http://{host}{path}?" + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=30) as resp:
        return resp.read().decode("utf-8-sig")     # utf-8-sig:吃掉 Excel 用的 BOM


def pick_demo_target(host: str) -> tuple[str, list[str], list[str]]:
    """從設備目錄挑一組示範對象:同一間公司、至少兩台、且**真的都有**同幾支 tag。

    刻意不寫死設備 id 與 tag 名 —— 不同場景(class_park / default_park)編號不一樣,
    而且不是每台都有每支 tag(CNC 是 spindle_current、研磨機才是 motor_current)。
    這段挑選邏輯本身就是示範:先查目錄,再決定要撈什麼。
    """
    cat = api(host, "/api/catalog")
    by_company: dict[str, list[tuple[str, set]]] = {}
    for d in cat.get("devices", []):
        names = {t["name"] for t in d.get("tags", []) if t.get("name") != "state"}
        by_company.setdefault(d.get("company_id") or "?", []).append((d["id"], names))
    best: tuple[str, list[str], list[str]] | None = None
    for company, devs in sorted(by_company.items()):
        if len(devs) < 2:
            continue
        for i in range(len(devs)):
            for j in range(i + 1, len(devs)):
                common = sorted(devs[i][1] & devs[j][1])
                if len(common) >= 2:
                    cand = (company, [devs[i][0], devs[j][0]], common[:2])
                    # 挑共同 tag 最多的那一組(示範起來最有內容)
                    if best is None or len(common) > len(best[2]):
                        best = (company, cand[1], common[:2])
    if best:
        return best
    devs = [d["id"] for d in cat.get("devices", [])][:2]
    return "(找不到共同 tag)", devs, ["vibration_rms"]


def demo_wide(host: str, devices: list[str], tags: list[str]) -> None:
    print("\n① 多設備 × 多 tag(wide)—— 時間已對齊,直接進 pandas")
    r = api(host, "/api/history",
            devices=",".join(devices), tags=",".join(tags), limit=5)
    print(f"   欄位:{r['columns']}")
    if r.get("missing"):
        # 不是每台都有每一支 tag(CNC 是 spindle_current、研磨機才是 motor_current)
        print(f"   ⚠ 這些序列窗內沒資料:{r['missing']}")
    for p in r["points"][:3]:
        vals = {k: (round(v, 3) if isinstance(v, float) else v)
                for k, v in p.items() if k not in ("t", "sim_t")}
        print(f"   sim_t={p['sim_t']}  {vals}")
    print("   → pandas:df = pd.DataFrame(r['points']).set_index('t')")
    print("     相關係數:df.corr()   ← 時間已經對齊,不必自己 merge")


def demo_bucket(host: str, device: str, tag: str) -> None:
    print(f"\n② 降採樣(1 分鐘桶,{tag})—— 四個統計量,別只看 avg")
    r = api(host, "/api/history", devices=device, tags=tag,
            bucket=60, shape="long", limit=5)
    for p in r["points"][:4]:
        print(f"   sim_t={p['sim_t']:>9}  avg={p['avg']:.3f}  min={p['min']:.3f}  "
              f"max={p['max']:.3f}  n={p['count']}")
    print("   → max 與 avg 的差距就是這一分鐘的波動幅度;")
    print("     只取 avg 的話,振動尖峰(你要偵測的東西)會被抹平掉。")


def demo_csv(host: str, devices: list[str], tag: str) -> None:
    print("\n③ CSV 匯出(存檔用 Excel 開)")
    txt = api_text(host, "/api/history", devices=",".join(devices),
                   tags=tag, bucket=3600, format="csv")
    lines = txt.splitlines()
    print(f"   {len(lines)} 列;表頭:{lines[0]}")
    if len(lines) > 1:
        print(f"   第一列:{lines[1]}")
    print("   → 存檔:curl -o data.csv 'http://…/api/history?...&format=csv'")


def demo_sql(host: str) -> None:
    print("\n④ 唯讀 SQL —— 想怎麼撈就怎麼撈")
    try:
        meta = api(host, "/api/sql/tables")
    except Exception as exc:
        print(f"   (取不到表結構:{exc})")
        return
    print(f"   可查的表:{', '.join(meta['tables'])}(後端 {meta['backend']})")
    queries = [
        ("哪幾台的振動最高", "SELECT device_id, ROUND(AVG(value),3) avg_vib "
                             "FROM telemetry WHERE tag='vibration_rms' "
                             "GROUP BY device_id ORDER BY avg_vib DESC LIMIT 5"),
        ("停機原因 Pareto", "SELECT stop_reason, COUNT(*) n FROM events "
                            "GROUP BY stop_reason ORDER BY n DESC LIMIT 5"),
    ]
    for title, q in queries:
        try:
            r = api(host, "/api/sql", q=q, limit=5)
        except Exception as exc:
            print(f"   {title}:查詢失敗 {exc}")
            continue
        print(f"   {title} → {r['columns']}")
        for row in r["data"][:3]:
            print(f"      {row}")
    print("   → 寫不進去:這個端點跑在唯讀連線上,DELETE / UPDATE 一律被資料庫拒絕。")
    print("     查不到健康度與故障元件名 —— 那是 ground-truth(答案),不在學生面的表裡。")


def main() -> int:
    ap = argparse.ArgumentParser(description="取數範例(T14)")
    ap.add_argument("--host", default="localhost:8000", help="平台位址,如 10.0.0.5:8000")
    args = ap.parse_args()

    try:
        company, devices, tags = pick_demo_target(args.host)
    except Exception as exc:
        print(f"連不到平台 {args.host}:{exc}")
        print("先確認平台有起來(docker compose up -d),或用 --host 指定位址。")
        return 1
    print(f"示範對象:{company} 的 {devices},共同 tag {tags}")

    demo_wide(args.host, devices, tags)
    demo_bucket(args.host, devices[0], tags[0])
    demo_csv(args.host, devices, tags[0])
    demo_sql(args.host)
    print("\n完整參數說明:GET /api/sql/tables 與 /api/docs(FastAPI 自動文件)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
