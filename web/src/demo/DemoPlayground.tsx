import { useEffect, useRef, useState } from "react";

/**
 * ▶ 範例示範 —— 一台 CNC 的完整處置迴圈,全程模擬、不碰後端。
 *
 * 帶學生看一次「認領 → 運轉 → 故障 → 分析 → 診斷根因 → 排除復機」,
 * 用一台假的示範設備 DEMO-CNC-01,前端跑一個小型退化模型(訊號彼此相關、
 * 帶正解),動畫呈現振動 / 溫度 / 電流 / 健康度隨時間變化,並在關鍵處停下來
 * 讓學生自己判斷根因。
 *
 * 為什麼是純模擬:故障注入是教師權限、且平台鐵則「狀態只在引擎」。這是給學生的
 * 教學範例,不應該動真實園區。用自足劇本,任何人隨時可播、可重播,安全零風險。
 */

type Phase = "intro" | "claim" | "run" | "onset" | "analyze" | "diagnose" | "resolve" | "done";

interface Pt { t: number; vib: number; temp: number; cur: number; health: number; }
interface Ticket { status: "open" | "acked" | "resolved"; }
interface Sim {
  phase: Phase;
  playing: boolean;
  p: number;           // 當前動畫階段的進度 0..1
  runTicks: number;
  history: Pt[];
  ticket: Ticket | null;
  onsetIdx: number | null;
  tHours: number;
  onsetH: number | null;
  ackH: number | null;
  resolveH: number | null;
  diagPick: string | null;
  diagOk: boolean;
}

const DEV = "DEMO-CNC-01";
const COMPANY = "示範精密 DEMO-PRECISION";
const VIB_THRESH = 6.0;      // 振動告警門檻(與連線包建議一致)
const TICK_MS = 480;
const DT_H = 0.35;           // 每 tick 推進的模擬小時(加速)

const smooth = (x: number) => x * x * (3 - 2 * x);
const noise = (a: number) => (Math.random() * 2 - 1) * a;

function signalAt(phase: Phase, p: number): Pt {
  if (phase === "onset") {
    const e = smooth(p);
    return {
      t: 0,
      vib: 2.1 + 5.6 * e + noise(0.12),
      temp: 64 + 27 * Math.pow(e, 1.25) + noise(0.7),   // 溫度略落後振動
      cur: 9.4 + noise(0.25),                            // 負載電流全程平穩 = 關鍵線索
      health: Math.max(0.02, 1 - 0.97 * e),
    };
  }
  if (phase === "resolve") {
    const e = smooth(p);
    return {
      t: 0,
      vib: 7.7 - 5.5 * e + noise(0.12),
      temp: 91 - 27 * e + noise(0.7),
      cur: 9.4 + noise(0.25),
      health: Math.min(1, 0.04 + 0.96 * e),
    };
  }
  // run / 其它:健康基線
  return { t: 0, vib: 2.1 + noise(0.15), temp: 64 + noise(0.8), cur: 9.4 + noise(0.25), health: 1.0 };
}

function stepSim(s: Sim): Sim {
  if (!s.playing) return s;
  const push = (phase: Phase, p: number): Pt => { const pt = signalAt(phase, p); pt.t = s.tHours + DT_H; return pt; };

  if (s.phase === "run") {
    const pt = push("run", 0);
    const runTicks = s.runTicks + 1;
    const base: Sim = { ...s, history: [...s.history, pt], runTicks, tHours: s.tHours + DT_H };
    return runTicks >= 5 ? { ...base, phase: "onset", p: 0 } : base;
  }

  if (s.phase === "onset") {
    const p = Math.min(1, s.p + 0.075);
    const pt = push("onset", p);
    const history = [...s.history, pt];
    let ticket = s.ticket, onsetIdx = s.onsetIdx, onsetH = s.onsetH;
    if (!ticket && pt.vib > VIB_THRESH) {           // 越過振動門檻 → 自動開工單
      ticket = { status: "open" };
      onsetIdx = history.length - 1;
      onsetH = pt.t;
    }
    const next: Sim = { ...s, p, history, ticket, onsetIdx, onsetH, tHours: s.tHours + DT_H };
    if (p >= 1) {
      return { ...next, playing: false, phase: "analyze",
               ticket: ticket ?? { status: "open" },
               onsetIdx: onsetIdx ?? history.length - 1,
               onsetH: onsetH ?? pt.t };
    }
    return next;
  }

  if (s.phase === "resolve") {
    const p = Math.min(1, s.p + 0.09);
    const pt = push("resolve", p);
    const next: Sim = { ...s, p, history: [...s.history, pt], tHours: s.tHours + DT_H };
    if (p >= 1) {
      return { ...next, playing: false, phase: "done",
               ticket: { status: "resolved" }, resolveH: pt.t };
    }
    return next;
  }

  return s;
}

const FRESH: Sim = {
  phase: "intro", playing: false, p: 0, runTicks: 0, history: [], ticket: null,
  onsetIdx: null, tHours: 0, onsetH: null, ackH: null, resolveH: null, diagPick: null, diagOk: false,
};

// ── 階段條 ────────────────────────────────────────────────────
const CHAPTERS: [Phase[], string, string][] = [
  [["claim"], "認領", "①"],
  [["run"], "運轉", "②"],
  [["onset"], "故障", "③"],
  [["analyze"], "分析", "④"],
  [["diagnose"], "診斷", "⑤"],
  [["resolve", "done"], "排除", "⑥"],
];

const DIAG: { key: string; label: string; correct?: boolean; note: string }[] = [
  { key: "bearing_wear", label: "主軸軸承磨損", correct: true,
    note: "正解!振動(vibration_rms)明顯上升、主軸溫度隨後跟著爬,但主軸電流(spindle_current)幾乎沒動 —— 切削負載沒變重,熱與振動來自軸承本身的摩擦劣化。這正是軸承磨損的典型特徵。" },
  { key: "spindle_motor_overload", label: "主軸馬達過載", note:
    "再看一眼電流:馬達過載時 spindle_current 會跟著飆高,但這裡電流全程平穩 —— 負載沒變重,可以排除馬達過載。" },
  { key: "sensor_drift", label: "溫度感測器漂移", note:
    "若只是感測器漂移,健康度不會真的掉、振動也不會同步上升。這裡是多個獨立訊號一致惡化 —— 是真設備退化,不是感測器說謊。" },
  { key: "coolant_overheat", label: "冷卻不足過熱", note:
    "過熱主導時通常溫度先飆、振動才落後。這裡是振動領先、溫度跟隨 —— 根因在機械振動源(軸承),不是冷卻系統。" },
];

type View = "start" | "world" | "student" | "catalog" | "diag" | "oee" | "teacher";

export default function DemoPlayground({ onClose, onNav }: { onClose: () => void; onNav: (v: View) => void }) {
  const [sim, setSim] = useState<Sim>(FRESH);
  const simRef = useRef(sim);
  simRef.current = sim;

  // 動畫主迴圈:只在 playing 且處於動畫階段時推進。
  useEffect(() => {
    const id = setInterval(() => {
      const cur = simRef.current;
      if (cur.playing && (cur.phase === "run" || cur.phase === "onset" || cur.phase === "resolve")) {
        setSim(stepSim(cur));
      }
    }, TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const { phase, history, ticket } = sim;
  const latest = history[history.length - 1];
  const state = deviceState(sim);
  const chapIdx = CHAPTERS.findIndex(([ph]) => ph.includes(phase));

  const claim = () => setSim((s) => ({ ...s, phase: "run", playing: true }));
  const pickDiag = (key: string) => setSim((s) => {
    const ok = !!DIAG.find((d) => d.key === key)?.correct;
    return { ...s, diagPick: key, diagOk: ok, ackH: ok ? s.tHours : s.ackH,
             ticket: ok && s.ticket ? { status: "acked" } : s.ticket };
  });
  const startResolve = () => setSim((s) => ({ ...s, phase: "resolve", p: 0, playing: true }));
  const replay = () => setSim(FRESH);

  return (
    <div onClick={onClose}
         style={{ position: "fixed", inset: 0, zIndex: 1100, background: "rgba(4,8,14,0.72)",
                  display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "4vh 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()}
           style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: 14,
                    width: "min(960px, 100%)", boxShadow: "0 20px 60px rgba(0,0,0,.55)" }}>

        {/* 標題 */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
                      padding: "14px 20px", borderBottom: "1px solid var(--line)" }}>
          <div>
            <div style={{ fontSize: 17, fontWeight: 700 }}>▶ 範例示範 · 一台 CNC 的完整處置迴圈</div>
            <div className="hint" style={{ margin: "2px 0 0" }}>
              認領 → 運轉 → 故障 → 分析 → 診斷根因 → 排除復機 · <span style={{ color: "var(--pred)" }}>全程模擬,不影響真實園區</span>
            </div>
          </div>
          <button className="btn ghost" style={{ padding: "5px 12px" }} onClick={onClose}>✕ 關閉(Esc)</button>
        </div>

        {/* 階段條 */}
        <div style={{ display: "flex", gap: 6, padding: "12px 20px", flexWrap: "wrap" }}>
          {CHAPTERS.map(([, label, num], k) => {
            const active = k === chapIdx, done = k < chapIdx;
            return (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 20,
                              fontSize: 12.5, fontWeight: 600,
                              background: active ? "var(--accent)" : done ? "#13241b" : "var(--panel-3)",
                              color: active ? "#08121e" : done ? "#9be7bd" : "var(--muted)",
                              border: `1px solid ${active ? "var(--accent)" : done ? "#2f7a4f" : "var(--line)"}` }}>
                  <span>{done ? "✓" : num}</span>{label}
                </div>
                {k < CHAPTERS.length - 1 && <span style={{ color: "var(--line-2)" }}>→</span>}
              </div>
            );
          })}
        </div>

        {/* 主體:左敘事 / 右即時 */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 320px", gap: 16, padding: "4px 20px 20px" }}>
          {/* 左:敘事 + 互動 */}
          <div style={{ minWidth: 0 }}>
            {phase === "intro" && (
              <Narr title="🏭 這台是你的示範設備" >
                <p>
                  <b>{DEV}</b> 是一台三軸 CNC 加工中心(template <code>cnc_machining_center</code>),隸屬「{COMPANY}」。
                  它以 <b>Modbus / OPC-UA / MQTT</b> 對外吐出振動、主軸溫度、主軸電流等即時訊號,並帶著一個
                  看不見的<b>隱藏健康狀態</b>。接下來我們認領它、看它運轉,然後它會故障 —— 你要把它救回來。
                </p>
                <PrimaryRow>
                  <button className="btn primary" onClick={() => setSim((s) => ({ ...s, phase: "claim" }))}>開始 →</button>
                </PrimaryRow>
              </Narr>
            )}

            {phase === "claim" && (
              <Narr title="① 認領這間公司">
                <p>
                  維運從<b>認領</b>開始:認領後,這間廠的所有設備、工單、OEE 成績都算你的。
                  真實流程你會在「🚀 開始」分頁選一間未認領的公司;這裡先示範認領這台 {DEV}。
                </p>
                <PrimaryRow>
                  <button className="btn primary" onClick={claim}>認領 {COMPANY} 🎉</button>
                </PrimaryRow>
              </Narr>
            )}

            {phase === "run" && (
              <Narr title="② 設備健康運轉中">
                <p>
                  認領成功!設備正常運轉,燈號<b style={{ color: "#37d07a" }}>綠</b>。
                  觀察右側:振動穩定在 ~2、主軸溫度 ~64°C、健康度 100%。
                  你的監控程式此刻讀到的就是這些值。時鐘正在加速,劣化很快就會浮現 …
                </p>
                <LiveNote text="快轉中 · 等待訊號變化" />
              </Narr>
            )}

            {phase === "onset" && (
              <Narr title="③ 徵兆出現 —— 設備開始退化">
                <p>
                  注意右圖:<b style={{ color: "#e0503f" }}>振動 vibration_rms 一路往上爬</b>,
                  主軸溫度也開始跟著升。這不是雜訊,是隱藏健康狀態真的在掉。
                  {ticket ? <> 振動一越過門檻 <b>{VIB_THRESH}</b>,系統就<b style={{ color: "#e0503f" }}>自動開了工單</b> —— 故障確立。</>
                          : <> 盯住振動,快要碰到告警門檻 <b>{VIB_THRESH}</b> 了。</>}
                </p>
                <LiveNote text="退化進行中 · 工單將自動生成" />
              </Narr>
            )}

            {phase === "analyze" && (
              <Narr title="④ 分析 —— 訊號告訴我們什麼">
                <p>設備已故障。別急著重開機 —— 先看訊號,判斷<b>根因</b>。這是預測性維護的核心:</p>
                <ul style={{ margin: "6px 0 10px", paddingLeft: 18, lineHeight: 1.7 }}>
                  <li><b style={{ color: "#e0503f" }}>振動</b>大幅上升(2 → ~7.5),而且<b>領先</b>其它訊號。</li>
                  <li><b style={{ color: "#f2c14e" }}>主軸溫度</b>隨後跟著升(64 → ~90°C)—— 摩擦生熱。</li>
                  <li><b style={{ color: "#5b9bd5" }}>主軸電流</b>幾乎沒變 —— 切削負載沒變重,問題不在馬達出力。</li>
                  <li>三個獨立訊號<b>一致惡化</b> → 不是單一感測器在說謊,是真的機械劣化。</li>
                </ul>
                <PrimaryRow>
                  <button className="btn primary" onClick={() => setSim((s) => ({ ...s, phase: "diagnose" }))}>
                    我看懂趨勢了 → 下判斷
                  </button>
                </PrimaryRow>
              </Narr>
            )}

            {phase === "diagnose" && (
              <Narr title="⑤ 診斷 —— 根因是什麼?">
                <p>根據上面的訊號證據,這台 {DEV} 最可能的故障根因是?</p>
                <div style={{ display: "grid", gap: 8, margin: "8px 0" }}>
                  {DIAG.map((d) => {
                    const picked = sim.diagPick === d.key;
                    const showRight = picked && d.correct;
                    const showWrong = picked && !d.correct;
                    return (
                      <button key={d.key} onClick={() => pickDiag(d.key)} disabled={sim.diagOk}
                        style={{ textAlign: "left", cursor: sim.diagOk ? "default" : "pointer", padding: "10px 12px", borderRadius: 8,
                                 background: showRight ? "#13241b" : showWrong ? "#2a1518" : "var(--panel-3)",
                                 color: "var(--text)",
                                 border: `1px solid ${showRight ? "#2f7a4f" : showWrong ? "#6b2f34" : "var(--line)"}` }}>
                        <div style={{ fontWeight: 600 }}>
                          {showRight ? "✅ " : showWrong ? "✗ " : ""}{d.label}
                        </div>
                        {picked && <div className="hint" style={{ margin: "4px 0 0", color: d.correct ? "#9be7bd" : "#ffb4b4" }}>{d.note}</div>}
                      </button>
                    );
                  })}
                </div>
                {sim.diagOk && (
                  <PrimaryRow>
                    <button className="btn primary" onClick={startResolve}>ack 工單 → 排除故障 ↺</button>
                  </PrimaryRow>
                )}
              </Narr>
            )}

            {phase === "resolve" && (
              <Narr title="⑥ 排除 —— 更換軸承、清除故障">
                <p>
                  已確認根因並派工。維修動作(換軸承 / reset)後,看右圖:
                  <b style={{ color: "#e0503f" }}>振動回落</b>、溫度下降、
                  <b style={{ color: "#37d07a" }}>健康度回升</b>,工單即將 resolve、設備翻回綠燈。
                </p>
                <LiveNote text="復機中 · 訊號回到正常區間" />
              </Narr>
            )}

            {phase === "done" && (
              <Narr title="🏅 完成!你跑通了完整處置迴圈">
                <p>你剛剛親手走過真實維運的一整圈:</p>
                <ul style={{ margin: "6px 0 12px", paddingLeft: 18, lineHeight: 1.7 }}>
                  <li>認領設備 → 監控即時訊號</li>
                  <li>振動越門檻 → <b>偵測</b>到異常、系統自動<b>開單</b></li>
                  <li>看多訊號趨勢 → <b>診斷</b>出根因是軸承磨損</li>
                  <li>派工修復 → <b>resolve</b> 工單、設備復機</li>
                </ul>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", margin: "0 0 12px" }}>
                  <Metric label="偵測延遲" value={fmtH((sim.ackH ?? 0) - (sim.onsetH ?? 0))} hint="故障→你判斷" />
                  <Metric label="MTTR 修復時間" value={fmtH((sim.resolveH ?? 0) - (sim.onsetH ?? 0))} hint="故障→resolve" />
                </div>
                <p className="hint" style={{ margin: "0 0 10px" }}>
                  真實課堂裡:偵測越快、修復越短、預測越早,你的 OEE 與競賽排名就越前面。
                  換你上場了 —— 到「🚀 開始」認領一間真的公司,連線包已經幫你準備好。
                </p>
                <PrimaryRow>
                  <button className="btn primary" onClick={() => { onClose(); onNav("start"); }}>去認領真的公司 →</button>
                  <button className="btn ghost" onClick={replay}>↻ 重播</button>
                </PrimaryRow>
              </Narr>
            )}
          </div>

          {/* 右:即時設備 + 工單 + 圖 */}
          <div style={{ minWidth: 0 }}>
            <div style={{ border: `1px solid ${state === "fault" ? "#6b2f34" : "var(--line)"}`, borderRadius: 10,
                          padding: "10px 12px", background: state === "fault" ? "#1e1416" : "var(--panel-3)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <b className="mono">{DEV}</b>
                <span className="badge" style={{ background: STATE_COLOR[state] }}>{state}</span>
              </div>
              <div style={{ marginTop: 8, display: "grid", gap: 4 }}>
                <Reading name="vibration_rms" v={latest?.vib} unit="mm/s" color="#e0503f" hot={(latest?.vib ?? 0) > VIB_THRESH} />
                <Reading name="spindle_temp" v={latest?.temp} unit="°C" color="#f2c14e" />
                <Reading name="spindle_current" v={latest?.cur} unit="A" color="#5b9bd5" />
                <Reading name="health" v={latest?.health} unit="" color="#37d07a" pct />
              </div>
            </div>

            {/* 工單 */}
            {ticket && (
              <div style={{ marginTop: 10, border: "1px solid var(--line)", borderRadius: 10, padding: "10px 12px", background: "var(--panel-3)" }}>
                <div className="sec-label" style={{ marginTop: 0 }}>工單 · TICKET</div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span className="mono" style={{ fontSize: 12 }}>{DEV} · bearing</span>
                  <span className="badge" style={{ background: ticket.status === "resolved" ? "#37d07a" : ticket.status === "acked" ? "#f2c14e" : "#e0503f" }}>
                    {ticket.status}
                  </span>
                </div>
                <div className="hint" style={{ margin: "6px 0 0", fontSize: 11.5 }}>
                  {ticket.status === "open" && "故障已確立,等待 ack 確認。"}
                  {ticket.status === "acked" && "已確認根因,派工修復中。"}
                  {ticket.status === "resolved" && "已修復,設備復機。"}
                </div>
              </div>
            )}

            {/* 訊號圖 */}
            <div style={{ marginTop: 10 }}>
              <div className="sec-label" style={{ marginTop: 0 }}>訊號趨勢</div>
              <DemoChart history={history} onsetIdx={sim.onsetIdx} />
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 6, fontSize: 11 }}>
                <Legend c="#e0503f" t="振動" />
                <Legend c="#f2c14e" t="溫度" />
                <Legend c="#5b9bd5" t="電流" />
                <Legend c="#37d07a" t="健康度" />
                <span style={{ color: "var(--dim)" }}>┈ 振動門檻 {VIB_THRESH}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── 訊號圖(inline SVG,四條線 + 門檻 + 故障點)────────────────
function DemoChart({ history, onsetIdx }: { history: Pt[]; onsetIdx: number | null }) {
  const W = 300, H = 150, PAD = 4;
  const n = Math.max(history.length, 2);
  const x = (i: number) => PAD + (i / (n - 1)) * (W - PAD * 2);
  const y = (norm: number) => H - PAD - norm * (H - PAD * 2);
  // 各訊號正規化到顯示區間
  const nVib = (v: number) => Math.min(1, v / 9);
  const nTemp = (v: number) => Math.min(1, Math.max(0, (v - 55) / 45));
  const nCur = (v: number) => Math.min(1, v / 15);
  const nHealth = (v: number) => Math.min(1, Math.max(0, v));
  const path = (f: (p: Pt) => number) =>
    history.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(f(p)).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: 150, background: "#0b1017", border: "1px solid var(--line)", borderRadius: 8 }}>
      {/* 振動門檻參考線 */}
      <line x1={PAD} x2={W - PAD} y1={y(nVib(6))} y2={y(nVib(6))} stroke="#6d7686" strokeDasharray="3 3" strokeWidth="1" />
      {/* 故障點標記 */}
      {onsetIdx != null && history[onsetIdx] && (
        <line x1={x(onsetIdx)} x2={x(onsetIdx)} y1={PAD} y2={H - PAD} stroke="#e0503f" strokeDasharray="2 3" strokeWidth="1" opacity="0.6" />
      )}
      {history.length >= 2 && (
        <>
          <path d={path((p) => nHealth(p.health))} fill="none" stroke="#37d07a" strokeWidth="1.6" />
          <path d={path((p) => nCur(p.cur))} fill="none" stroke="#5b9bd5" strokeWidth="1.6" />
          <path d={path((p) => nTemp(p.temp))} fill="none" stroke="#f2c14e" strokeWidth="1.6" />
          <path d={path((p) => nVib(p.vib))} fill="none" stroke="#e0503f" strokeWidth="2" />
        </>
      )}
      {history.length < 2 && (
        <text x={W / 2} y={H / 2} fill="#5c6675" fontSize="11" textAnchor="middle">等待數據…</text>
      )}
    </svg>
  );
}

// ── 小組件 ────────────────────────────────────────────────────
function deviceState(s: Sim): string {
  const l = s.history[s.history.length - 1];
  if (s.phase === "intro" || s.phase === "claim") return "idle";
  if (s.phase === "run") return "running";
  if (s.phase === "onset") return !l ? "running" : l.health < 0.12 ? "fault" : l.vib > VIB_THRESH ? "alarm" : "running";
  if (s.phase === "analyze" || s.phase === "diagnose") return "fault";
  if (s.phase === "resolve") return s.p > 0.7 ? "running" : "fault";
  return "running";
}

const STATE_COLOR: Record<string, string> = {
  running: "#37d07a", idle: "#8a93a6", alarm: "#f2c14e", fault: "#e0503f",
};

function Narr({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, lineHeight: 1.7, color: "var(--text-2)" }}>{children}</div>
    </div>
  );
}

function PrimaryRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>{children}</div>;
}

function LiveNote({ text }: { text: string }) {
  return (
    <div style={{ marginTop: 12, display: "inline-flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)" }}>
      <span style={{ width: 8, height: 8, borderRadius: 8, background: "var(--accent)", display: "inline-block",
                     animation: "dotPulse 1.2s ease-in-out infinite" }} />
      {text}
    </div>
  );
}

function Reading({ name, v, unit, color, hot, pct }: { name: string; v?: number; unit: string; color: string; hot?: boolean; pct?: boolean }) {
  const shown = v == null ? "—" : pct ? `${(v * 100).toFixed(0)}%` : v.toFixed(2);
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12.5 }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--muted)" }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: color, display: "inline-block" }} />{name}
      </span>
      <span className="mono" style={{ fontWeight: 700, color: hot ? "#e0503f" : "var(--text)" }}>{shown} {unit}</span>
    </div>
  );
}

function Legend({ c, t }: { c: string; t: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--muted)" }}>
      <span style={{ width: 10, height: 3, borderRadius: 2, background: c, display: "inline-block" }} />{t}
    </span>
  );
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div style={{ background: "var(--panel-3)", border: "1px solid var(--line)", borderRadius: 8, padding: "8px 14px" }}>
      <div className="hint" style={{ margin: 0, fontSize: 11 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 16 }} className="mono">{value}</div>
      <div className="hint" style={{ margin: 0, fontSize: 10.5 }}>{hint}</div>
    </div>
  );
}

const fmtH = (h: number) => `${Math.max(0, h).toFixed(1)} h`;
