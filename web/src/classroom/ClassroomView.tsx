import { useEffect, useState } from "react";
import {
  ClassroomActive, ClassroomAnswerResult, ClassroomQuestion,
  getClassroomActive, answerClassroom,
} from "../api";
import PageGuide from "../help/PageGuide";

// 學生面「課堂即時練習」——手機友善:老師佈題後,這裡顯示題目,學生輸入座號/學號作答,即時批改。
export default function ClassroomView() {
  const [active, setActive] = useState<ClassroomActive | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [sid, setSid] = useState(() => localStorage.getItem("student_id") || localStorage.getItem("seat_no") || "");

  useEffect(() => {
    const tick = () => getClassroomActive().then((r) => { setActive(r.active); setLoaded(true); }).catch(() => setLoaded(true));
    tick();
    const id = setInterval(tick, 5000);
    return () => clearInterval(id);
  }, []);

  const saveSid = (v: string) => { setSid(v); localStorage.setItem("seat_no", v); };

  return (
    <div className="page" style={{ maxWidth: 640, margin: "0 auto", padding: "14px 14px 40px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h2 style={{ margin: "2px 0" }}>📣 課堂即時練習</h2>
        <span className="muted" style={{ fontSize: 12 }}>老師佈題 → 你用手機觀察後作答 → 即時批改(計入平時成績)</span>
      </div>

      <PageGuide id="classroom" title="這頁怎麼用" steps={[
        <>先填你的<b>座號 / 學號</b>(下方欄位,會記分)。</>,
        <>等老師<b>佈題</b>——題目會自動出現(每 5 秒更新)。</>,
        <><b>👀 觀察題</b>:看設備狀態直接選;<b>🧮 計算題</b>:用你的 client / 監控台把資料讀下來算完,再填數字。</>,
        <>送出即<b>即時批改</b>並給解說;可再作答,取最佳分計入平時成績。</>,
      ]} />

      <div className="card" style={{ padding: "10px 12px", margin: "10px 0", position: "sticky", top: 6, zIndex: 5 }}>
        <label style={{ fontSize: 12, color: "var(--text-2)" }}>我的座號 / 學號</label>
        <input className="inp" value={sid} onChange={(e) => saveSid(e.target.value)} placeholder="例:座號 12 或 s1234567"
               style={{ width: "100%", padding: "8px 10px", marginTop: 4, fontSize: 15 }} />
      </div>

      {!loaded ? (
        <div className="muted" style={{ padding: 24, textAlign: "center" }}>載入中…</div>
      ) : !active ? (
        <div className="card" style={{ padding: 24, textAlign: "center" }}>
          <div style={{ fontSize: 34, marginBottom: 8 }}>⏳</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>老師還沒佈題</div>
          <div className="muted" style={{ fontSize: 13 }}>老師在教師控制台佈題後,題目會自動出現在這裡(每 5 秒更新)。</div>
        </div>
      ) : (
        <Exercise active={active} sid={sid} />
      )}
    </div>
  );
}

function Exercise({ active, sid }: { active: ClassroomActive; sid: string }) {
  return (
    <>
      <div className="card" style={{ padding: "12px 14px", marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ fontSize: 17, fontWeight: 700 }}>{active.title}</span>
          <DiffBadge d={active.difficulty} />
          <span className="pill mono" style={{ fontSize: 11 }}>設備 {active.target}</span>
        </div>
        {active.brief && <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>{active.brief}</div>}
        <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
          進階題要「算」或「分析」——用你自己的 client / 監控台讀資料算完,把數字填進來。
        </div>
      </div>

      {active.questions.map((q, i) => (
        <Question key={q.id} exercise={active.exercise} q={q} n={i + 1} sid={sid} />
      ))}
    </>
  );
}

function DiffBadge({ d }: { d?: string }) {
  const adv = d === "advanced";
  return (
    <span className="badge" style={{ background: adv ? "var(--warn)" : "var(--ok)", color: "#fffaf0", fontSize: 11 }}>
      {adv ? "進階" : "基礎"}
    </span>
  );
}

function Question({ exercise, q, n, sid }: { exercise: string; q: ClassroomQuestion; n: number; sid: string }) {
  const [val, setVal] = useState("");
  const [res, setRes] = useState<ClassroomAnswerResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (answer: any) => {
    if (!sid.trim()) { setErr("請先在上方填座號 / 學號"); return; }
    setErr(""); setBusy(true);
    try {
      setRes(await answerClassroom(exercise, q.id, sid.trim(), answer));
    } catch (e: any) {
      setErr(e?.message?.includes("400") ? "此題目前未在進行中(老師可能已收題)" : `送出失敗:${e.message}`);
    } finally { setBusy(false); }
  };

  const complex = q.tier === "complex";
  return (
    <div className="card" style={{ padding: "12px 14px", marginBottom: 10 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <span style={{ fontWeight: 700, color: "var(--accent)" }}>{n}.</span>
        <span className="badge" style={{ background: complex ? "var(--pred)" : "var(--panel-3)", color: complex ? "#fffaf0" : "var(--text-2)", fontSize: 10.5 }}>
          {complex ? "🧮 要計算/分析" : "👀 觀察即可"}
        </span>
      </div>
      <div style={{ fontSize: 15, margin: "8px 0 10px", lineHeight: 1.5 }}>{q.prompt}</div>

      {q.type === "choice" ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {(q.choices ?? []).map((c) => (
            <button key={c} className="btn" disabled={busy}
              style={{ padding: "9px 14px", fontSize: 14, background: "var(--panel-3)", border: "1px solid var(--line)" }}
              onClick={() => submit(c)}>{c}</button>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input className="inp mono" value={val} onChange={(e) => setVal(e.target.value)} inputMode="decimal"
                 placeholder="填你算出的數字" onKeyDown={(e) => e.key === "Enter" && submit(val)}
                 style={{ width: 170, padding: "9px 11px", fontSize: 15 }} />
          {q.unit && <span className="muted mono" style={{ fontSize: 13 }}>{q.unit}</span>}
          <button className="btn primary" disabled={busy} style={{ padding: "9px 16px" }} onClick={() => submit(val)}>送出</button>
        </div>
      )}

      {q.hint && !res && <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>💡 {q.hint}</div>}
      {err && <div style={{ color: "var(--fault)", fontSize: 13, marginTop: 8 }}>{err}</div>}
      {res && (
        <div style={{ marginTop: 10, padding: "10px 12px", borderRadius: 8,
                      background: res.passed ? "rgba(55,200,113,.12)" : "rgba(255,92,92,.10)",
                      border: `1px solid ${res.passed ? "var(--ok)" : "var(--fault)"}` }}>
          <div style={{ fontWeight: 600, color: res.passed ? "var(--ok)" : "var(--fault)" }}>
            {res.passed ? "✓ " : "✗ "}得分 {res.score}
          </div>
          <div style={{ fontSize: 13, marginTop: 4 }}>{res.feedback}</div>
          {res.explain && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>📖 {res.explain}</div>}
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>可再作答一次,取最佳分計入平時成績。</div>
        </div>
      )}
    </div>
  );
}
