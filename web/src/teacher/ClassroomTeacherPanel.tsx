import { useEffect, useState } from "react";
import {
  ClassroomExercise, ClassroomBoardRow, ClassroomActive,
  getClassroomExercises, getClassroomActive, launchClassroom, stopClassroom,
  getClassroomBoard, getClassroomGradebook, extendClassroom,
} from "../api";
import ClassroomProjection from "../classroom/ClassroomProjection";
import PollPanel from "./PollPanel";

// 教師面「課堂即時練習」控制台:瀏覽/佈題/收題 + 即時看板(答對率長條/分佈)+ 投影模式 + 平時成績。
export default function ClassroomTeacherPanel({ onMsg }: { onMsg: (m: string) => void }) {
  const [exercises, setExercises] = useState<ClassroomExercise[]>([]);
  const [active, setActive] = useState<ClassroomActive | null>(null);
  const [board, setBoard] = useState<ClassroomBoardRow[]>([]);
  const [grades, setGrades] = useState<{ student: string; answered: number; avg: number }[]>([]);
  const [showGrades, setShowGrades] = useState(false);
  const [project, setProject] = useState(false);
  const [mins, setMins] = useState("3");        // 佈題倒數(分鐘);空白 = 不設倒數
  const [remain, setRemain] = useState<number | null>(null);
  const activeId = active?.exercise ?? null;
  const target = active?.target ?? null;

  useEffect(() => { getClassroomExercises().then((r) => setExercises(r.exercises)).catch(() => {}); }, []);

  useEffect(() => {
    const tick = async () => {
      try {
        const a = (await getClassroomActive()).active;
        setActive(a);
        setRemain(a?.remain_s ?? null);
        if (a) setBoard((await getClassroomBoard()).questions);
        else setBoard([]);
      } catch { /* 未設教師 token 時 board 會 401 */ }
    };
    tick();
    const id = setInterval(tick, 2500);
    return () => clearInterval(id);
  }, []);

  const launch = async (id: string) => {
    try {
      const secs = mins.trim() ? Math.max(10, Math.round(Number(mins) * 60)) : null;
      const r = await launchClassroom(id, Number.isFinite(secs as number) ? secs : null);
      onMsg(`📣 已佈題「${exercises.find((e) => e.id === id)?.title ?? id}」→ 設備 ${r.target}`
            + `(${r.applied.condition ?? ""})${secs ? ` · 倒數 ${mins} 分鐘` : " · 不設倒數"}`);
    } catch (e: any) {
      onMsg(`佈題失敗:${e.message}${String(e.message).includes("401") ? "(先填 dev-teacher-token 並儲存)" : ""}`);
    }
  };
  const stop = async (reset: boolean) => {
    try { const r = await stopClassroom(reset); onMsg(`已收題${r.reset ? `,並把 ${r.target} 修回健康` : ""}`); }
    catch (e: any) { onMsg(`收題失敗:${e.message}`); }
  };
  const loadGrades = async () => {
    try { setGrades((await getClassroomGradebook()).gradebook); setShowGrades(true); }
    catch (e: any) { onMsg(`讀平時成績失敗:${e.message}`); }
  };

  return (
    <div className="card">
      <div className="card-title">📣 課堂即時練習(佈題 → 學生手機作答 → 即時批改)</div>
      <div className="hint" style={{ margin: "0 0 8px" }}>
        一鍵佈題:平台對一台設備套用情境,學生在「📣 課堂練習」分頁用手機作答,計入平時成績。
        佈題後<b>讓平台跑一會兒</b>再讓學生答進階題(統計/相關/趨勢需要一點資料)。
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <span className="muted" style={{ fontSize: 11.5 }}>作答倒數</span>
        <input className="inp mono" value={mins} onChange={(e) => setMins(e.target.value)}
               placeholder="留空=不限時" style={{ width: 66, padding: "4px 8px", fontSize: 12 }} />
        <span className="muted" style={{ fontSize: 11.5 }}>分鐘 —— 時間到就不收答案(用教室的鐘,不是模擬時鐘)</span>
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {exercises.length === 0 && <span className="muted" style={{ fontSize: 12 }}>(讀不到 scenarios/classroom_exercises.yaml)</span>}
        {exercises.map((e) => {
          const on = activeId === e.id;
          return (
            <button key={e.id} className="btn ghost" onClick={() => launch(e.id)}
              title={`${e.brief ?? ""} · ${e.questions} 題`}
              style={on ? { background: "#f4e6d2", borderColor: "var(--accent)", color: "var(--accent)" } : {}}>
              {on ? "● " : ""}{e.title}
              <span style={{ marginLeft: 6, fontSize: 10, color: e.difficulty === "advanced" ? "var(--warn)" : "var(--ok)" }}>
                {e.difficulty === "advanced" ? "進階" : "基礎"} · {e.questions}題
              </span>
            </button>
          );
        })}
      </div>

      {activeId ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span className="pill" style={{ color: "var(--accent)" }}>進行中:{active?.title ?? activeId} · 設備 <b className="mono">{target}</b></span>
            {remain != null && (
              <span className="mono" style={{ fontSize: 13, fontWeight: 800, padding: "2px 10px", borderRadius: 999,
                background: remain <= 0 ? "var(--fault)" : remain <= 30 ? "var(--warn)" : "var(--panel-3)",
                color: remain <= 30 ? "#fffaf0" : "var(--text-2)" }}>
                {remain <= 0 ? "已截止" : `⏱ ${Math.floor(remain / 60)}:${String(Math.floor(remain % 60)).padStart(2, "0")}`}
              </span>
            )}
            <button className="btn ghost" style={{ padding: "5px 10px", fontSize: 12 }}
                    onClick={() => extendClassroom(60).then(() => onMsg("已延長 1 分鐘")).catch(() => onMsg("延長失敗"))}>+1 分</button>
            <button className="btn primary" style={{ padding: "5px 12px" }} onClick={() => setProject(true)}>🔎 投影模式</button>
            <button className="btn" style={{ padding: "5px 12px", background: "var(--warn)", color: "#fffaf0" }} onClick={() => stop(true)}>收題 + 修復設備</button>
            <button className="btn ghost" style={{ padding: "5px 12px" }} onClick={() => stop(false)}>收題(保留狀態)</button>
          </div>

          <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
            {board.map((q) => (
              <div key={q.question} className="card" style={{ padding: "8px 12px", background: "var(--panel-3)" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 600, fontSize: 12.5 }} title={q.prompt}>
                    {q.question} <span style={{ fontSize: 10, color: q.tier === "complex" ? "var(--pred)" : "var(--dim)" }}>{q.tier === "complex" ? "算" : "看"}</span>
                  </span>
                  <span className="muted mono" style={{ fontSize: 11 }}>{q.prompt.slice(0, 28)}{q.prompt.length > 28 ? "…" : ""}</span>
                  <span style={{ flex: 1 }} />
                  {q.first_solver && (
                    <span className="mono" style={{ fontSize: 11, color: "var(--warn)" }}
                          title="本輪第一個答對的人">🥇 {q.first_solver}
                      {q.first_elapsed_s != null && <span className="muted"> {q.first_elapsed_s}s</span>}
                    </span>
                  )}
                  <span className="muted" style={{ fontSize: 11 }}>{q.students} 人作答</span>
                </div>
                {/* 答對率長條 */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
                  <div style={{ flex: 1, height: 10, borderRadius: 6, background: "#efe4d0", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${q.rate != null ? Math.round(q.rate * 100) : 0}%`,
                                  background: q.rate != null && q.rate >= 0.6 ? "var(--ok)" : "var(--warn)", transition: "width .3s" }} />
                  </div>
                  <span className="mono" style={{ fontSize: 12, width: 42, textAlign: "right",
                                color: q.rate != null && q.rate >= 0.6 ? "var(--ok)" : q.rate != null ? "var(--warn)" : "var(--dim)" }}>
                    {q.rate != null ? `${Math.round(q.rate * 100)}%` : "—"}
                  </span>
                </div>
                {/* 選項分佈 mini bars */}
                {Object.keys(q.dist).length > 0 && (
                  <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
                    {Object.entries(q.dist).map(([k, n]) => {
                      const pct = q.students ? Math.round((n / q.students) * 100) : 0;
                      return (
                        <span key={k} style={{ position: "relative", overflow: "hidden", border: "1px solid var(--line)", borderRadius: 6,
                                               padding: "2px 8px", fontSize: 11, background: "#efe4d0" }}>
                          <span style={{ position: "absolute", inset: 0, width: `${pct}%`, background: "rgba(181,98,46,.18)" }} />
                          <span style={{ position: "relative" }} className="mono">{k}: {n}</span>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>目前沒有進行中的練習。點上面任一題即佈題。</div>
      )}

      <div style={{ marginTop: 10 }}>
        <button className="btn ghost" style={{ padding: "5px 12px" }} onClick={loadGrades}>📗 平時成績(課堂練習)</button>
        {showGrades && (
          <table className="taglist" style={{ marginTop: 8 }}><tbody>
            <tr style={{ color: "var(--text-2)" }}><td style={{ fontSize: 11 }}>座號/學號</td><td style={{ fontSize: 11 }}>作答題數</td><td style={{ fontSize: 11 }}>平均分</td></tr>
            {grades.length === 0 && <tr><td className="muted" colSpan={3} style={{ fontSize: 12 }}>尚無作答紀錄</td></tr>}
            {grades.slice(0, 30).map((g) => (
              <tr key={g.student}><td className="name">{g.student}</td><td className="val">{g.answered}</td>
                <td className="val" style={{ color: g.avg >= 60 ? "var(--ok)" : "var(--warn)" }}>{g.avg}</td></tr>
            ))}
          </tbody></table>
        )}
      </div>

      {/* 全班投票:沒有正解的取捨題,收票後照多數決真的去動引擎 */}
      <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
        <PollPanel onMsg={onMsg} />
      </div>

      {project && active && <ClassroomProjection active={active} board={board} remain={remain} onClose={() => setProject(false)} />}
    </div>
  );
}
