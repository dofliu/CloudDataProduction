import { useEffect, useRef, useState } from "react";
import {
  Catalog, EventMsg, Park, TelemetryMsg,
  getCatalog, getPark, subscribe, STATUS_COLOR_CSS,
} from "./api";
import WorldView from "./world/WorldView";
import CatalogView from "./catalog/CatalogView";
import TeacherView from "./teacher/TeacherView";
import DiagnosticsView from "./diagnostics/DiagnosticsView";

export default function App() {
  const [park, setPark] = useState<Park | null>(null);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [telemetry, setTelemetry] = useState<TelemetryMsg | null>(null);
  const [events, setEvents] = useState<EventMsg[]>([]);
  const [view, setView] = useState<"world" | "catalog" | "teacher" | "diag">("world");
  const [selected, setSelected] = useState<string | null>(null);
  const [predicted, setPredicted] = useState<Set<string>>(new Set());
  const telemetryRef = useRef<TelemetryMsg | null>(null);

  useEffect(() => {
    getPark().then(setPark).catch(console.error);
    getCatalog().then(setCatalog).catch(console.error);
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
    return () => { unTel(); unEv(); };
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
          <button className={view === "world" ? "active" : ""} onClick={() => setView("world")}>2D 世界</button>
          <button className={view === "catalog" ? "active" : ""} onClick={() => setView("catalog")}>設備目錄</button>
          <button className={view === "diag" ? "active" : ""} onClick={() => setView("diag")}>戰情版</button>
          <button className={view === "teacher" ? "active" : ""} onClick={() => setView("teacher")}>教師控制台</button>
        </nav>
      </header>

      <div className="main">
        {view === "world" ? (
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
                </>
              ) : (
                <div className="muted">點地圖上的設備看即時值。綠=正常、黃=警告、紅=故障、灰=停機/充電。</div>
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
                    ) : (
                      <span>{e.device}：{e.from} → {e.to}</span>
                    )}
                  </div>
                ))}
              </div>
            </aside>
          </>
        ) : view === "catalog" ? (
          <CatalogView catalog={catalog} telemetry={telemetry} />
        ) : view === "diag" ? (
          <DiagnosticsView host={window.location.hostname} />
        ) : (
          park && <TeacherView park={park} telemetry={telemetry} />
        )}
      </div>
    </div>
  );
}
