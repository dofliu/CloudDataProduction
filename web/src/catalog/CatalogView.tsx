import { useState } from "react";
import { Catalog, TelemetryMsg, STATUS_COLOR_CSS } from "../api";

// 公開設備目錄(學生規格書):左清單 + 右規格。改成 master-detail。
const th: React.CSSProperties = { textAlign: "left", padding: "7px 8px", color: "var(--dim)", fontFamily: "var(--font-mono)",
  fontSize: 10.5, letterSpacing: ".5px", borderBottom: "1px solid var(--line)", fontWeight: 500, textTransform: "uppercase" };
const td: React.CSSProperties = { padding: "5px 8px", borderBottom: "1px solid var(--line-3)", fontSize: 12 };
const tag = (t: string, color: string, bg: string): React.CSSProperties => ({
  fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 600, color, background: bg, padding: "1px 6px", borderRadius: 5 });

export default function CatalogView({ catalog, telemetry }: { catalog: Catalog | null; telemetry: TelemetryMsg | null }) {
  const [selId, setSelId] = useState<string | null>(null);
  if (!catalog) return <div className="page">載入目錄中…</div>;

  const sel = catalog.devices.find((d) => d.id === selId) ?? catalog.devices[0];
  const live = telemetry?.devices[sel?.id ?? ""];
  const mb = sel?.connection?.modbus ?? {};

  return (
    <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
      {/* 左:設備清單 */}
      <div style={{ width: 262, flex: "0 0 262px", borderRight: "1px solid var(--line)", overflowY: "auto", background: "var(--panel)" }}>
        <div style={{ padding: "12px 14px 6px" }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>設備目錄</div>
          <div className="muted" style={{ fontSize: 11 }}>{catalog.devices.length} 台 · {catalog.protocol_mode}</div>
        </div>
        {catalog.devices.map((d) => {
          const st = telemetry?.devices[d.id]?.state;
          const on = d.id === sel?.id;
          return (
            <div key={d.id} onClick={() => setSelId(d.id)}
                 style={{ padding: "8px 14px", cursor: "pointer", display: "flex", alignItems: "center", gap: 8,
                          borderLeft: `2px solid ${on ? "var(--accent)" : "transparent"}`,
                          background: on ? "#f6efe2" : "transparent" }}>
              <span style={{ width: 8, height: 8, borderRadius: 8, flex: "0 0 8px", background: STATUS_COLOR_CSS[st ?? ""] ?? "var(--dim)" }} />
              <span className="mono" style={{ fontSize: 12.5, color: on ? "var(--text)" : "var(--text-2)" }}>{d.id}</span>
              <span className="muted" style={{ fontSize: 10.5, marginLeft: "auto" }}>{d.company_id}</span>
            </div>
          );
        })}
      </div>

      {/* 右:規格 */}
      <div className="page" style={{ padding: "18px 22px" }}>
        {sel && (
          <>
            <h2 style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span className="mono">{sel.id}</span>
              {live && <span className="badge" style={{ background: STATUS_COLOR_CSS[live.state] ?? "var(--muted)" }}>{live.state}</span>}
              <span className="muted" style={{ fontSize: 13, fontWeight: 400 }}>{sel.template} · {sel.company_id}</span>
            </h2>
            <p className="sub" style={{ marginBottom: 14 }}>⚠ 全部為合成數據(synthetic),非真實場域量測。</p>

            {/* 連線 meta */}
            <div className="card" style={{ padding: "10px 14px", marginBottom: 16, display: "flex", gap: 22, flexWrap: "wrap" }}>
              {[["Modbus host", `${mb.host}:${mb.port}`], ["unit_id", String(mb.unit_id)], ["位元組序", `${mb.word_order}-endian`],
                ["ModScan", "holding +40001 · DI +10001 · IR +30001"]].map(([k, v]) => (
                <div key={k}>
                  <div className="muted" style={{ fontSize: 10.5 }}>{k}</div>
                  <div className="mono" style={{ fontSize: 12.5, fontWeight: 600 }}>{v}</div>
                </div>
              ))}
            </div>

            {/* HOLDING */}
            <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 6px" }}>
              <span style={tag("#7fd0e6", "#7fd0e6", "#f6efe2")}>FC03</span><b style={{ fontSize: 13 }}>保持暫存器 Holding · 量測</b>
            </div>
            <div className="card" style={{ padding: "2px 14px", marginBottom: 16 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead><tr>{["tag", "單位", "型別", "reg", "ModScan", "mqtt", "即時值"].map((h, i) => <th key={h} style={{ ...th, textAlign: i >= 3 ? "right" : "left" }}>{h}</th>)}</tr></thead>
                <tbody>
                  {sel.tags.map((t) => (
                    <tr key={t.name}>
                      <td style={td}>{t.name}</td>
                      <td style={{ ...td, color: "var(--muted)" }}>{t.unit}</td>
                      <td style={td}><span className="mono" style={{ fontSize: 11 }}>{t.datatype}</span></td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)" }}>{t.modbus_register}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--muted)" }}>{40001 + t.modbus_register}</td>
                      <td style={{ ...td, color: "var(--dim)", fontSize: 11 }}>{t.mqtt_field}</td>
                      <td style={{ ...td, textAlign: "right", fontFamily: "var(--font-mono)", color: "var(--text)" }}>{live ? live.tags[t.name]?.toFixed(2) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* 兩欄:離散輸入 + 線圈 + 輸入暫存器 + 設定點 */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(300px,1fr))", gap: 16 }}>
              {sel.discrete_inputs && sel.discrete_inputs.length > 0 && (
                <ObjTable label="離散輸入 Discrete" fc="FC02" fcColor="#cfe6c0" fcBg="#eef4e8"
                  head={["name", "addr", "值"]} rows={sel.discrete_inputs.map((p) => {
                    const v = live?.discretes?.[p.name];
                    return [p.name, String(p.address), v === undefined ? "—" : v ? "1 ●" : "0 ○"];
                  })} />
              )}
              {sel.coils && sel.coils.length > 0 && (
                <ObjTable label="命令線圈 Coil" fc="FC01/05" fcColor="#d9a441" fcBg="#fbf1dc"
                  head={["name", "addr", "權限", "值"]} rows={sel.coils.map((c) => {
                    const v = live?.coils?.[c.name];
                    return [c.name, String(c.address), c.access, v === undefined ? "—" : v ? "1 ●" : "0 ○"];
                  })} />
              )}
              {sel.input_registers && sel.input_registers.length > 0 && (
                <ObjTable label="輸入暫存器 Input" fc="FC04" fcColor="#c7a3f0" fcBg="#f4e6d2"
                  head={["name", "addr", "scale", "值"]} rows={sel.input_registers.map((p) => {
                    const v = live?.input_regs?.[p.name];
                    return [p.name, String(p.address), `÷${p.scale}`, v === undefined ? "—" : String(v)];
                  })} />
              )}
              {sel.setpoints && sel.setpoints.length > 0 && (
                <ObjTable label="設定點 Setpoint ★學生可寫" fc="FC06" fcColor="var(--accent)" fcBg="#f4e6d2"
                  head={["name", "reg", "範圍", "值"]} rows={sel.setpoints.map((s) => {
                    const v = live?.setpoints?.[s.name];
                    return [s.name, String(s.register), `${s.min}~${s.max}${s.unit}`, v === undefined ? "—" : String(v)];
                  })} />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ObjTable({ label, fc, fcColor, fcBg, head, rows }: {
  label: string; fc: string; fcColor: string; fcBg: string; head: string[]; rows: string[][];
}) {
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", margin: "0 0 6px" }}>
        <span style={tag(fcColor, fcColor, fcBg)}>{fc}</span><b style={{ fontSize: 12.5 }}>{label}</b>
      </div>
      <div className="card" style={{ padding: "2px 12px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{head.map((h, i) => <th key={h} style={{ ...th, textAlign: i === 0 ? "left" : "right" }}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => (
                <td key={ci} className={ci === 0 ? "" : "mono"} style={{ ...td, textAlign: ci === 0 ? "left" : "right",
                  color: ci === 0 ? "var(--text-2)" : "var(--text)" }}>{c}</td>
              ))}</tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
