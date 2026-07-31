import { useEffect, useState } from "react";
import { LevelStatus, getLevelStatus } from "../api";

/**
 * 資料的一生 —— 九關進度條(學生面)。
 *
 * 九關就是課程主軸的九個階段,不是另外發明的遊戲劇情。過關條件是課程本來就要交的東西,
 * 判定全部由平台現查(對 ground-truth 的作業、認領、告警 F1…),學生說「我做完了」沒有用。
 * 兩關本質要人看(視覺化 demo、期末報告),誠實標成「教師認可」。
 */
export default function LevelsPanel({ me }: { me: string }) {
  const [st, setSt] = useState<LevelStatus | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!me) { setSt(null); return; }
    const load = () => getLevelStatus(me).then(setSt).catch(() => {});
    load();
    const id = setInterval(load, 8000);
    return () => clearInterval(id);
  }, [me]);

  if (!me) return (
    <div className="card" style={{ padding: "10px 14px", marginBottom: 16 }}>
      <span className="muted" style={{ fontSize: 12.5 }}>設定學號後,這裡會顯示你的「資料的一生」九關進度。</span>
    </div>
  );
  if (!st) return null;

  const pct = st.total ? (st.done / st.total) * 100 : 0;

  return (
    <div className="card" style={{ padding: "12px 14px", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div className="card-title" style={{ fontSize: 13.5, margin: 0 }}>🧭 資料的一生</div>
        <span className="mono" style={{ fontSize: 12, color: "var(--text-2)" }}>{st.done} / {st.total} 關</span>
        <span style={{ flex: 1 }} />
        <button className="btn" style={{ padding: "3px 10px", fontSize: 11.5 }} onClick={() => setOpen(!open)}>
          {open ? "收合" : "看每一關"}
        </button>
      </div>

      {/* 九格進度條:綠=過、灰=未過、虛線框=下一關 */}
      <div style={{ display: "flex", gap: 4, margin: "10px 0 6px" }}>
        {st.levels.map((l) => {
          const isNext = st.next?.id === l.id;
          return (
            <div key={l.id} title={`${l.title}\n${l.evidence}`}
              style={{
                flex: 1, minWidth: 0, height: 30, borderRadius: 6, display: "flex",
                alignItems: "center", justifyContent: "center", fontSize: 11.5, fontWeight: 600,
                background: l.done ? "var(--ok)" : "var(--panel-3)",
                color: l.done ? "#fffaf0" : "var(--dim)",
                outline: isNext ? "2px dashed var(--accent)" : "none", outlineOffset: -2,
              }}>
              {l.name}
            </div>
          );
        })}
      </div>
      <div style={{ height: 3, background: "var(--panel-3)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: "var(--accent-grad, var(--ok))" }} />
      </div>

      {st.next && (
        <div className="hint" style={{ marginTop: 8 }}>
          <b>下一關 · {st.next.name}:{st.next.title}</b><br />
          {st.next.hint}
          <span className="mono" style={{ color: "var(--dim)", marginLeft: 6 }}>({st.next.evidence})</span>
        </div>
      )}

      {open && (
        <>
          <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 10 }}>
            <tbody>
              {st.levels.map((l) => (
                <tr key={l.id}>
                  <td style={{ padding: "5px 6px", borderBottom: "1px solid var(--line-3)", width: 22 }}>
                    {l.done ? "✅" : l.manual ? "🧑‍🏫" : "⬜"}
                  </td>
                  <td style={{ padding: "5px 6px", borderBottom: "1px solid var(--line-3)", fontSize: 12.5, fontWeight: 600 }}>
                    {l.name}
                    {l.week != null && <span className="mono muted" style={{ fontSize: 10.5, marginLeft: 5 }}>W{l.week}</span>}
                  </td>
                  <td className="muted" style={{ padding: "5px 6px", borderBottom: "1px solid var(--line-3)", fontSize: 11.5 }}>
                    {l.title}
                  </td>
                  <td className="mono" style={{ padding: "5px 6px", borderBottom: "1px solid var(--line-3)", fontSize: 11,
                      color: l.done ? "var(--ok)" : "var(--dim)", textAlign: "right" }}>
                    {l.evidence}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {st.badges.length > 0 && (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
              {st.badges.map((b) => (
                <span key={b.id} className="pill" title={`${b.hint}\n${b.evidence}`}
                  style={{ fontSize: 11.5, opacity: b.done ? 1 : 0.45,
                           color: b.done ? "var(--ok)" : "var(--dim)",
                           borderColor: b.done ? "#d3e2c4" : "var(--line)" }}>
                  {b.done ? "🏅" : "🔒"} {b.name}
                </span>
              ))}
            </div>
          )}

          {st.access.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginBottom: 3 }}>
                你的設備被協定讀取的情況(伺服器端看到的,不是你自己說的)
              </div>
              {st.access.map((a) => (
                <div key={a.device + a.protocol} className="mono" style={{ fontSize: 11.5, color: "var(--text-2)" }}>
                  {a.device} · {a.protocol}:{a.reads} 次
                  {a.avg_interval_s != null && <span className="muted">,平均 {a.avg_interval_s}s 打一次</span>}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
