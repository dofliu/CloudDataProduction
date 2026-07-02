import { useEffect, useRef, useState } from "react";
import {
  Catalog, EventMsg, Park, TelemetryMsg,
  getCatalog, getPark, subscribe, STATUS_COLOR_CSS, getTeacherToken, resetDevice, setCoil,
} from "./api";
import WorldView from "./world/WorldView";
import CatalogView from "./catalog/CatalogView";
import TeacherView from "./teacher/TeacherView";
import DiagnosticsView from "./diagnostics/DiagnosticsView";
import OeeView from "./oee/OeeView";
import StudentView from "./student/StudentView";
import OnboardingView from "./onboarding/OnboardingView";

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
  const telemetryRef = useRef<TelemetryMsg | null>(null);

  useEffect(() => {
    const loadPark = () => getPark().then((p) => { setPark(p); setApiError(false); })
                             .catch(() => setApiError(true));
    loadPark();
    getCatalog().then(setCatalog).catch(() => {});
    // 後端還沒起 / 暫時斷線時每 3 秒重試,起來後畫面自動恢復(不必手動整理)
    const retry = setInterval(() => { if (!telemetryRef.current) loadPark(); }, 3000);
    const unTel = subscribe<TelemetryMsg>("/ws/telemetry", (m) => {
      telemetryRef.current = m;
      setTelemetry(m);
    });
    const unEv = subscribe<EventMsg>("/ws/events", (e) => {
      setEvents((prev) => [e, ...prev].slice(0, 40));
      setPredicted((prev) => {
        const next = new Set(prev);
        if (e.type === "prediction") next.add(e.device);
        else if (e.type === "fault") next.delete(e.device);          // 真故障→紅,撤橘
        else if (e.type === "state_change" && e.to === "idle") next.delete(e.device); // reset
        return next;
      });
    });
    return () => { clearInterval(retry); unTel(); unEv(); };
  }, []);

  const simHours = telemetry ? (telemetry.sim_t / 3600).toFixed(1) : "—";
  const mult = telemetry?.multiplier;
  const sel = selected && telemetry ? telemetry.devices[selected] : null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>🏭 {park?.name ?? "勤益智慧工業區"}</h1>
        <span className="synthetic">合成數據 SYNTHETIC</span>
        <span className="clock">sim {simHours} h · {mult ?? "—"}×</span>
        <div className="spacer" />
        <nav className="nav">
          <button className={view === "start" ? "active" : ""} onClick={() => setView("start")}>🚀 開始</button>
          <button className={view === "world" ? "active" : ""} onClick={() => setView("world")}>2D 世界</button>
          <button className={view === "student" ? "active" : ""} onClick={() => setView("student")}>學生面</button>
          <button className={view === "catalog" ? "active" : ""} onClick={() => setView("catalog")}>設備目錄</button>
          <button className={view === "diag" ? "active" : ""} onClick={() => setView("diag")}>戰情版</button>
          <button className={view === "oee" ? "active" : ""} onClick={() => setView("oee")}>OEE 榜</button>
          <button className={view === "teacher" ? "active" : ""} onClick={() => setView("teacher")}>教師控制台</button>
        </nav>
      </header>

      <div className="main">
        {!park ? (
          <div className="catalog" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
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
              {park && (
                <WorldView park={park} telemetry={telemetry} selected={selected}
                           onSelect={setSelected} predicted={predicted} />
              )}
            </div>
            <aside className="side">
              {sel ? (
                <>
                  <h2>
                    {sel.id}{" "}
                    <span className="badge" style={{ background: STATUS_COLOR_CSS[sel.state] ?? "#8a93a6" }}>
                      {sel.state}
                    </span>
                  </h2>
                  <div className="muted">{sel.template}</div>
                  {getTeacherToken() ? (
                    <div style={{ margin: "8px 0", display: "flex", flexWrap: "wrap", gap: 8 }}>
                      {(() => {
                        const runEnabled = sel.coils?.run_enable !== false;   // 預設視為運轉
                        return (
                          <button
                            onClick={async () => {
                              try { await setCoil(sel.id, "run_enable", !runEnabled);
                                    setResetMsg(`已寫線圈 run_enable=${!runEnabled}:${sel.id}`); }
                              catch (e: any) { setResetMsg(`線圈寫入失敗:${e.message}(檢查教師 token)`); }
                            }}
                            style={{ background: runEnabled ? "#e0a23a" : "#37d67a", color: "#08121e", border: "none",
                                     borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontWeight: 600 }}>
                            {runEnabled ? "⏸ 停機 (run_enable→0)" : "▶ 復機 (run_enable→1)"}
                          </button>
                        );
                      })()}
                      <button
                        onClick={async () => {
                          try { await setCoil(sel.id, "reset_fault", true); setResetMsg(`已寫線圈 reset_fault:${sel.id}`); }
                          catch (e: any) {
                            try { await resetDevice(sel.id); setResetMsg(`已重置 / 清除故障:${sel.id}`); }
                            catch (e2: any) { setResetMsg(`重置失敗:${e2.message}(檢查教師 token)`); }
                          }
                        }}
                        style={{ background: "#37d67a", color: "#08121e", border: "none", borderRadius: 6, padding: "6px 14px", cursor: "pointer", fontWeight: 600 }}>
                        ↺ 重置 / 清除故障
                      </button>
                      {resetMsg && <div className="muted" style={{ width: "100%", marginTop: 2, color: "#5b9bd5" }}>{resetMsg}</div>}
                    </div>
                  ) : (
                    <div className="muted" style={{ fontSize: 12, margin: "6px 0" }}>（教師控制台輸入 token 後,這裡可寫命令線圈:停機/復機、清除故障)</div>
                  )}
                  <div className="muted" style={{ fontSize: 12, margin: "8px 0 2px" }}>保持暫存器 Holding（FC03）</div>
                  <table className="taglist">
                    <tbody>
                      {Object.entries(sel.tags).map(([k, v]) => (
                        <tr key={k}>
                          <td className="name">{k}</td>
                          <td className="val">{typeof v === "number" ? v.toFixed(2) : String(v)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>

                  {sel.discretes && Object.keys(sel.discretes).length > 0 && (
                    <>
                      <div className="muted" style={{ fontSize: 12, margin: "10px 0 2px" }}>離散輸入 Discrete Input（FC02）</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {Object.entries(sel.discretes).map(([k, v]) => (
                          <span key={k} style={{ fontSize: 12, padding: "2px 8px", borderRadius: 10,
                                                  background: v ? "#15402a" : "#262d3a", color: v ? "#37d67a" : "#8a93a6",
                                                  border: `1px solid ${v ? "#2f7a4f" : "#333b4a"}` }}>
                            {v ? "●" : "○"} {k}
                          </span>
                        ))}
                      </div>
                    </>
                  )}

                  {sel.input_regs && Object.keys(sel.input_regs).length > 0 && (
                    <>
                      <div className="muted" style={{ fontSize: 12, margin: "10px 0 2px" }}>輸入暫存器 Input Register（FC04，唯讀）</div>
                      <table className="taglist">
                        <tbody>
                          {Object.entries(sel.input_regs).map(([k, v]) => (
                            <tr key={k}>
                              <td className="name">{k}</td>
                              <td className="val">{typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(2)) : String(v)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </>
                  )}

                  {sel.coils && Object.keys(sel.coils).length > 0 && (
                    <>
                      <div className="muted" style={{ fontSize: 12, margin: "10px 0 2px" }}>命令線圈 Coil（FC01 讀 / FC05 寫,教師可寫）</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {Object.entries(sel.coils).map(([k, v]) => (
                          <span key={k} style={{ fontSize: 12, padding: "2px 8px", borderRadius: 10,
                                                  background: v ? "#15402a" : "#262d3a", color: v ? "#37d67a" : "#8a93a6",
                                                  border: `1px solid ${v ? "#2f7a4f" : "#333b4a"}` }}>
                            {v ? "●" : "○"} {k}
                          </span>
                        ))}
                      </div>
                    </>
                  )}
                </>
              ) : (
                <div className="muted">點公司進廠內 → 點設備看即時值。一公司一燈號:綠=正常、紅=有設備故障。</div>
              )}

              <div className="events">
                <h2>事件</h2>
                {events.length === 0 && <div className="muted">尚無事件</div>}
                {events.map((e, i) => (
                  <div className="ev" key={i}>
                    <span className="t">{(e.sim_t / 3600).toFixed(1)}h</span>{" "}
                    {e.type === "fault" ? (
                      <span style={{ color: "#e24c4c" }}>⚠ {e.device} 故障（{e.component}）</span>
                    ) : e.type === "prediction" ? (
                      <span style={{ color: "#f08c2e" }}>🔮 {e.device} 預測故障（{e.student}）</span>
                    ) : e.type === "prediction_hit" ? (
                      <span style={{ color: "#37d67a" }}>✅ {e.device} 預測命中 lead {((e.lead_time_sim ?? 0) / 3600).toFixed(1)}h（{e.student}）</span>
                    ) : e.type === "scenario" ? (
                      <span style={{ color: "#f08c2e" }}>🎬 {e.message}</span>
                    ) : e.type === "command" ? (
                      <span style={{ color: "#5b9bd5" }}>🎛 {e.device} 線圈 {e.coil}={e.value ? "1" : "0"}（教師）</span>
                    ) : (
                      <span>{e.device}：{e.from} → {e.to}</span>
                    )}
                  </div>
                ))}
              </div>
            </aside>
          </>
        ) : view === "student" ? (
          park && <StudentView park={park} telemetry={telemetry} />
        ) : view === "catalog" ? (
          <CatalogView catalog={catalog} telemetry={telemetry} />
        ) : view === "diag" ? (
          <DiagnosticsView host={window.location.hostname} />
        ) : view === "oee" ? (
          <OeeView />
        ) : (
          park && <TeacherView park={park} telemetry={telemetry}
                               onParkChanged={() => getPark().then(setPark).catch(console.error)} />
        )}
      </div>
    </div>
  );
}
