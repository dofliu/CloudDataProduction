import { useEffect, useState } from "react";
import { LevelBoard as Board, getLevelBoard, markLevel } from "../api";

/**
 * 全班進度熱力圖(教師面)。
 *
 * 60 人無助教最難的不是批改(那已經自動了),是**看不到誰卡住**。這張 N×9 的格子牆
 * 就是為了回答一個問題:現在全班卡在哪一步?
 *
 * 「瓶頸關」刻意不是「沒過的人最多的那關」—— 那永遠是最後一關,沒有資訊量。
 * 算的是「前一關過了、這一關沒過」的人數:已經走到門口卻進不去的,才是真的卡住。
 *
 * 人工判定的兩關(視覺化 demo、期末報告)可以直接在格子上點一下勾/取消。
 */
export default function LevelBoard() {
  const [b, setB] = useState<Board | null>(null);
  const [busy, setBusy] = useState("");

  const load = () => getLevelBoard().then(setB).catch(() => {});
  useEffect(() => { load(); const id = setInterval(load, 10000); return () => clearInterval(id); }, []);

  if (!b) return null;

  const toggle = async (student: string, level: string, done: boolean) => {
    setBusy(`${student}:${level}`);
    try { await markLevel(student, level, done); await load(); } finally { setBusy(""); }
  };

  return (
    <div className="card" style={{ padding: "12px 14px" }}>
      <div className="card-title">🧭 全班關卡進度({b.count} 人)</div>
      {b.bottleneck && (
        <div className="hint" style={{ marginTop: 0 }}>
          <b>瓶頸:{b.bottleneck.name}</b> —— 有 {b.bottleneck.count} 人已經過了前一關卻卡在這裡。
          (不是「沒過的人最多的那關」,是「走到門口進不去」的那關。)
        </div>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11.5 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "4px 6px", color: "var(--dim)", fontSize: 10.5, position: "sticky", left: 0, background: "var(--panel)" }}>學號</th>
              {b.levels.map((l) => (
                <th key={l.id} title={l.id} style={{ padding: "4px 5px", color: "var(--dim)", fontSize: 10.5, fontWeight: 500, minWidth: 42 }}>
                  {l.name}{l.manual ? " 🧑‍🏫" : ""}
                  <div className="mono" style={{ fontSize: 9.5, color: l.stuck > 0 ? "var(--warn)" : "var(--ok)" }}>{l.done}/{b.count}</div>
                </th>
              ))}
              <th style={{ padding: "4px 6px", color: "var(--dim)", fontSize: 10.5 }}>徽章</th>
            </tr>
          </thead>
          <tbody>
            {b.students.map((s) => (
              <tr key={s.student}>
                <td className="mono" style={{ padding: "3px 6px", position: "sticky", left: 0, background: "var(--panel)", borderBottom: "1px solid var(--line-3)" }}>
                  {s.student} <span className="muted">{s.done}/{s.total}</span>
                </td>
                {s.levels.map((l) => (
                  <td key={l.id} style={{ padding: 2, borderBottom: "1px solid var(--line-3)", textAlign: "center" }}>
                    <div
                      title={`${l.title}\n${l.evidence}${l.manual ? "\n(點一下切換教師認可)" : ""}`}
                      onClick={l.manual && !busy ? () => toggle(s.student, l.id, !l.done) : undefined}
                      style={{
                        width: 34, height: 18, margin: "0 auto", borderRadius: 4,
                        background: l.done ? "var(--ok)" : l.manual ? "var(--panel-3)" : "var(--line-3)",
                        border: l.manual ? "1px dashed var(--line)" : "none",
                        cursor: l.manual ? "pointer" : "default",
                      }} />
                  </td>
                ))}
                <td style={{ padding: "3px 6px", borderBottom: "1px solid var(--line-3)", whiteSpace: "nowrap" }}>
                  {s.badges.filter((x) => x.done).map((x) => (
                    <span key={x.id} title={x.name} style={{ marginRight: 2 }}>🏅</span>
                  ))}
                </td>
              </tr>
            ))}
            {b.students.length === 0 && (
              <tr><td colSpan={b.levels.length + 2} className="hint" style={{ padding: "8px 6px" }}>
                還沒有學生(建帳號或等學生認領公司後就會出現)。
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
        🧑‍🏫 = 人工判定的關卡(視覺化 demo / 期末報告),點格子切換。其餘由平台現查,學生說了不算。
      </div>
    </div>
  );
}
