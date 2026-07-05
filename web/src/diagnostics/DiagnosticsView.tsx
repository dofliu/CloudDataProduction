import { useState } from "react";
import { Diagnostics, DiagRow, getDiagnostics } from "../api";

type ProtoKey = "modbus" | "modbus_multiport" | "opcua" | "mqtt";
const PROTO_LABEL: Record<ProtoKey, string> = {
  modbus: "Modbus(共用埠)", modbus_multiport: "Modbus(專屬埠)", opcua: "OPC-UA", mqtt: "MQTT",
};
const PROTO_ORDER: ProtoKey[] = ["modbus", "modbus_multiport", "opcua", "mqtt"];

export default function DiagnosticsView({ host }: { host: string }) {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const run = async () => {
    setLoading(true); setErr("");
    try { setDiag(await getDiagnostics()); }
    catch (e: any) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const protos: ProtoKey[] = diag ? PROTO_ORDER.filter((k) => (diag.protocols as any)[k]) : [];
  const block = (k: ProtoKey) => (diag!.protocols as any)[k] as { summary: any; devices: DiagRow[] };
  const deviceIds: string[] = [];
  if (diag) for (const k of protos) for (const r of block(k).devices)
    if (r.device && !deviceIds.includes(r.device)) deviceIds.push(r.device);
  const rowOf = (key: ProtoKey, dev: string) => block(key).devices.find((r) => r.device === dev);

  return (
    <div className="page">
      <h2>戰情版 · 協定連線自測</h2>
      <p className="sub">
        以 <b>Modbus / OPC-UA / MQTT</b> 各開一個 client 連回伺服器(<code className="mono">{diag?.host ?? host}</code>)逐設備讀樣本值 ——
        同時驗證「伺服器通不通」與「以協定列出設備」。全部為合成數據。
      </p>
      <button className="btn primary" onClick={run} disabled={loading} style={{ padding: "9px 18px", opacity: loading ? 0.7 : 1 }}>
        {loading ? "診斷中…(MQTT 需收訊息,約 2–3 秒)" : "▶ 執行連線診斷"}
      </button>
      {err && <div className="hint" style={{ color: "var(--fault)", marginTop: 8 }}>診斷失敗:{err}</div>}

      {diag && (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(190px,1fr))", margin: "18px 0" }}>
            {protos.map((k) => {
              const s = block(k).summary;
              const allOk = s.reachable === s.total;
              const col = allOk ? "var(--ok)" : "var(--fault)";
              return (
                <div key={k} className="card" style={{ borderColor: allOk ? "#1e4230" : "#4a2620", background: allOk ? "#0d1a14" : "#180f10" }}>
                  <div style={{ fontWeight: 600, fontSize: 12.5 }}>{PROTO_LABEL[k]}
                    <span className="mono muted" style={{ fontSize: 11 }}> :{s.port}</span></div>
                  <div className="mono" style={{ fontSize: 26, fontWeight: 700, color: col, marginTop: 4 }}>
                    {s.reachable}/{s.total} <span style={{ fontSize: 12, color: "var(--muted)" }}>可達</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card" style={{ padding: "4px 16px", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead><tr>
                {["設備", ...protos.map((k) => PROTO_LABEL[k])].map((h, i) => (
                  <th key={i} className="mono" style={{ textAlign: "left", padding: "8px", color: "var(--dim)",
                    fontSize: 10.5, letterSpacing: ".5px", borderBottom: "1px solid var(--line)", fontWeight: 500 }}>{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {deviceIds.map((dev) => (
                  <tr key={dev}>
                    <td className="mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)", fontWeight: 600 }}>{dev}</td>
                    {protos.map((k) => {
                      const r = rowOf(k, dev);
                      return (
                        <td key={k} style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)", fontSize: 12 }}>
                          {r?.ok ? (
                            <span>
                              <span className="mono" style={{ color: "var(--ok)" }}>✓ {r.value}</span>{" "}
                              <span className="muted" style={{ fontSize: 11 }}>{r.tag} · {r.addr}{r.latency_ms != null ? ` · ${r.latency_ms}ms` : ""}</span>
                            </span>
                          ) : (
                            <span className="mono" style={{ color: "var(--fault)" }}>✗ {r?.error ?? "—"}</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: 12 }}>綠 ✓ = 該協定讀到值(附 tag·位址·延遲);紅 ✗ = 連不上或讀取失敗。可對照你自己 client 的結果。</p>
        </>
      )}
    </div>
  );
}
