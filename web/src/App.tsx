import { useEffect, useRef, useState } from "react";
import {
  Catalog, CatalogSetpoint, DeviceSnapshot, EventMsg, Park, TelemetryMsg,
  getCatalog, getPark, subscribe, STATUS_COLOR_CSS, getTeacherToken, resetDevice, setCoil, setSetpoint,
} from "./api";
import WorldView from "./world/WorldView";
import CatalogView from "./catalog/CatalogView";
import TeacherView from "./teacher/TeacherView";
import DiagnosticsView from "./diagnostics/DiagnosticsView";
import OeeView from "./oee/OeeView";
import StudentView from "./student/StudentView";
import OnboardingView from "./onboarding/OnboardingView";
import GlossaryOverlay from "./help/GlossaryOverlay";

const WARN_STATES = new Set(["alarm", "tool_change", "blocked", "warning"]);
// 關鍵訊號的參考門檻(側欄門檻條上色用;非硬性告警)
const SIGNAL_THRESH: Record<string, number> = {
  vibration_rms: 6, spindle_current: 12, motor_current: 30, vacuum_pump_current: 12, element_current: 170,
  spindle_temp: 90, motor_temp: 85, oil_temp: 75, pump_temp: 80, die_temp: 70, chamber_temp: 60,
  particle_count: 30, burr_rate: 8, temp_uniformity: 30, oxygen_ppm: 150,
};
const TABS: [string, string][] = [
  ["start", "🚀 開始"], ["world", "2D 世界"], ["student", "學生面"],
  ["catalog", "設備目錄"], ["diag", "戰情版"], ["oee", "OEE 榜"], ["teacher", "教師控制台"],
];

export default function App() {
  const [park, setPark] = useState<Park | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryMsg | null>(null);
  const [events, setEvents] = useState<EventMsg[]>([]);
  const [view, setView] = useState<"start" | "world" | "student" | "catalog" | "teacher" | "diag" | "oee">("start");
  const [selected, setSelected] = useState<string | null>(null);
  const [predicted, setPredicted] = useState<Set<string>>(new Set());
  const [resetMsg, setResetMsg] = useState("");
  const [apiError, setApiError] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const telemetryRef = useRef<TelemetryMsg | null>(null);

  useEffect(() => {
    const loadPark = () => getPark().then((p) => { setPark(p); setApiError(false); })
                             .catch(() => setApiError(true));
    loadPark();
    getCatalog().then(setCatalog).catch(() => {});
    const retry = setInterval(() => { if (!telemetryRef.current) loadPark(); }, 3000);
    const unTel = subscribe<TelemetryMsg>("/ws/telemetry", (m) => { telemetryRef.current = m; setTelemetry(m); });
    const unEv = subscribe<EventMsg>("/ws/events", (e) => {
      setEvents((prev) => [e, ...prev].slice(0, 40));
      setPredicted((prev) => {
        const next = new Set(prev);
        if (e.type === "prediction") next.add(e.device);
        else if (e.type === "fault") next.delete(e.device);
        else if (e.type === "state_change" && e.to === "idle") next.delete(e.device);
        return next;
      });
    });
    return () => { clearInterval(retry); unTel(); unEv(); };
  }, []);

  const simHours = telemetry ? (telemetry.sim_t / 3600).toFixed(1) : "—";
  const mult = telemetry?.multiplier;
  const sel = selected && telemetry ? telemetry.devices[selected] : null;
  const selSetpoints: CatalogSetpoint[] = catalog?.devices.find((d) => d.id === selected)?.setpoints ?? [];

  // 全域燈號摘要
  let nOk = 0, nWarn = 0, nFault = 0;
  if (telemetry) for (const d of Object.values(telemetry.devices)) {
    if (d.state === "fault") nFault++;
    else if (WARN_STATES.has(d.state)) nWarn++;
    else nOk++;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="logo">勤</div>
        <h1>{park?.name ?? "勤益智慧工業區"}</h1>
        <span className="synthetic">合成數據 SYNTHETIC</span>
        <nav className="nav" style={{ marginLeft: 8 }}>
          {TABS.map(([k, label]) => (
            <button key={k} className={view === k ? "active" : ""} onClick={() => setView(k as typeof view)}>{label}</button>
          ))}
        </nav>
        <div className="spacer" />
        {telemetry && (
          <div className="lightsum">
            <span className="grp"><span className="dot ok" />{nOk}</span>
            <span className="grp"><span className="dot warn" />{nWarn}</span>
            <span className="grp"><span className="dot fault" />{nFault}</span>
          </div>
        )}
        <span className="clock">sim {simHours} h · {mult ?? "—"}×</span>
        <button className="btn ghost" style={{ padding: "5px 11px" }} onClick={() => setHelpOpen(true)} title="名詞速查(Modbus / OEE / RUL …)">❓ 名詞</button>
      </header>

      {helpOpen && <GlossaryOverlay onClose={() => setHelpOpen(false)} />}

      <div className="main">
        {!park ? (
          <div className="page" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ textAlign: "center", maxWidth: 460, padding: 24 }}>
              <div style={{ fontSize: 40, marginBottom: 10 }}>{apiError ? "🔌" : "⏳"}</div>
              <h2 style={{ margin: "0 0 8px" }}>{apiError ? "連不到園區伺服器" : "連線中…"}</h2>
              <p className="hint" style={{ margin: 0 }}>
                {apiError
                  ? "後端引擎(API 8077)可能還沒啟動。請確認老師已在主機執行 run-engine.ps1;起來後本頁會自動恢復,不必手動整理。"
                  : "正在向園區世界要資料,請稍候。"}
              </p>
            </div>
          </div>
        ) : view === "start" ? (
          <OnboardingView park={park} telemetry={telemetry} catalog={catalog} onNav={setView} />
        ) : view === "world" ? (
          <>
            <div className="stage">
              <WorldView park={park} telemetry={telemetry} selected={selected} onSelect={setSelected} predicted={predicted} />
            </div>
            <aside className="side">
              {sel ? (
                <DevicePanel sel={sel} setpoints={selSetpoints} resetMsg={resetMsg} setResetMsg={setResetMsg} />
              ) : (
                <div className="muted">點公司進廠內 → 點設備看即時值。頂列燈號摘要:綠=正常 · 黃=警告 · 紅=故障。</div>
              )}
              <EventStream events={events} />
            </aside>
          </>
        ) : view === "student" ? (
          <StudentView park={park} telemetry={telemetry} />
        ) : view === "catalog" ? (
          <CatalogView catalog={catalog} telemetry={telemetry} />
        ) : view === "diag" ? (
          <DiagnosticsView host={window.location.hostname} />
        ) : view === "oee" ? (
          <OeeView />
        ) : (
          <TeacherView park={park} telemetry={telemetry}
                       onParkChanged={() => getPark().then(setPark).catch(console.error)} />
        )}
      </div>
    </div>
  );
}

// ── 側欄設備面板(2a)──────────────────────────────────────────
function DevicePanel({ sel, setpoints, resetMsg, setResetMsg }: {
  sel: DeviceSnapshot; setpoints: CatalogSetpoint[]; resetMsg: string; setResetMsg: (m: string) => void;
}) {
  const isTeacher = !!getTeacherToken();
  const keySignals = Object.entries(sel.tags)
    .filter(([k, v]) => k in SIGNAL_THRESH && typeof v === "number")
    .slice(0, 4) as [string, number][];
  const runEnabled = sel.coils?.run_enable !== false;

  return (
    <>
      <h2>
        <span className="mono">{sel.id}</span>
        <span className="badge" style={{ background: STATUS_COLOR_CSS[sel.state] ?? "var(--muted)" }}>{sel.state}</span>
      </h2>
      <div className="muted" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5 }}>{sel.template}</div>

      {isTeacher ? (
        <div style={{ margin: "10px 0 2px", display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button className="btn" style={{ background: runEnabled ? "var(--warn)" : "var(--ok)", color: "#08121e" }}
            onClick={async () => {
              try { await setCoil(sel.id, "run_enable", !runEnabled); setResetMsg(`已寫 run_enable=${!runEnabled}:${sel.id}`); }
              catch (e: any) { setResetMsg(`線圈寫入失敗:${e.message}(檢查教師 token)`); }
            }}>{runEnabled ? "⏸ 停機" : "▶ 復機"}</button>
          <button className="btn" style={{ background: "var(--ok)", color: "#08121e" }}
            onClick={async () => {
              try { await setCoil(sel.id, "reset_fault", true); setResetMsg(`已寫 reset_fault:${sel.id}`); }
              catch { try { await resetDevice(sel.id); setResetMsg(`已重置 / 清除故障:${sel.id}`); }
                      catch (e2: any) { setResetMsg(`重置失敗:${e2.message}`); } }
            }}>↺ 重置 / 清故障</button>
          {resetMsg && <div style={{ width: "100%", marginTop: 2, color: "var(--accent)", fontSize: 11.5 }}>{resetMsg}</div>}
        </div>
      ) : (
        <div className="muted" style={{ fontSize: 11.5, margin: "8px 0" }}>教師控制台輸入 token 後,這裡可寫命令線圈(停機/復機、清故障)。</div>
      )}

      {keySignals.length > 0 && (
        <>
          <div className="sec-label">關鍵訊號</div>
          {keySignals.map(([k, v]) => <KeySignal key={k} name={k} value={v} thresh={SIGNAL_THRESH[k]} />)}
        </>
      )}

      <div className="sec-label">保持暫存器 · HOLDING FC03</div>
      <table className="taglist"><tbody>
        {Object.entries(sel.tags).map(([k, v]) => (
          <tr key={k}><td className="name">{k}</td><td className="val">{typeof v === "number" ? v.toFixed(2) : String(v)}</td></tr>
        ))}
      </tbody></table>

      {sel.discretes && Object.keys(sel.discretes).length > 0 && (
        <>
          <div className="sec-label">離散輸入 · DISCRETE FC02</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(sel.discretes).map(([k, v]) => (
              <span key={k} className={`chip${v ? " on" : ""}`}>{v ? "●" : "○"} {k}</span>
            ))}
          </div>
        </>
      )}

      {sel.input_regs && Object.keys(sel.input_regs).length > 0 && (
        <>
          <div className="sec-label">輸入暫存器 · INPUT FC04 唯讀</div>
          <table className="taglist"><tbody>
            {Object.entries(sel.input_regs).map(([k, v]) => (
              <tr key={k}><td className="name">{k}</td>
                <td className="val">{typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v)}</td></tr>
            ))}
          </tbody></table>
        </>
      )}

      {sel.coils && Object.keys(sel.coils).length > 0 && (
        <>
          <div className="sec-label">命令線圈 · COIL FC01/05 教師可寫</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(sel.coils).map(([k, v]) => (
              <span key={k} className={`chip${v ? " on" : ""}`}>{v ? "●" : "○"} {k}</span>
            ))}
          </div>
        </>
      )}

      {setpoints.length > 0 && (
        <>
          <div className="sec-label">設定點 · SETPOINT FC06 ★學生可寫</div>
          <div className="card" style={{ padding: "10px 12px", background: "var(--panel-3)" }}>
            {setpoints.map((sp) => (
              <SetpointControl key={sp.name} deviceId={sel.id} sp={sp}
                               value={sel.setpoints?.[sp.name] ?? sp.default} onMsg={setResetMsg} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

function KeySignal({ name, value, thresh }: { name: string; value: number; thresh: number }) {
  const max = thresh * 1.5;
  const over = value > thresh;
  const pct = Math.min(100, (value / max) * 100);
  const markPct = (thresh / max) * 100;
  return (
    <div className="sig">
      <div className="row">
        <span className="nm">{name}</span>
        <span className="vl" style={{ color: over ? "var(--fault)" : "var(--text)" }}>{value.toFixed(2)}</span>
      </div>
      <div className="track">
        <div className="fill" style={{ width: pct + "%", background: over ? "var(--fault)" : "linear-gradient(90deg,var(--accent),var(--ok))" }} />
        <div className="mark" style={{ left: markPct + "%" }} />
      </div>
    </div>
  );
}

function EventStream({ events }: { events: EventMsg[] }) {
  return (
    <div className="events">
      <h2>事件</h2>
      <div className="list">
        {events.length === 0 && <div className="muted">尚無事件</div>}
        {events.map((e, i) => (
          <div className="ev" key={i}>
            <span className="t">{(e.sim_t / 3600).toFixed(1)}h</span>{" "}
            {e.type === "fault" ? (
              <span style={{ color: "var(--fault)" }}>⚠ {e.device} 故障（{e.component}）</span>
            ) : e.type === "prediction" ? (
              <span style={{ color: "var(--pred)" }}>🔮 {e.device} 預測故障（{e.student}）</span>
            ) : e.type === "prediction_hit" ? (
              <span style={{ color: "var(--ok)" }}>✅ {e.device} 預測命中 lead {((e.lead_time_sim ?? 0) / 3600).toFixed(1)}h（{e.student}）</span>
            ) : e.type === "scenario" ? (
              <span style={{ color: "var(--pred)" }}>🎬 {e.message}</span>
            ) : e.type === "command" ? (
              <span style={{ color: "var(--accent)" }}>🎛 {e.device} 線圈 {e.coil}={e.value ? "1" : "0"}（教師）</span>
            ) : (
              <span style={{ color: "var(--text-2)" }}>{e.device}：{e.from} → {e.to}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// 設定點寫入控制(學生面,公開免 token):輸入新值 → 寫入,後端夾限;顯示目前即時值。
function SetpointControl({ deviceId, sp, value, onMsg }: {
  deviceId: string; sp: CatalogSetpoint; value: number; onMsg: (m: string) => void;
}) {
  const [v, setV] = useState(String(value));
  const write = async () => {
    const num = parseFloat(v);
    if (Number.isNaN(num)) { onMsg("請輸入數字"); return; }
    try {
      const r = await setSetpoint(deviceId, sp.name, num);
      onMsg(`已寫 ${sp.name}=${r.value}${sp.unit}${r.clamped ? `(超範圍,夾限到 ${sp.min}~${sp.max})` : ""}`);
    } catch (e: any) { onMsg(`寫入失敗:${e.message}`); }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "2px 0", flexWrap: "wrap" }}>
      <span style={{ fontSize: 12, color: "var(--text-2)", minWidth: 116, fontFamily: "var(--font-mono)" }}>{sp.name}</span>
      <span className="muted mono" style={{ fontSize: 12 }}>{value.toFixed(1)}{sp.unit}</span>
      <input className="inp mono" value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === "Enter" && write()}
             style={{ width: 62, padding: "4px 7px" }} />
      <button className="btn primary" style={{ padding: "4px 11px" }} onClick={write}>寫入</button>
      <span className="muted" style={{ fontSize: 10.5, width: "100%" }}>範圍 {sp.min}~{sp.max} {sp.unit} · Modbus FC06 寫 reg {sp.register}(raw = 值 × {sp.scale})</span>
    </div>
  );
}
