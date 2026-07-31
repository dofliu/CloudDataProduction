import { useEffect, useState } from "react";
import { PollDef, PollActive, PollRecord, getPolls, getActivePoll, openPoll, closePoll } from "../api";

/**
 * 全班投票控制(教師面)。
 *
 * 流程:開票 → 學生手機投 → 收票。收票時平台**照多數決真的去動引擎**
 * (保養就真的停機、拉稼動就真的磨得更快),下一節課回來對照 OEE。
 *
 * 「收票但不執行」留著給只想討論、不想真的動機器的時候。
 */
export default function PollPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [polls, setPolls] = useState<PollDef[]>([]);
  const [active, setActive] = useState<PollActive | null>(null);
  const [history, setHistory] = useState<PollRecord[]>([]);
  const [mins, setMins] = useState("2");

  useEffect(() => { getPolls().then((r) => setPolls(r.polls)).catch(() => {}); }, []);
  useEffect(() => {
    const tick = () => getActivePoll().then((r) => { setActive(r.active); setHistory(r.history || []); }).catch(() => {});
    tick();
    const id = setInterval(tick, 2500);
    return () => clearInterval(id);
  }, []);

  const open = async (id: string) => {
    const secs = mins.trim() ? Math.max(15, Math.round(Number(mins) * 60)) : null;
    try {
      await openPoll(id, Number.isFinite(secs as number) ? secs : null);
      onMsg(`🗳 已開票「${polls.find((p) => p.id === id)?.question ?? id}」${secs ? ` · ${mins} 分鐘` : ""}`);
    } catch (e: any) {
      onMsg(`開票失敗:${e.message}${String(e.message).includes("401") ? "(先填 dev-teacher-token)" : ""}`);
    }
  };
  const close = async (execute: boolean) => {
    try {
      const r = await closePoll(execute);
      onMsg(`🗳 收票:${r.closed.winner_label ?? "無人投票"}(${r.closed.votes} 票)→ ${r.closed.result?.detail}`);
    } catch (e: any) { onMsg(`收票失敗:${e.message}`); }
  };

  return (
    <>
      <div className="card-title">🗳 全班投票(沒有正解的取捨題 —— 收票後平台真的照多數決動引擎)</div>
      <div className="hint" style={{ margin: "0 0 8px" }}>
        跟練習不同:投票沒有標準答案。全班投完,平台會真的去保養 / 停機 / 調稼動,
        <b>下一節課回來看 OEE 就是這次決定的後果</b>。想只討論不動機器,收票時選「收票但不執行」。
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 11.5 }}>投票時間</span>
        <input className="inp mono" value={mins} onChange={(e) => setMins(e.target.value)}
               placeholder="留空=不限時" style={{ width: 62, padding: "4px 8px", fontSize: 12 }} />
        <span className="muted" style={{ fontSize: 11.5 }}>分鐘</span>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {polls.length === 0 && <span className="muted" style={{ fontSize: 12 }}>(讀不到 scenarios/classroom_polls.yaml)</span>}
        {polls.map((p) => (
          <button key={p.id} className="btn ghost" onClick={() => open(p.id)} title={p.brief}
            style={active?.poll === p.id ? { background: "#f4e6d2", borderColor: "var(--accent)", color: "var(--accent)" } : {}}
          >{active?.poll === p.id ? "● " : ""}{p.question}</button>
        ))}
      </div>

      {active && (
        <div className="card" style={{ padding: "8px 12px", marginTop: 10, background: "var(--panel-3)" }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <b style={{ fontSize: 12.5 }}>{active.question}</b>
            {active.device && <span className="pill mono" style={{ fontSize: 11 }}>{active.device}</span>}
            <span style={{ flex: 1 }} />
            <span className="mono" style={{ fontSize: 12 }}>{active.votes} 票</span>
            {active.remain_s != null && (
              <span className="mono" style={{ fontSize: 12, color: active.remain_s <= 0 ? "var(--fault)" : "var(--warn)" }}>
                {active.remain_s <= 0 ? "已截止" : `⏱ ${Math.floor(active.remain_s)}s`}
              </span>
            )}
          </div>
          <div style={{ display: "grid", gap: 5, marginTop: 8 }}>
            {active.options.map((o) => {
              const n = active.tally[o.id] ?? 0;
              const pct = active.votes ? Math.round((n / active.votes) * 100) : 0;
              return (
                <div key={o.id} style={{ position: "relative", overflow: "hidden", border: "1px solid var(--line)",
                                         borderRadius: 6, padding: "4px 9px", background: "#efe4d0" }}>
                  <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: "rgba(181,98,46,.18)" }} />
                  <div style={{ position: "relative", display: "flex", fontSize: 12 }}>
                    <span>{o.label}</span><span style={{ flex: 1 }} />
                    <span className="mono">{n} · {pct}%</span>
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <button className="btn" style={{ padding: "5px 12px", background: "var(--ok)", color: "#fffaf0" }}
                    onClick={() => close(true)}>收票 + 執行多數決</button>
            <button className="btn ghost" style={{ padding: "5px 12px" }} onClick={() => close(false)}>收票但不執行</button>
          </div>
        </div>
      )}

      {history.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginBottom: 3 }}>歷次全班決定</div>
          {history.slice(0, 5).map((h, i) => (
            <div key={i} style={{ fontSize: 11.5, color: "var(--text-2)", marginBottom: 2 }}>
              <b>{h.winner_label ?? "無人投票"}</b>
              <span className="muted"> · {h.votes} 票 · {h.result?.detail}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
