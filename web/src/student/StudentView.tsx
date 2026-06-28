import { useEffect, useState } from "react";
import {
  Park, Company, TelemetryMsg, Ticket, ScoreRow, PredScoreRow, OeeRow,
  getTickets, ackTicket, resolveTicket, getScores, getPredictionScores, getOee, getPark,
  claimCompany,
} from "../api";

// 學生面公開頁:設定學生 id → 認領公司 → 我的工單(ack/resolve)→ 競賽榜。全程免教師 token。
function fmtH(s: number | null | undefined) { return s == null ? "—" : (s / 3600).toFixed(1) + "h"; }
const STATUS_ZH: Record<string, string> = { open: "未處理", acked: "處理中", resolved: "已結案" };
const STATUS_COL: Record<string, string> = { open: "#e24c4c", acked: "#f2c037", resolved: "#37d67a" };

export default function StudentView({ park, telemetry }: { park: Park; telemetry: TelemetryMsg | null }) {
  const [me, setMe] = useState(localStorage.getItem("student_id") || "");
  const [meInput, setMeInput] = useState(me);
  const [companies, setCompanies] = useState<Company[]>(park.companies);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [predScores, setPredScores] = useState<PredScoreRow[]>([]);
  const [oee, setOee] = useState<OeeRow[]>([]);
  const [msg, setMsg] = useState("");

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
    try { await claimCompany(cid, me); setMsg(`已認領 ${cid}`); refresh(); }
    catch { setMsg("認領失敗"); }
  };
  const act = async (fn: (id: string) => Promise<unknown>, id: string, label: string) => {
    try { await fn(id); setMsg(`已${label} ${id}`); refresh(); } catch { setMsg(`${label}失敗`); }
  };

  const devFault = (c: Company) => (c.device_ids || []).some((d) => telemetry?.devices[d]?.state === "fault");
  // 我的工單 = 我「現在認領的公司」底下的工單(認領後既有未結案工單也算我的,符合直覺)
  const myCompanyIds = new Set(companies.filter((c) => c.owner === me && !!me).map((c) => c.id));
  const myTickets = me ? tickets.filter((t) => myCompanyIds.has(t.company || "")) : tickets;
  const openCount = tickets.filter((t) => t.status !== "resolved").length;

  return (
    <div className="catalog">
      <h2>學生面 · 認領公司 → 處置工單 → 上競賽榜</h2>

      {/* 身分 */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "8px 0 4px" }}>
        <span className="hint">我的學生 id:</span>
        <input value={meInput} onChange={(e) => setMeInput(e.target.value)} placeholder="例:S001 / kiwi"
               style={{ background: "#0f1620", color: "#e6ecf5", border: "1px solid #2e3a4d", borderRadius: 6, padding: "5px 10px" }} />
        <button onClick={saveMe} style={{ background: "#5b9bd5", color: "#08121e", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontWeight: 600 }}>設定</button>
        {me && <span style={{ color: "#37d67a" }}>目前:{me}</span>}
        {msg && <span className="hint" style={{ color: "#5b9bd5" }}>· {msg}</span>}
      </div>
      <p className="hint">公開唯讀面;認領 / 處置工單免教師 token。全部為合成數據。目前未結案工單 {openCount} 張。</p>

      {/* 我的公司 / 認領 */}
      <h3 style={{ marginTop: 18 }}>公司認領</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        {companies.map((c) => {
          const mine = c.owner === me && !!me;
          const taken = !!c.owner && !mine;
          const fault = devFault(c);
          return (
            <div key={c.id} style={{ width: 190, border: `1px solid ${mine ? "#2f7a4f" : "#2e3a4d"}`, borderRadius: 8,
                                     padding: "8px 10px", background: mine ? "#13241b" : "#161d27", opacity: taken ? 0.6 : 1 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontWeight: 600, color: "#e6ecf5" }}>{c.name}</span>
                <span style={{ width: 9, height: 9, borderRadius: 9, background: fault ? "#e24c4c" : "#37d67a" }} />
              </div>
              <div className="hint">{(c.device_ids || []).length} 台 · {c.owner ? `認領:${c.owner}` : "未認領"}</div>
              {!c.owner && <button onClick={() => claim(c.id)} style={{ marginTop: 6, background: "#37d67a", color: "#08121e", border: "none", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontWeight: 600, fontSize: 12 }}>認領</button>}
              {mine && <button onClick={() => claim(c.id) /* 重新認領=自己仍是 owner */} disabled style={{ marginTop: 6, background: "#2f7a4f", color: "#cfe9da", border: "none", borderRadius: 6, padding: "4px 12px", fontSize: 12 }}>我的公司</button>}
            </div>
          );
        })}
      </div>

      {/* 我的工單 */}
      <h3 style={{ marginTop: 22 }}>{me ? "我的工單" : "所有工單"}（ack 確認 → resolve 處置修復）</h3>
      {myTickets.length === 0 ? <p className="hint">目前沒有工單。等老師注入故障 / 設備自然退化故障後會自動開單。</p> : (
        <table>
          <thead><tr><th>單號</th><th>設備</th><th>公司</th><th>元件</th><th>狀態</th><th>偵測延遲</th><th>MTTR</th><th>動作</th></tr></thead>
          <tbody>
            {myTickets.map((t) => (
              <tr key={t.id}>
                <td><b>{t.id}</b></td>
                <td>{t.device}</td>
                <td className="hint">{t.company}</td>
                <td>{t.component ?? "—"}</td>
                <td><span style={{ color: STATUS_COL[t.status] ?? "#8a93a6", fontWeight: 600 }}>{STATUS_ZH[t.status] ?? t.status}</span></td>
                <td>{fmtH(t.detection_latency_sim_s)}</td>
                <td>{fmtH(t.mttr_sim_s)}</td>
                <td style={{ display: "flex", gap: 6 }}>
                  {t.status === "open" && <button onClick={() => act(ackTicket, t.id, "確認")} style={btn("#f2c037")}>ack 確認</button>}
                  {t.status !== "resolved" && <button onClick={() => act(resolveTicket, t.id, "處置")} style={btn("#37d67a")}>resolve 處置</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* 競賽榜 */}
      <h3 style={{ marginTop: 24 }}>競賽榜（即時更新）</h3>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
        <Leaderboard title="故障管理" cols={["公司", "偵測", "結案", "漏", "分數"]}
          rows={scores.map((r) => [r.name, `${r.detected}/${r.faults}`, String(r.resolved), String(r.missed), r.score.toFixed(0)])}
          mine={me ? scores.findIndex((r) => r.owner === me) : -1} />
        <Leaderboard title="預測(階段二)" cols={["學生", "命中", "誤報", "提前h", "分數"]}
          rows={predScores.map((r) => [r.student, `${r.hits}/${r.predictions}`, String(r.false_alarms), r.avg_lead_time_h?.toFixed(1) ?? "—", r.score.toFixed(0)])}
          mine={me ? predScores.findIndex((r) => r.student === me) : -1} />
        <Leaderboard title="OEE" cols={["公司", "OEE", "可用率", "良率"]}
          rows={oee.map((r) => [r.name, (r.oee * 100).toFixed(0) + "%", (r.availability * 100).toFixed(0) + "%", (r.quality * 100).toFixed(0) + "%"])}
          mine={me ? oee.findIndex((r) => r.owner === me) : -1} />
      </div>
    </div>
  );
}

function btn(color: string): React.CSSProperties {
  return { background: color, color: "#08121e", border: "none", borderRadius: 6, padding: "4px 10px", cursor: "pointer", fontWeight: 600, fontSize: 12 };
}

function Leaderboard({ title, cols, rows, mine }: { title: string; cols: string[]; rows: string[][]; mine: number }) {
  return (
    <div style={{ minWidth: 280, flex: 1 }}>
      <div style={{ fontWeight: 700, color: "#c7d2e0", marginBottom: 4 }}>{title}</div>
      <table>
        <thead><tr><th>#</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 ? <tr><td colSpan={cols.length + 1} className="hint">尚無資料</td></tr> :
            rows.map((r, i) => (
              <tr key={i} style={i === mine ? { background: "#13241b" } : undefined}>
                <td style={{ width: 22, color: i === 0 ? "#f2c037" : "var(--muted)" }}>{i + 1}</td>
                {r.map((cell, j) => <td key={j}>{cell}</td>)}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
