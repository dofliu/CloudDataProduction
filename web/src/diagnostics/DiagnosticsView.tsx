import { useState } from "react";
import { Diagnostics, DiagRow, getDiagnostics } from "../api";

const PROTOS: { key: "modbus" | "opcua" | "mqtt"; label: string }[] = [
  { key: "modbus", label: "Modbus TCP" },
  { key: "opcua", label: "OPC-UA" },
  { key: "mqtt", label: "MQTT" },
];

// 老師的「標準答案」客戶端:真的用三協定當 client 連回伺服器,驗證連得上、讀得到值。
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

  // 所有設備(三協定聯集),保留順序
  const deviceIds: string[] = [];
  if (diag) {
    for (const p of PROTOS) for (const r of diag.protocols[p.key].devices) {
      if (r.device && !deviceIds.includes(r.device)) deviceIds.push(r.device);
    }
  }
  const rowOf = (key: "modbus" | "opcua" | "mqtt", dev: string): DiagRow | undefined =>
    diag?.protocols[key].devices.find((r) => r.device === dev);

  return (
    <div className="catalog">
      <h2>戰情版 · 協定連線自測</h2>
      <p className="hint">
        以 <b>Modbus / OPC-UA / MQTT</b> 各開一個 client 連回伺服器(<code>{diag?.host ?? host}</code>)逐設備讀樣本值 ——
        同時驗證「伺服器通不通」與「以協定列出設備」。全部為合成數據。
      </p>
      <button onClick={run} disabled={loading}
              style={{ background: "#5b9bd5", color: "#08121e", border: "none", borderRadius: 6,
                       padding: "8px 18px", cursor: "pointer", fontWeight: 600 }}>
        {loading ? "診斷中…（MQTT 需收訊息,約 2–3 秒）" : "▶ 執行連線診斷"}
      </button>
      {err && <div className="hint" style={{ color: "#e24c4c", marginTop: 8 }}>診斷失敗:{err}</div>}

      {diag && (
        <>
          {/* 各協定摘要 */}
          <div style={{ display: "flex", gap: 14, margin: "16px 0" }}>
            {PROTOS.map((p) => {
              const s = diag.protocols[p.key].summary;
              const allOk = s.reachable === s.total;
              return (
                <div key={p.key} style={{ flex: 1, background: "var(--panel)", border: "1px solid var(--line)",
                                          borderRadius: 8, padding: "10px 14px" }}>
                  <div style={{ fontWeight: 600 }}>{p.label} <span className="hint">:{s.port}</span></div>
                  <div style={{ fontSize: 22, color: allOk ? "#37d67a" : "#e24c4c", fontVariantNumeric: "tabular-nums" }}>
                    {s.reachable}/{s.total} <span style={{ fontSize: 13 }}>可達</span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 設備 × 協定 矩陣 */}
          <table>
            <thead>
              <tr><th>設備</th>{PROTOS.map((p) => <th key={p.key}>{p.label}</th>)}</tr>
            </thead>
            <tbody>
              {deviceIds.map((dev) => (
                <tr key={dev}>
                  <td><b>{dev}</b></td>
                  {PROTOS.map((p) => {
                    const r = rowOf(p.key, dev);
                    return (
                      <td key={p.key}>
                        {r?.ok ? (
                          <span>
                            <span style={{ color: "#37d67a" }}>✓ {r.value}</span>{" "}
                            <span className="hint">{r.tag} · {r.addr}{r.latency_ms != null ? ` · ${r.latency_ms}ms` : ""}</span>
                          </span>
                        ) : (
                          <span style={{ color: "#e24c4c" }}>✗ {r?.error ?? "—"}</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}
