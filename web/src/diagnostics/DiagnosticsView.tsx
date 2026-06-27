import { useState } from "react";
import { Diagnostics, DiagRow, getDiagnostics } from "../api";

type ProtoKey = "modbus" | "modbus_multiport" | "opcua" | "mqtt";
const PROTO_LABEL: Record<ProtoKey, string> = {
  modbus: "Modbus(共用埠)",
  modbus_multiport: "Modbus(專屬埠)",
  opcua: "OPC-UA",
  mqtt: "MQTT",
};
const PROTO_ORDER: ProtoKey[] = ["modbus", "modbus_multiport", "opcua", "mqtt"];

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

  // 實際回傳的協定(multi_port 啟用時才有 modbus_multiport)
  const protos: ProtoKey[] = diag ? PROTO_ORDER.filter((k) => (diag.protocols as any)[k]) : [];
  const block = (k: ProtoKey) => (diag!.protocols as any)[k] as { summary: any; devices: DiagRow[] };

  // 所有設備(各協定聯集),保留順序
  const deviceIds: string[] = [];
  if (diag) {
    for (const k of protos) for (const r of block(k).devices) {
      if (r.device && !deviceIds.includes(r.device)) deviceIds.push(r.device);
    }
  }
  const rowOf = (key: ProtoKey, dev: string): DiagRow | undefined =>
    block(key).devices.find((r) => r.device === dev);

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
          <div style={{ display: "flex", gap: 14, margin: "16px 0", flexWrap: "wrap" }}>
            {protos.map((k) => {
              const s = block(k).summary;
              const allOk = s.reachable === s.total;
              return (
                <div key={k} style={{ flex: 1, minWidth: 180, background: "var(--panel)", border: "1px solid var(--line)",
                                      borderRadius: 8, padding: "10px 14px" }}>
                  <div style={{ fontWeight: 600 }}>{PROTO_LABEL[k]} <span className="hint">:{s.port}</span></div>
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
              <tr><th>設備</th>{protos.map((k) => <th key={k}>{PROTO_LABEL[k]}</th>)}</tr>
            </thead>
            <tbody>
              {deviceIds.map((dev) => (
                <tr key={dev}>
                  <td><b>{dev}</b></td>
                  {protos.map((k) => {
                    const r = rowOf(k, dev);
                    return (
                      <td key={k}>
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
