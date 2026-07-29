"""把每日模擬測試的結果組成一份**自包含**的圖文 HTML 報告。

自包含的意思是截圖用 data: URI 內嵌 —— 這份 HTML 可以直接發布成 Artifact、
可以寄出去、可以離線開,不依賴任何外部主機(校內 LAN 無外網時仍然看得到)。

用法:
    python3 tests/daily/build_report.py [--dir artifacts/daily] [--out artifacts/daily/report.html]
"""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

CSS = """
:root{--bg:#f7f1e4;--card:#fffaf0;--line:#e0d3ba;--text:#3c3630;--muted:#7d7263;
      --ok:#4a7c4a;--bad:#b8452f;--accent:#b06a34}
@media (prefers-color-scheme: dark){
  :root{--bg:#211e1a;--card:#2b2722;--line:#413a31;--text:#ece4d6;--muted:#a99d8b;
        --ok:#7cb87c;--bad:#e08268;--accent:#d99a5c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);
     font:15px/1.65 system-ui,-apple-system,"Noto Sans TC",sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:28px 20px 60px}
h1{font-size:24px;margin:0 0 4px}
h2{font-size:17px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.sub{color:var(--muted);font-size:13.5px;margin:0 0 20px}
.banner{padding:14px 18px;border-radius:10px;font-weight:700;margin:18px 0 6px}
.banner.ok{background:rgba(74,124,74,.15);color:var(--ok)}
.banner.bad{background:rgba(184,69,47,.15);color:var(--bad)}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;
      padding:14px 16px;margin:10px 0}
.why{background:rgba(176,106,52,.10);border-left:3px solid var(--accent);
     padding:10px 14px;border-radius:0 8px 8px 0;margin:10px 0;font-size:14px}
table{border-collapse:collapse;width:100%;font-size:14px;margin:8px 0}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:12.5px}
.chk{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);align-items:flex-start}
.chk:last-child{border-bottom:none}
.tag{flex:0 0 auto;font-weight:700;font-size:12px;padding:2px 9px;border-radius:5px;margin-top:2px}
.tag.ok{background:rgba(74,124,74,.18);color:var(--ok)}
.tag.bad{background:rgba(184,69,47,.18);color:var(--bad)}
.tag.known{background:rgba(176,106,52,.20);color:var(--accent)}
.banner.warn{background:rgba(176,106,52,.16);color:var(--accent)}
.note{color:var(--muted);font-size:12.5px;margin-top:4px;padding-left:2px;
      border-left:2px solid var(--accent);padding:4px 0 4px 8px}
.chk .d{color:var(--muted);font-size:13px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:12px}
@media(max-width:720px){.pair{grid-template-columns:1fr}}
figure{margin:0}
figure img{width:100%;border-radius:8px;border:1px solid var(--line);display:block}
figcaption{color:var(--muted);font-size:12.5px;margin-top:5px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
.scroll{overflow-x:auto}
.foot{color:var(--muted);font-size:12.5px;margin-top:36px;border-top:1px solid var(--line);padding-top:14px}
"""

# 報告裡要秀的關鍵 tag(有才秀),各機種挑最能說明狀況的
KEY_TAGS = ["spindle_speed", "spindle_temp", "vibration_rms", "tool_wear", "motor_current",
            "outlet_pressure", "flow", "power_factor", "particle_count", "burr_rate",
            "ram_position", "belt_speed", "furnace_temp", "heating_power", "part_count"]


def b64(p: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()


def esc(x) -> str:
    return (str(x).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def build(d: Path, out: Path) -> dict:
    res = json.loads((d / "result.json").read_text(encoding="utf-8"))
    shots_path = d / "shots.json"
    sh = json.loads(shots_path.read_text(encoding="utf-8")) if shots_path.exists() else {"shots": [], "page_errors": []}

    # 三級:通過 / 已知待修(登記在 scenarios.yaml 的 known_issues)/ 新問題
    failed = [c for c in res["checks"] if not c["ok"] and not c.get("known")]
    known = [c for c in res["checks"] if not c["ok"] and c.get("known")]
    page_errs = sh.get("page_errors", [])
    healthy = not failed and not page_errs

    H = [f"<h1>每日模擬測試 · {esc(res['date'])}</h1>",
         f"<p class='sub'>情境「<b>{esc(res['title'])}</b>」"
         f"<span class='mono'>({esc(res['scenario'])})</span> · "
         f"{res['companies']} 間工廠 / {res['devices']} 台設備 · 觀測 {res['frames']} 幀</p>"]

    total = len(res["checks"])
    if healthy and not known:
        cls, msg = "ok", f"✓ 全部通過({res['passed']}/{total} 項判定,畫面無錯誤)"
    elif healthy:
        cls = "warn"
        msg = (f"✓ 沒有新問題({res['passed']}/{total} 通過)"
               f" · ⚠ {len(known)} 項為已知待修,見下方")
    else:
        bits = [f"{len(failed)} 項**新**判定失敗"] if failed else []
        if page_errs:
            bits.append(f"{len(page_errs)} 個畫面錯誤")
        if known:
            bits.append(f"另有 {len(known)} 項已知待修")
        cls, msg = "bad", "✗ 有新問題:" + "、".join(bits)
    H.append(f"<div class='banner {cls}'>{esc(msg)}</div>")

    if res.get("why"):
        H.append(f"<div class='why'><b>這個情境在測什麼:</b>{esc(res['why'])}</div>")

    # ── 判定 ──
    H.append("<h2>判定結果</h2><div class='card'>")
    for c in res["checks"]:
        k = c.get("known")
        cls = "ok" if c["ok"] else ("known" if k else "bad")
        word = "PASS" if c["ok"] else ("已知" if k else "FAIL")
        note = ""
        if k:
            note = (f"<div class='note'><b>已知待修</b>(登記於 {esc(k.get('since',''))})"
                    f"{'' if not k.get('note') else ' · ' + esc(k['note'])}</div>")
        H.append(f"<div class='chk'><span class='tag {cls}'>{word}</span>"
                 f"<div style='flex:1'><div>{esc(c['name'])}</div>"
                 f"<div class='d'>{esc(c['detail'])}</div>{note}</div></div>")
    H.append("</div>")

    if page_errs:
        H.append("<h2>畫面錯誤</h2><div class='card'>"
                 + "".join(f"<div class='mono' style='color:var(--bad)'>{esc(e)}</div>" for e in page_errs)
                 + "</div>")

    # ── 這次動了什麼 ──
    if res.get("injected") or res.get("stopped"):
        H.append("<h2>本次注入的狀況</h2><div class='card scroll'>")
        if res.get("injected"):
            H.append("<table><tr><th>設備</th><th>機種</th><th>對象</th><th>故障型式</th><th>嚴重度</th></tr>")
            for i in res["injected"]:
                H.append(f"<tr><td class='mono'>{esc(i['device'])}</td><td>{esc(i['template'])}</td>"
                         f"<td class='mono'>{esc(i['target'])}</td><td class='mono'>{esc(i['fault_type'])}</td>"
                         f"<td>{i['severity']:.1f}</td></tr>")
            H.append("</table>")
        if res.get("stopped"):
            H.append("<p>教師停機(<code>run_enable=0</code>):<span class='mono'>"
                     + esc("、".join(res["stopped"])) + "</span></p>")
        H.append("</div>")

    # ── 設備狀態彙整 ──
    sc = res.get("state_counts") or {}
    if sc:
        H.append("<h2>園區設備狀態</h2><div class='card'><table><tr>"
                 + "".join(f"<th>{esc(k)}</th>" for k in sc) + "</tr><tr>"
                 + "".join(f"<td><b>{v}</b> 台</td>" for v in sc.values()) + "</tr></table></div>")

    # ── 畫面(前 / 後對照)──
    by_tmpl: dict[str, dict] = {}
    for s in sh.get("shots", []):
        by_tmpl.setdefault(s["template"], {})[s["label"]] = s
    if by_tmpl:
        H.append("<h2>畫面(觀測窗 開頭 / 結尾 對照)</h2>"
                 "<p class='sub'>同一份引擎資料既拿去判定、也拿去畫面 —— 不是另外造一組給報告看的。</p>")
        for tmpl, pair in by_tmpl.items():
            did = (res.get("shoot_device") or {}).get(tmpl, "")
            H.append(f"<div class='card'><div style='font-weight:700;margin-bottom:8px'>{esc(tmpl)}"
                     + (f" <span class='mono' style='color:var(--muted)'>{esc(did)}</span>" if did else "")
                     + "</div><div class='pair'>")
            for label, zh in (("before", "觀測窗開頭"), ("after", "觀測窗結尾")):
                s = pair.get(label)
                if not s:
                    continue
                img = d / s["file"]
                if not img.exists():
                    continue
                tags = s.get("tags") or {}
                keys = [k for k in KEY_TAGS if k in tags][:5]
                rows = " · ".join(f"{k}={tags[k]:.1f}" if isinstance(tags[k], (int, float)) else f"{k}={tags[k]}"
                                  for k in keys)
                H.append(f"<figure><img alt='{esc(tmpl)} {label}' src='{b64(img)}'>"
                         f"<figcaption><b>{zh}</b> · state=<span class='mono'>{esc(s.get('state',''))}</span>"
                         + (f"<br><span class='mono'>{esc(rows)}</span>" if rows else "")
                         + "</figcaption></figure>")
            H.append("</div></div>")

    H.append("<div class='foot'>由 <code>tests/daily/</code> 產生。情境依日期輪替,"
             "同一天重跑得到同一個情境(可重現)。<br>"
             "⚠ 全部為<b>合成教學資料</b>,非任何真實產線量測。</div>")

    html = ("<style>" + CSS + "</style><div class='wrap'>" + "\n".join(H) + "</div>")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")
    return {"healthy": healthy, "failed": len(failed), "known": len(known),
            "page_errors": len(page_errs),
            "title": res["title"], "date": res["date"], "out": str(out)}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="artifacts/daily")
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    d = Path(a.dir)
    out = Path(a.out) if a.out else d / "report.html"
    info = build(d, out)
    print(json.dumps(info, ensure_ascii=False))


if __name__ == "__main__":
    main()
