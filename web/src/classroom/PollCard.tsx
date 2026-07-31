import { useEffect, useState } from "react";
import { PollActive, PollRecord, getActivePoll, votePoll } from "../api";

/**
 * 全班投票(學生手機)。
 *
 * 跟上面的練習不同:投票**沒有正解**。收票後平台會照多數決真的去動引擎 ——
 * 投「現在保養」就真的停機、投「拉高稼動」就真的磨得更快。下一節課回來看 OEE,
 * 那是全班一起做的決定造成的。
 *
 * 票數即時公開是刻意的:投票不是考試,看得到風向才有討論。
 */
export default function PollCard({ sid }: { sid: string }) {
  const [poll, setPoll] = useState<PollActive | null>(null);
  const [history, setHistory] = useState<PollRecord[]>([]);
  const [mine, setMine] = useState("");
  const [err, setErr] = useState("");
  const [remain, setRemain] = useState<number | null>(null);

  useEffect(() => {
    const tick = () => getActivePoll().then((r) => {
      setPoll(r.active); setHistory(r.history || []);
      setRemain(r.active?.remain_s ?? null);
      if (!r.active) setMine("");
    }).catch(() => {});
    tick();
    const id = setInterval(tick, 4000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (remain == null) return;
    const id = setInterval(() => setRemain((r) => (r == null ? null : Math.max(0, r - 1))), 1000);
    return () => clearInterval(id);
  }, [remain == null]);

  const vote = async (optId: string) => {
    if (!sid.trim()) { setErr("請先在上方填座號 / 學號"); return; }
    setErr("");
    try { await votePoll(poll!.poll, optId, sid.trim()); setMine(optId); }
    catch { setErr("投票失敗(可能已截止)"); }
  };

  if (!poll) {
    if (!history.length) return null;
    const last = history[0];
    return (
      <div className="card" style={{ padding: "12px 14px", marginTop: 14 }}>
        <div className="card-title" style={{ fontSize: 13.5 }}>🗳 上次全班決定</div>
        <div style={{ fontSize: 13.5 }}>{last.question}</div>
        <div style={{ fontSize: 13, marginTop: 6 }}>
          <b>{last.winner_label}</b>（{last.votes} 票）
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>→ {last.result?.detail}</div>
      </div>
    );
  }

  const total = Math.max(1, poll.votes);
  const closed = remain != null && remain <= 0;

  return (
    <div className="card" style={{ padding: "12px 14px", marginTop: 14, borderColor: "var(--accent)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span className="card-title" style={{ fontSize: 13.5, margin: 0 }}>🗳 全班投票</span>
        {poll.device && <span className="pill mono" style={{ fontSize: 11 }}>{poll.device}</span>}
        <span style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 12, color: "var(--text-2)" }}>{poll.votes} 票</span>
        {remain != null && (
          <span className="mono" style={{ fontSize: 13, fontWeight: 800, padding: "1px 8px", borderRadius: 999,
            background: closed ? "var(--fault)" : remain <= 20 ? "var(--warn)" : "var(--panel-3)",
            color: closed || remain <= 20 ? "#fffaf0" : "var(--text-2)" }}>
            {closed ? "已截止" : `⏱ ${Math.floor(remain)}s`}
          </span>
        )}
      </div>

      <div style={{ fontSize: 15.5, fontWeight: 700, margin: "8px 0 4px", lineHeight: 1.45 }}>{poll.question}</div>
      {poll.brief && <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>{poll.brief}</div>}

      <div style={{ display: "grid", gap: 8 }}>
        {poll.options.map((o) => {
          const n = poll.tally[o.id] ?? 0;
          const pct = Math.round((n / total) * 100);
          const picked = mine === o.id;
          return (
            <button key={o.id} className="btn" disabled={closed} onClick={() => vote(o.id)}
              style={{ position: "relative", overflow: "hidden", textAlign: "left", padding: "10px 12px",
                       border: `1px solid ${picked ? "var(--accent)" : "var(--line)"}`,
                       background: "var(--panel-3)", opacity: closed ? 0.7 : 1 }}>
              <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: "rgba(181,98,46,.18)" }} />
              <div style={{ position: "relative", display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontSize: 14.5, fontWeight: 700 }}>{picked ? "✓ " : ""}{o.label}</span>
                <span style={{ flex: 1 }} />
                <span className="mono" style={{ fontSize: 12, color: "var(--text-2)" }}>{n} 票 · {pct}%</span>
              </div>
              {o.detail && <div className="muted" style={{ position: "relative", fontSize: 11.5, marginTop: 3 }}>{o.detail}</div>}
            </button>
          );
        })}
      </div>

      {err && <div style={{ color: "var(--fault)", fontSize: 12.5, marginTop: 8 }}>{err}</div>}
      <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        這題沒有正解。收票後平台會<b>照多數決真的去動引擎</b> —— 下一節課回來看 OEE,那就是全班的決定。
        可以改票,以最後一次為準。
      </div>
    </div>
  );
}
