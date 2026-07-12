import { useEffect, useState } from "react";
import {
  Park, Company, TelemetryMsg, Ticket, ScoreRow, PredScoreRow, OeeRow,
  getTickets, ackTicket, resolveTicket, getScores, getPredictionScores, getOee, getPark, claimCompany,
} from "../api";

// 學生面公開頁:設定學生 id → 認領公司 → 我的工單(ack/resolve)→ 競賽榜。全程免教師 token。
function fmtH(s: number | null | undefined) { return s == null ? "—" : (s / 3600).toFixed(1) + "h"; }
const STATUS_ZH: Record<string, string> = { open: "未處理", acked: "處理中", resolved: "已結案" };
const STATUS_COL: Record<string, string> = { open: "var(--fault)", acked: "var(--warn)", resolved: "var(--ok)" };

export default function StudentView({ park, telemetry }: { park: Park; telemetry: TelemetryMsg | null }) {
  const [me, setMe] = useState(localStorage.getItem("student_id") || "");
  const [meInput, setMeInput] = useState(me);
  const [companies, setCompanies] = useState<Company[]>(park.companies);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [predScores, setPredScores] = useState<PredScoreRow[]>([]);
  const [oee, setOee] = useState<OeeRow[]>([]);
  const [msg, setMsg] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "mine" | "free" | "fault">("all");

  const refresh = () => {
    getPark().then((p) => setCompanies(p.companies)).catch(() => {});
    getTickets().then((r) => setTickets(r.tickets)).catch(() => {});
    getScores().then((r) => setScores(r.ranking)).catch(() => {});
    getPredictionScores().then((r) => setPredScores(r.ranking)).catch(() => {});
    getOee().then((r) => setOee(r.ranking)).catch(() => {});
  };
  useEffect(() => { refresh(); const id = setInterval(refresh, 4000); return () => clearInterval(id); }, []);

  const saveMe = () => { const v = meInput.trim(); setMe(v); localStorage.setItem("student_id", v); };
  const claim = async (cid: string) => {
    if (!me) { setMsg("請先在上方設定你的學生 id"); return; }
    try { await claimCompany(cid, me); setMsg(`已認領 ${cid}`); refresh(); } catch { setMsg("認領失敗"); }
  };
  const act = async (fn: (id: string) => Promise<unknown>, id: string, label: string) => {
    try { await fn(id); setMsg(`已${label} ${id}`); refresh(); } catch { setMsg(`${label}失敗`); }
  };

  const devFault = (c: Company) => (c.device_ids || []).some((d) => telemetry?.devices[d]?.state === "fault");
  const myCompanyIds = new Set(companies.filter((c) => c.owner === me && !!me).map((c) => c.id));
  const myTickets = me ? tickets.filter((t) => myCompanyIds.has(t.company || "")) : tickets;
  const openCount = tickets.filter((t) => t.status !== "resolved").length;

  // 找公司:搜尋 + 篩選 + 排序(我的置頂、其次有故障、再依名稱),解決 64 張卡難找的問題。
  const kw = q.trim().toLowerCase();
  const matches = (c: Company) => {
    const isMine = c.owner === me && !!me;
    if (filter === "mine" && !isMine) return false;
    if (filter === "free" && !!c.owner) return false;
    if (filter === "fault" && !devFault(c)) return false;
    if (kw && !(`${c.name} ${c.id} ${c.owner ?? ""} ${c.product ?? ""}`.toLowerCase().includes(kw))) return false;
    return true;
  };
  const shownCompanies = companies.filter(matches).sort((a, b) => {
    const rank = (c: Company) => ((c.owner === me && !!me) ? 0 : devFault(c) ? 1 : !c.owner ? 2 : 3);
    return rank(a) - rank(b) || a.name.localeCompare(b.name, "zh-Hant");
  });
  const freeCount = companies.filter((c) => !c.owner).length;
  const faultCount = companies.filter(devFault).length;
  const FILTERS: [typeof filter, string, number][] = [
    ["all", "全部", companies.length], ["mine", "我的", myCompanyIds.size],
    ["free", "未認領", freeCount], ["fault", "有故障", faultCount],
  ];

  return (
    <div className="page" style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 480px", minWidth: 0 }}>
        <h2>學生面 · 認領 → 處置工單 → 上競賽榜</h2>

        {/* 身分卡 */}
        <div className="card" style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: "var(--accent-grad)",
                        display: "flex", alignItems: "center", justifyContent: "center", color: "#fffaf0", fontWeight: 700, fontSize: 18 }}>
            {me ? me[0]?.toUpperCase() : "?"}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", flex: 1 }}>
            <span className="muted" style={{ fontSize: 12 }}>我的學生 id</span>
            <input className="inp" value={meInput} onChange={(e) => setMeInput(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && saveMe()} placeholder="例:S001 / kiwi" style={{ width: 150 }} />
            <button className="btn primary" onClick={saveMe}>設定</button>
            {me && <span className="pill" style={{ color: "var(--ok)", borderColor: "#d3e2c4" }}>目前 {me}</span>}
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 12, color: openCount > 0 ? "var(--fault)" : "var(--muted)" }}>未結案工單 {openCount}</span>
          </div>
        </div>
        {msg && <div className="hint" style={{ color: "var(--accent)", marginTop: -8, marginBottom: 12 }}>· {msg}</div>}

        {/* 公司認領:搜尋 + 篩選(64 廠好找) */}
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "4px 0 10px" }}>
          <h3 style={{ fontSize: 15, margin: 0 }}>公司認領</h3>
          <input className="inp" value={q} onChange={(e) => setQ(e.target.value)} placeholder="🔍 搜尋公司 / 產品 / 學號"
                 style={{ width: 200, padding: "6px 10px" }} />
          <div className="seg" style={{ display: "inline-flex", border: "1px solid var(--line)", borderRadius: 8, overflow: "hidden" }}>
            {FILTERS.map(([f, label, n]) => (
              <button key={f} onClick={() => setFilter(f)}
                style={{ background: filter === f ? "var(--accent)" : "var(--panel-3)", color: filter === f ? "#fffaf0" : "var(--text-2)",
                         border: "none", padding: "6px 11px", cursor: "pointer", fontSize: 12.5, fontWeight: filter === f ? 700 : 400 }}>
                {label} <span style={{ opacity: .7 }}>{n}</span>
              </button>
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12 }}>顯示 {shownCompanies.length} 間</span>
        </div>
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(200px,1fr))" }}>
          {shownCompanies.length === 0 && <div className="hint" style={{ gridColumn: "1/-1" }}>沒有符合的公司,換個關鍵字或篩選。</div>}
          {shownCompanies.map((c) => {
            const mine = c.owner === me && !!me;
            const taken = !!c.owner && !mine;
            const fault = devFault(c);
            return (
              <div key={c.id} className="card" style={{ padding: "10px 12px",
                borderColor: mine ? "#bcd6a6" : "var(--line)", background: mine ? "#eef4e8" : "var(--panel)", opacity: taken ? 0.55 : 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 600 }}>{c.name}</span>
                  <span style={{ width: 9, height: 9, borderRadius: 9, background: fault ? "var(--fault)" : "var(--ok)" }} />
                </div>
                <div className="muted" style={{ fontSize: 11.5 }}>{(c.device_ids || []).length} 台 · {c.owner ? `認領:${c.owner}` : "未認領"}</div>
                {!c.owner && <button className="btn primary" style={{ marginTop: 7, padding: "4px 12px", fontSize: 12 }} onClick={() => claim(c.id)}>認領</button>}
                {mine && <span className="chip on" style={{ marginTop: 7 }}>我的公司</span>}
              </div>
            );
          })}
        </div>

        {/* 我的工單 */}
        <h3 style={{ fontSize: 15, margin: "22px 0 8px" }}>{me ? "我的工單" : "所有工單"} <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>(ack 確認 → resolve 處置)</span></h3>
        {myTickets.length === 0 ? <p className="hint">目前沒有工單。等老師注入故障 / 設備自然退化故障後會自動開單。</p> : (
          <div className="card" style={{ padding: "4px 14px" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>{["單號", "設備", "公司", "元件", "狀態", "偵測延遲", "MTTR", "動作"].map((h) => (
                <th key={h} className="mono" style={{ textAlign: "left", padding: "7px 8px", color: "var(--dim)", fontSize: 10.5, letterSpacing: ".5px", borderBottom: "1px solid var(--line)", fontWeight: 500 }}>{h}</th>
              ))}</tr></thead>
              <tbody>
                {myTickets.map((t) => (
                  <tr key={t.id}>
                    <td className="mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)", fontWeight: 600 }}>{t.id}</td>
                    <td className="mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)" }}>{t.device}</td>
                    <td className="muted" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)", fontSize: 11.5 }}>{t.company}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)" }}>{t.component ?? "—"}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)" }}>
                      <span style={{ color: STATUS_COL[t.status] ?? "var(--muted)", fontWeight: 600 }}>● {STATUS_ZH[t.status] ?? t.status}</span></td>
                    <td className="mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)", textAlign: "right" }}>{fmtH(t.detection_latency_sim_s)}</td>
                    <td className="mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)", textAlign: "right" }}>{fmtH(t.mttr_sim_s)}</td>
                    <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)", display: "flex", gap: 6 }}>
                      {t.status === "open" && <button className="btn" style={{ background: "var(--warn)", color: "#fffaf0", padding: "3px 9px", fontSize: 11.5 }} onClick={() => act(ackTicket, t.id, "確認")}>ack</button>}
                      {t.status !== "resolved" && <button className="btn" style={{ background: "var(--ok)", color: "#fffaf0", padding: "3px 9px", fontSize: 11.5 }} onClick={() => act(resolveTicket, t.id, "處置")}>resolve</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* 右側競賽榜(窄螢幕自動換到下方) */}
      <div style={{ flex: "1 1 320px", minWidth: 300, maxWidth: 460, display: "grid", gap: 14 }}>
        <Leaderboard title="故障管理" cols={["公司", "偵測", "結案", "漏", "分數"]}
          rows={scores.map((r) => [r.name, `${r.detected}/${r.faults}`, String(r.resolved), String(r.missed), r.score.toFixed(0)])}
          mine={me ? scores.findIndex((r) => r.owner === me) : -1} />
        <Leaderboard title="預測(階段二)" cols={["學生", "命中", "誤報", "提前h", "分數"]}
          rows={predScores.map((r) => [r.student, `${r.hits}/${r.predictions}`, String(r.false_alarms), r.avg_lead_time_h?.toFixed(1) ?? "—", r.score.toFixed(0)])}
          mine={me ? predScores.findIndex((r) => r.student === me) : -1} />
        <Leaderboard title="OEE" cols={["公司", "OEE", "可用", "良率"]}
          rows={oee.map((r) => [r.name, (r.oee * 100).toFixed(0) + "%", (r.availability * 100).toFixed(0) + "%", (r.quality * 100).toFixed(0) + "%"])}
          mine={me ? oee.findIndex((r) => r.owner === me) : -1} />
      </div>
    </div>
  );
}

function Leaderboard({ title, cols, rows, mine }: { title: string; cols: string[]; rows: string[][]; mine: number }) {
  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div className="card-title" style={{ fontSize: 13.5 }}>🏆 {title}</div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead><tr>
          <th className="mono" style={{ width: 22, textAlign: "left", padding: "4px 6px", color: "var(--dim)", fontSize: 10, borderBottom: "1px solid var(--line)" }}>#</th>
          {cols.map((c, i) => (
            <th key={c} className="mono" style={{ textAlign: i === 0 ? "left" : "right", padding: "4px 6px", color: "var(--dim)", fontSize: 10, borderBottom: "1px solid var(--line)", fontWeight: 500 }}>{c}</th>
          ))}
        </tr></thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={cols.length + 1} className="hint" style={{ padding: "8px 6px" }}>尚無資料</td></tr> :
            rows.map((r, i) => (
              <tr key={i} style={i === mine ? { background: "#eef4e8", outline: "1px solid #d3e2c4" } : undefined}>
                <td className="mono" style={{ padding: "5px 6px", color: i === 0 ? "var(--warn)" : "var(--dim)", fontWeight: i === 0 ? 700 : 400, borderBottom: "1px solid var(--line-3)" }}>{i + 1}</td>
                {r.map((cell, j) => (
                  <td key={j} className={j === 0 ? "" : "mono"} style={{ textAlign: j === 0 ? "left" : "right", padding: "5px 6px", fontSize: 12, borderBottom: "1px solid var(--line-3)",
                    color: j === 0 && i === mine ? "var(--ok)" : "var(--text-2)" }}>{cell}</td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
