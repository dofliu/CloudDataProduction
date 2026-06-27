import { useEffect, useState } from "react";
import {
  Park, TelemetryMsg, HealthGT, Ticket, ScoreRow, PredScoreRow, ScenarioScript, ScenarioStatus,
  setTeacherToken, getTeacherToken, setClock,
  injectFault, resetDevice, getHealth, getTickets, ackTicket, resolveTicket, getScores, getPredictionScores,
  getScenarios, runScenario, stopScenario, createFactory,
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
  const doFactory = async () => {
    try {
      const r = await createFactory(factoryDesc);
      setMsg(`已建廠:${r?._summary ?? r?.name ?? "新公司"}（2D 世界已更新;原生協定埠需重啟 server)`);
      onParkChanged();   // 重抓 park → 2D 世界 / 目錄 / OEE 顯示新公司
    } catch (e: any) {
      const hint = String(e.message).includes("401") ? "先填 dev-teacher-token 並儲存"
        : String(e.message).includes("422") ? "描述需含設備類型(CNC/空壓機/AGV/機械手臂)與數量" : "";
      setMsg(`建廠失敗:${e.message} ${hint}`);
    }
  };

  return (
    <div className="catalog">
      <h2>教師控制台 · 上帝視角</h2>

      {/* token + 時鐘 */}
      <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginBottom: 16 }}>
        <div>
          <div className="hint">teacher token（= .env 的 TEACHER_TOKEN,預設 dev-teacher-token）</div>
          <input value={token} onChange={(e) => setTok(e.target.value)} placeholder="dev-teacher-token"
                 style={inp} />
          <button onClick={saveToken} style={btn}>儲存</button>
        </div>
        <div>
          <div className="hint">模擬時鐘</div>
          <button style={btn} onClick={() => setClock({ multiplier: 60 })}>60×</button>
          <button style={btn} onClick={() => setClock({ multiplier: 600 })}>600×</button>
          <button style={btn} onClick={() => setClock({ multiplier: 3600 })}>3600×</button>
          <button style={btn} onClick={() => setClock({ paused: true })}>⏸</button>
          <button style={btn} onClick={() => setClock({ paused: false })}>▶</button>
        </div>
      </div>

      {/* 建廠(自然語言) */}
      <h3>建廠（自然語言)</h3>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input value={factoryDesc} onChange={(e) => setFactoryDesc(e.target.value)}
               placeholder="例:建一間有 3 台機械手臂的公司" style={{ ...inp, width: 360 }} />
        <button style={{ ...btn, background: "#37d67a", color: "#08121e" }} onClick={doFactory}>＋ 建立公司</button>
      </div>
      <div className="hint" style={{ marginTop: 4 }}>支援:CNC / 空壓機 / AGV / 機械手臂 + 數量(如「5 台 CNC」)。建立後即時長出新公司。</div>

      {/* 故障注入 */}
      <h3 style={{ marginTop: 22 }}>注入故障</h3>
      <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
        <Field label="設備">
          <select value={dev} onChange={(e) => setDev(e.target.value)} style={inp}>
            {deviceIds.map((d) => <option key={d}>{d}</option>)}
          </select>
        </Field>
        <Field label="故障型態">
          <select value={ftype} onChange={(e) => { setFtype(e.target.value); setTarget(""); }} style={inp}>
            {FAULT_TYPES.map((f) => <option key={f}>{f}</option>)}
          </select>
        </Field>
        <Field label={isSensor ? "目標 tag" : "目標元件"}>
          <select value={target} onChange={(e) => setTarget(e.target.value)} style={inp}>
            <option value="">— 選擇 —</option>
            {targetOpts.map((t) => <option key={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="severity">
          <input type="number" min={0} max={1} step={0.1} value={severity}
                 onChange={(e) => setSeverity(parseFloat(e.target.value))} style={{ ...inp, width: 70 }} />
        </Field>
        <button style={{ ...btn, background: "#e24c4c", color: "#fff" }} disabled={!dev || !target} onClick={doInject}>注入</button>
        <button style={btn} onClick={doReset}>reset 設備</button>
      </div>
      {msg && <div className="hint" style={{ marginTop: 8, color: "#5b9bd5" }}>{msg}</div>}

      {/* 情境腳本(災難日) */}
      <h3 style={{ marginTop: 22 }}>情境腳本（期末測驗）</h3>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <select value={scenName} onChange={(e) => setScenName(e.target.value)} style={inp}>
          {scripts.map((s) => <option key={s.name} value={s.name}>{s.name}（{s.steps} 步）</option>)}
        </select>
        <button style={{ ...btn, background: "#f08c2e", color: "#08121e" }}
                disabled={!!scenStatus?.running}
                onClick={async () => { try { await runScenario(scenName); setMsg(`已啟動情境 ${scenName}`); } catch (e: any) { setMsg(`啟動失敗:${e.message}`); } }}>
          ▶ 執行
        </button>
        <button style={btn} onClick={async () => { await stopScenario(); setMsg("已停止情境"); }}>停止</button>
        {scenStatus?.running && <span style={{ color: "#f08c2e" }}>● 執行中:{scenStatus.running}</span>}
      </div>
      {scripts.find((s) => s.name === scenName) &&
        <div className="hint" style={{ marginTop: 4 }}>{scripts.find((s) => s.name === scenName)!.description}</div>}
      {scenStatus && scenStatus.log.length > 0 && (
        <div className="hint" style={{ marginTop: 6 }}>
          {scenStatus.log.slice(0, 6).map((l, i) => (
            <div key={i}>{(l.sim_t / 3600).toFixed(1)}h · {l.message}</div>
          ))}
        </div>
      )}

      {/* ground-truth */}
      <h3 style={{ marginTop: 22 }}>Ground-truth · {dev}</h3>
      {health ? (
        <div>
          <div className="hint">
            state=<b>{health.state}</b> · RUL={health.rul_sim_s === null ? "—" : (health.rul_sim_s / 3600).toFixed(1)}h
            {health.is_sensor_fault && <span style={{ color: "#f2c037" }}> · 含感測器故障 {Object.keys(health.sensor_faults).join(",")}</span>}
          </div>
          {health.components.map((c) => (
            <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 10, margin: "4px 0" }}>
              <span style={{ width: 160 }}>{c.name}</span>
              <div style={{ flex: 1, maxWidth: 320, background: "#222c3c", borderRadius: 4, height: 12 }}>
                <div style={{ width: `${c.health * 100}%`, height: "100%", borderRadius: 4,
                  background: c.health > 0.5 ? "#37d67a" : c.health > 0.2 ? "#f2c037" : "#e24c4c" }} />
              </div>
              <span style={{ width: 90, textAlign: "right" }}>h={c.health.toFixed(2)}</span>
              <span className="hint" style={{ width: 120 }}>
                RUL {c.rul_sim_s === null ? "—（待機）" : (c.rul_sim_s / 3600).toFixed(1) + "h"}
              </span>
            </div>
          ))}
        </div>
      ) : <div className="hint">（設好 token 後顯示隱藏健康狀態）</div>}

      {/* 工單板 */}
      <h3 style={{ marginTop: 22 }}>工單板</h3>
      <table>
        <thead><tr><th>單號</th><th>設備</th><th>元件</th><th>狀態</th><th>偵測延遲</th><th>MTTR</th><th>處置</th></tr></thead>
        <tbody>
          {tickets.length === 0 && <tr><td colSpan={7} className="hint">尚無工單</td></tr>}
          {tickets.map((t) => (
            <tr key={t.id}>
              <td>{t.id}</td><td>{t.device}</td><td>{t.component}</td>
              <td><span className="badge" style={{ background: t.status === "resolved" ? "#37d67a" : t.status === "acked" ? "#f2c037" : "#e24c4c" }}>{t.status}</span></td>
              <td>{t.detection_latency_sim_s !== null ? (t.detection_latency_sim_s / 3600).toFixed(2) + "h" : "—"}</td>
              <td>{t.mttr_sim_s !== null ? (t.mttr_sim_s / 3600).toFixed(2) + "h" : "—"}</td>
              <td>
                <button style={btnS} onClick={() => ackTicket(t.id)}>ack</button>
                <button style={btnS} onClick={() => resolveTicket(t.id)}>resolve</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 評分榜 */}
      <h3 style={{ marginTop: 22 }}>評分榜</h3>
      <table>
        <thead><tr><th>#</th><th>公司</th><th>認領</th><th>故障</th><th>偵測</th><th>解決</th><th>漏報</th><th>平均偵測</th><th>平均MTTR</th><th>分數</th></tr></thead>
        <tbody>
          {scores.map((s, i) => (
            <tr key={s.company}>
              <td>{i + 1}</td><td>{s.name}</td><td>{s.owner ?? "—"}</td>
              <td>{s.faults}</td><td>{s.detected}</td><td>{s.resolved}</td><td>{s.missed}</td>
              <td>{s.avg_detection_h ?? "—"}</td><td>{s.avg_mttr_h ?? "—"}</td>
              <td><b>{s.score}</b></td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 階段二預測榜 */}
      <h3 style={{ marginTop: 22 }}>階段二預測榜（lead time）</h3>
      <table>
        <thead><tr><th>#</th><th>學生</th><th>預測數</th><th>命中</th><th>誤報</th><th>待定</th><th>平均提前(h)</th><th>命中率</th><th>分數</th></tr></thead>
        <tbody>
          {predScores.length === 0 && <tr><td colSpan={9} className="hint">尚無預測（學生用 student_kit/p3_predictor.py 上傳）</td></tr>}
          {predScores.map((s, i) => (
            <tr key={s.student}>
              <td>{i + 1}</td><td>{s.student}</td><td>{s.predictions}</td>
              <td style={{ color: "#37d67a" }}>{s.hits}</td>
              <td style={{ color: "#e24c4c" }}>{s.false_alarms}</td>
              <td>{s.pending}</td>
              <td>{s.avg_lead_time_h ?? "—"}</td><td>{s.hit_rate ?? "—"}</td>
              <td><b>{s.score}</b></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Field({ label, children }: { label: string; children: any }) {
  return <div><div className="hint">{label}</div>{children}</div>;
}
const inp: React.CSSProperties = { background: "#222c3c", color: "#e6ecf5", border: "1px solid #2e3a4d", borderRadius: 6, padding: "5px 8px", marginRight: 6 };
const btn: React.CSSProperties = { background: "#222c3c", color: "#e6ecf5", border: "1px solid #2e3a4d", borderRadius: 6, padding: "5px 12px", marginRight: 6, cursor: "pointer" };
const btnS: React.CSSProperties = { ...btn, padding: "2px 8px", marginRight: 4 };
