import { ClassroomActive, ClassroomBoardRow } from "../api";

// 投影模式:全螢幕大字題卡,適合投影給全班看。顯示目前佈題的每一題 + 即時作答統計。
export default function ClassroomProjection({
  active, board, onClose,
}: { active: ClassroomActive; board: ClassroomBoardRow[]; onClose: () => void }) {
  const byId = new Map(board.map((b) => [b.question, b]));
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 100, background: "var(--bg)", overflow: "auto", padding: "3vh 4vw" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 16, flexWrap: "wrap", marginBottom: "2vh" }}>
        <span style={{ fontSize: "clamp(24px,3vw,40px)", fontWeight: 800 }}>{active.title}</span>
        <span className="badge" style={{ background: active.difficulty === "advanced" ? "var(--warn)" : "var(--ok)", color: "#08121e", fontSize: 16 }}>
          {active.difficulty === "advanced" ? "進階" : "基礎"}
        </span>
        <span className="pill mono" style={{ fontSize: 16 }}>設備 {active.target}</span>
        <span style={{ flex: 1 }} />
        <button className="btn ghost" style={{ fontSize: 16, padding: "8px 16px" }} onClick={onClose}>✕ 離開投影</button>
      </div>
      {active.brief && <div style={{ fontSize: "clamp(15px,1.4vw,22px)", color: "var(--text-2)", marginBottom: "3vh" }}>{active.brief}</div>}

      <div style={{ display: "grid", gap: "2.4vh" }}>
        {active.questions.map((qn, i) => {
          const b = byId.get(qn.id);
          const complex = qn.tier === "complex";
          return (
            <div key={qn.id} className="card" style={{ padding: "clamp(16px,2vw,28px)" }}>
              <div style={{ display: "flex", gap: 14, alignItems: "baseline", flexWrap: "wrap" }}>
                <span style={{ fontSize: "clamp(22px,2.4vw,34px)", fontWeight: 800, color: "var(--accent)" }}>{i + 1}.</span>
                <span style={{ fontSize: "clamp(20px,2.2vw,32px)", fontWeight: 700, lineHeight: 1.35, flex: 1, minWidth: 260 }}>{qn.prompt}</span>
                <span className="badge" style={{ background: complex ? "var(--pred)" : "var(--panel-3)", color: complex ? "#08121e" : "var(--text-2)", fontSize: 15 }}>
                  {complex ? "🧮 要計算/分析" : "👀 觀察即可"}
                </span>
              </div>

              {qn.type === "choice" && qn.choices && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 14 }}>
                  {qn.choices.map((c) => {
                    const n = b?.dist?.[c] ?? 0;
                    const total = b?.students || 0;
                    const pct = total ? Math.round((n / total) * 100) : 0;
                    return (
                      <div key={c} style={{ position: "relative", overflow: "hidden", border: "1px solid var(--line)", borderRadius: 10,
                                            padding: "10px 16px", minWidth: 130, background: "var(--panel-3)" }}>
                        <div style={{ position: "absolute", inset: 0, width: `${pct}%`, background: "rgba(76,156,232,.20)" }} />
                        <div style={{ position: "relative", fontSize: "clamp(16px,1.6vw,24px)", fontWeight: 700 }}>{c}</div>
                        <div style={{ position: "relative", fontSize: 14, color: "var(--text-2)" }}>{n} 人 · {pct}%</div>
                      </div>
                    );
                  })}
                </div>
              )}
              {qn.type === "numeric" && (
                <div style={{ marginTop: 12, fontSize: "clamp(15px,1.4vw,20px)", color: "var(--text-2)" }}>
                  數字題{qn.unit ? `(單位:${qn.unit})` : ""} —— 學生用自己的工具算完,在手機作答。
                </div>
              )}

              <div style={{ display: "flex", gap: 20, marginTop: 12, fontSize: "clamp(14px,1.3vw,18px)" }}>
                <span className="muted">作答 <b style={{ color: "var(--text)" }}>{b?.students ?? 0}</b> 人</span>
                <span className="muted">答對率 <b style={{ color: (b?.rate ?? 0) >= 0.6 ? "var(--ok)" : "var(--warn)" }}>
                  {b?.rate != null ? `${Math.round(b.rate * 100)}%` : "—"}</b></span>
                {qn.hint && <span className="muted">💡 {qn.hint}</span>}
              </div>
            </div>
          );
        })}
      </div>
      <div className="muted" style={{ marginTop: "2vh", fontSize: 13 }}>合成數據 · 統計每 2.5 秒更新;學生在「📣 課堂練習」手機頁作答。</div>
    </div>
  );
}
