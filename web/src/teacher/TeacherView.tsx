import { useEffect, useState } from "react";
import {
  Park, TelemetryMsg, HealthGT, Ticket, ScoreRow, PredScoreRow, ScenarioScript, ScenarioStatus,
  setTeacherToken, getTeacherToken, setClock,
  injectFault, resetDevice, getHealth, getTickets, ackTicket, resolveTicket, getScores, getPredictionScores,
  getScenarios, runScenario, stopScenario, createFactory, resetSession,
} from "../api";

const FAULT_TYPES = [
  "gradual", "sudden", "intermittent", "cascading",
  "sensor_drift", "sensor_stuck", "sensor_bias", "sensor_noise", "sensor_dropout",
];

export default function TeacherView({
  park, telemetry, onParkChanged,
}: { park: Park; telemetry: TelemetryMsg | null; onParkChanged: () => void }) {
  const [token, setTok] = useState(getTeacherToken());
  const [dev, setDev] = useState<string>("");
  const [ftype, setFtype] = useState("gradual");
  const [target, setTarget] = useState("");
  const [severity, setSeverity] = useState(1.0);
  const [msg, setMsg] = useState("");
  const [clockMult, setClockMult] = useState<number | null>(null);

  const [health, setHealth] = useState<HealthGT | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [predScores, setPredScores] = useState<PredScoreRow[]>([]);
  const [scripts, setScripts] = useState<ScenarioScript[]>([]);
  const [scenStatus, setScenStatus] = useState<ScenarioStatus | null>(null);
  const [scenName, setScenName] = useState("disaster_day");
  const [factoryDesc, setFactoryDesc] = useState("建一間有 3 台機械手臂的公司");

  const deviceIds = telemetry ? Object.keys(telemetry.devices) : [];
  const isSensor = ftype.startsWith("sensor_");
  // 目標選項:感測器故障 → tag;設備故障 → 退化元件(從 ground-truth)
  const targetOpts = isSensor
    ? (telemetry && dev ? Object.keys(telemetry.devices[dev]?.tags ?? {}) : [])
    : (health?.components.map((c) => c.name) ?? []);

  useEffect(() => { if (!dev && deviceIds.length) setDev(deviceIds[0]); }, [deviceIds, dev]);

  // 輪詢 ground-truth / 工單 / 評分
  useEffect(() => {
    const tick = async () => {
      try { if (dev) setHealth(await getHealth(dev)); } catch { /* token 未設會 401 */ }
      try { setTickets((await getTickets()).tickets); } catch { /* */ }
      try { setScores((await getScores()).ranking); } catch { /* */ }
      try { setPredScores((await getPredictionScores()).ranking); } catch { /* */ }
      try { const s = await getScenarios(); setScripts(s.scripts); setScenStatus(s.status); } catch { /* */ }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [dev]);

  const saveToken = () => { setTeacherToken(token); setMsg("已儲存 teacher token"); };

  const doInject = async () => {
    try {
      await injectFault({ device: dev, fault_type: ftype, target, severity });
      setMsg(`已注入 ${ftype} → ${dev}.${target}（severity ${severity}）`);
    } catch (e: any) {
      const hint = String(e.message).includes("401")
        ? "token 不符,請填 .env 的 TEACHER_TOKEN(預設 dev-teacher-token)並按儲存"
        : "檢查 target 是否選對";
      setMsg(`注入失敗:${e.message} — ${hint}`);
    }
  };
  const doReset = async () => {
    try { await resetDevice(dev); setMsg(`已 reset ${dev}`); }
    catch (e: any) { setMsg(`reset 失敗:${e.message}`); }
  };
  // 課堂 demo:對此設備第一個(本體)退化元件注入快速劣化,高時間倍率下幾分鐘內故障 → 學生立刻有工單可練。
  const doQuickFault = async () => {
    const comp = health?.components?.[0]?.name;
    if (!dev || !comp) { setMsg("請先選設備,並等 ground-truth 載入(需 teacher token)"); return; }
    try {
      await injectFault({ device: dev, fault_type: "gradual", target: comp, severity: 1.0 });
      setMsg(`⚡ 已對 ${dev}.${comp} 注入快速劣化 — 把時鐘調 600×/3600× 加速,幾分鐘內會故障並自動開單`);
    } catch (e: any) {
      const hint = String(e.message).includes("401") ? "先填 dev-teacher-token 並儲存" : "";
      setMsg(`快速故障失敗:${e.message} ${hint}`);
    }
  };
  const doResetSession = async () => {
    if (!window.confirm("重置課堂資料?\n將清空所有公司認領、工單、階段二預測、OEE 累積,並把所有設備修回健康。\n(不刪 DB 檔;適合換班 / 下堂課歸零)")) return;
    try {
      const r = await resetSession();
      const c = r.cleared || {};
      setMsg(`🧹 已重置課堂資料:認領 ${c.claims ?? 0} · 工單 ${c.tickets ?? 0} · 預測 ${c.predictions ?? 0} · OEE ${c.oee_reset ?? 0} 台 · 設備修復 ${c.devices_reset ?? 0} 台`);
    } catch (e: any) {
      const hint = String(e.message).includes("401") ? "先填 dev-teacher-token / .env 的 TEACHER_TOKEN 並儲存" : "";
      setMsg(`重置失敗:${e.message} ${hint}`);
    }
  };
  const doFactory = async () => {
    try {
      const r = await createFactory(factoryDesc);
      const via = r?.via === "llm" ? "🤖 AI 解析" : "規則式";
      setMsg(`已建廠(${via}):${r?.summary ?? r?.name ?? "新公司"}（2D 世界 + Modbus/OPC-UA/MQTT 皆即時上線,免重啟)`);
      onParkChanged();   // 重抓 park → 2D 世界 / 目錄 / OEE 顯示新公司
    } catch (e: any) {
      const hint = String(e.message).includes("401") ? "先填 dev-teacher-token 並儲存"
        : String(e.message).includes("422") ? "描述需含設備類型(CNC/空壓機/AGV/機械手臂)與數量" : "";
      setMsg(`建廠失敗:${e.message} ${hint}`);
    }
  };

  const clk = (m: number) => { setClock({ multiplier: m }); setClockMult(m); };

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>教師控制台 · 上帝視角</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input className="inp" value={token} onChange={(e) => setTok(e.target.value)} placeholder="dev-teacher-token" style={{ width: 150 }} />
          <button className="btn ghost" onClick={saveToken}>儲存</button>
          {getTeacherToken() && <span className="pill" style={{ color: "var(--warn)", borderColor: "#5a4a1e", background: "#241d0c" }}>🔑 已載入</span>}
          <span className="muted" style={{ fontSize: 11 }}>倍率</span>
          {[60, 600, 3600].map((m) => (
            <button key={m} className={`btn ghost${clockMult === m ? " speed-active" : ""}`} onClick={() => clk(m)}
              style={clockMult === m ? { background: "#14304d", borderColor: "var(--accent)", color: "var(--accent)" } : {}}>{m}×</button>
          ))}
          <button className="btn ghost" onClick={() => setClock({ paused: true })}>⏸</button>
          <button className="btn ghost" onClick={() => setClock({ paused: false })}>▶</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
        {/* 左:actions */}
        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 14 }}>
          <div className="card">
            <div className="card-title">🏭 建廠(自然語言)</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input className="inp" value={factoryDesc} onChange={(e) => setFactoryDesc(e.target.value)}
                     placeholder="例:半導體封裝廠,3 台手臂 + 2 台製程腔體 + 1 台電表" style={{ flex: 1, minWidth: 260 }} />
              <button className="btn" style={{ background: "var(--ok)", color: "#08121e" }} onClick={doFactory}>＋ 建立公司</button>
            </div>
            <div className="hint" style={{ margin: "6px 0 0" }}>
              設了 Gemini key → 🤖 AI 解析自由描述、可<b>多型別混搭</b>;否則規則式(單一型別 + 數量)。建立後即時長出新公司(三協定免重啟)。
            </div>
          </div>

          <div className="card">
            <div className="card-title">⚠ 注入故障</div>
            <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
              <Field label="設備"><select className="inp" value={dev} onChange={(e) => setDev(e.target.value)}>{deviceIds.map((d) => <option key={d}>{d}</option>)}</select></Field>
              <Field label="故障型態"><select className="inp" value={ftype} onChange={(e) => { setFtype(e.target.value); setTarget(""); }}>{FAULT_TYPES.map((f) => <option key={f}>{f}</option>)}</select></Field>
              <Field label={isSensor ? "目標 tag" : "目標元件"}><select className="inp" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">— 選擇 —</option>{targetOpts.map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="severity"><input className="inp" type="number" min={0} max={1} step={0.1} value={severity} onChange={(e) => setSeverity(parseFloat(e.target.value))} style={{ width: 68 }} /></Field>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button className="btn" style={{ background: "var(--fault)", color: "#fff" }} disabled={!dev || !target} onClick={doInject}>注入</button>
              <button className="btn" style={{ background: "var(--pred)", color: "#08121e" }} disabled={!dev || !health?.components?.length}
                      onClick={doQuickFault} title="對此設備主元件注入快速劣化,課堂 demo 用">⚡ 快速故障(demo)</button>
              <button className="btn ghost" onClick={doReset}>reset 設備</button>
            </div>
            <div className="hint" style={{ margin: "6px 0 0" }}>選運轉中機台 → ⚡ 快速故障 → 時鐘 600×↑ → 幾分鐘內故障自動開單,學生即可練。</div>
            {msg && <div style={{ marginTop: 8, color: "var(--accent)", fontSize: 12 }}>{msg}</div>}
          </div>

          <div className="card">
            <div className="card-title">🎬 情境腳本(期末測驗)</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select className="inp" value={scenName} onChange={(e) => setScenName(e.target.value)}>{scripts.map((s) => <option key={s.name} value={s.name}>{s.name}({s.steps} 步)</option>)}</select>
              <button className="btn" style={{ background: "var(--pred)", color: "#08121e" }} disabled={!!scenStatus?.running}
                      onClick={async () => { try { await runScenario(scenName); setMsg(`已啟動情境 ${scenName}`); } catch (e: any) { setMsg(`啟動失敗:${e.message}`); } }}>▶ 執行</button>
              <button className="btn ghost" onClick={async () => { await stopScenario(); setMsg("已停止情境"); }}>停止</button>
              {scenStatus?.running && <span style={{ color: "var(--pred)", fontSize: 12 }}>● 執行中:{scenStatus.running}</span>}
            </div>
            {scripts.find((s) => s.name === scenName) && <div className="hint" style={{ margin: "6px 0 0" }}>{scripts.find((s) => s.name === scenName)!.description}</div>}
            {scenStatus && scenStatus.log.length > 0 && (
              <div className="mono" style={{ marginTop: 6, fontSize: 11, color: "var(--muted)" }}>
                {scenStatus.log.slice(0, 6).map((l, i) => <div key={i}>{(l.sim_t / 3600).toFixed(1)}h · {l.message}</div>)}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">🔬 Ground-truth · <span className="mono" style={{ fontWeight: 400 }}>{dev}</span></div>
            {health ? (
              <>
                <div className="hint" style={{ margin: "0 0 6px" }}>
                  state=<b>{health.state}</b> · RUL={health.rul_sim_s === null ? "—" : (health.rul_sim_s / 3600).toFixed(1)}h
                  {health.is_sensor_fault && <span style={{ color: "var(--warn)" }}> · 含感測器故障 {Object.keys(health.sensor_faults).join(",")}</span>}
                </div>
                {health.components.map((c) => (
                  <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 10, margin: "5px 0" }}>
                    <span style={{ width: 150, fontSize: 12 }}>{c.name}</span>
                    <div style={{ flex: 1, maxWidth: 300, background: "var(--line-3)", borderRadius: 4, height: 8, overflow: "hidden" }}>
                      <div style={{ width: `${c.health * 100}%`, height: "100%", borderRadius: 4, transition: "width .3s ease",
                        background: c.health > 0.5 ? "var(--ok)" : c.health > 0.2 ? "var(--warn)" : "var(--fault)" }} />
                    </div>
                    <span className="mono" style={{ width: 70, textAlign: "right", fontSize: 12 }}>h={c.health.toFixed(2)}</span>
                  </div>
                ))}
              </>
            ) : <div className="hint" style={{ margin: 0 }}>(設好 token 後顯示隱藏健康狀態)</div>}
          </div>
        </div>

        {/* 右:工單 / 評分 / 重置 */}
        <div style={{ width: 452, flex: "0 0 452px", display: "grid", gap: 14 }}>
          <div className="card" style={{ padding: "12px 14px" }}>
            <div className="card-title">🎫 工單板</div>
            <MiniTable head={["單號", "設備", "元件", "狀態", "MTTR", "處置"]}
              rows={tickets.slice(0, 12).map((t) => [
                t.id, t.device, t.component ?? "—",
                <span key="s" className="badge" style={{ background: t.status === "resolved" ? "var(--ok)" : t.status === "acked" ? "var(--warn)" : "var(--fault)", fontSize: 10 }}>{t.status}</span>,
                t.mttr_sim_s !== null ? (t.mttr_sim_s / 3600).toFixed(1) + "h" : "—",
                <span key="a" style={{ display: "flex", gap: 4 }}>
                  <button className="btn ghost" style={{ padding: "2px 7px", fontSize: 11 }} onClick={() => ackTicket(t.id)}>ack</button>
                  <button className="btn" style={{ padding: "2px 7px", fontSize: 11, background: "var(--ok)", color: "#08121e" }} onClick={() => resolveTicket(t.id)}>fix</button>
                </span>,
              ])} empty="尚無工單" />
          </div>

          <div className="card" style={{ padding: "12px 14px" }}>
            <div className="card-title">📊 故障管理評分榜</div>
            <MiniTable head={["#", "公司", "偵測", "解決", "漏", "分"]}
              rows={scores.map((s, i) => [String(i + 1), s.name, s.detected, s.resolved, s.missed, <b key="b">{s.score}</b>])} empty="尚無資料" />
          </div>

          <div className="card" style={{ padding: "12px 14px" }}>
            <div className="card-title">🔮 階段二預測榜(lead time)</div>
            <MiniTable head={["#", "學生", "命中", "誤報", "提前h", "分"]}
              rows={predScores.map((s, i) => [String(i + 1), s.student,
                <span key="h" style={{ color: "var(--ok)" }}>{s.hits}</span>,
                <span key="f" style={{ color: "var(--fault)" }}>{s.false_alarms}</span>,
                s.avg_lead_time_h ?? "—", <b key="b">{s.score}</b>])} empty="尚無預測(student_kit p3 上傳)" />
          </div>

          <div className="card" style={{ borderColor: "#4a2620", background: "#160f10" }}>
            <div className="card-title" style={{ color: "var(--fault)" }}>🧹 重置課堂資料</div>
            <div className="hint" style={{ margin: "0 0 8px" }}>換班 / 下堂課歸零:清認領 / 工單 / 預測 / OEE,設備修回健康(不刪 DB)。</div>
            <button className="btn" style={{ background: "var(--fault)", color: "#fff" }} onClick={doResetSession}>🧹 重置課堂資料</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return <div><div className="muted" style={{ fontSize: 10.5, marginBottom: 3 }}>{label}</div>{children}</div>;
}

function MiniTable({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr>{head.map((h, i) => (
        <th key={h} className="mono" style={{ textAlign: i === 0 ? "left" : "left", padding: "5px 6px", color: "var(--dim)", fontSize: 10, letterSpacing: ".4px", borderBottom: "1px solid var(--line)", fontWeight: 500 }}>{h}</th>
      ))}</tr></thead>
      <tbody>
        {rows.length === 0 ? <tr><td colSpan={head.length} className="hint" style={{ padding: "8px 6px" }}>{empty}</td></tr> :
          rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => (
              <td key={j} className={j === 0 || (typeof c === "string" && /^[\w.-]+$/.test(c)) ? "mono" : ""}
                  style={{ padding: "5px 6px", fontSize: 11.5, borderBottom: "1px solid var(--line-3)", color: "var(--text-2)" }}>{c}</td>
            ))}</tr>
          ))}
      </tbody>
    </table>
  );
}
