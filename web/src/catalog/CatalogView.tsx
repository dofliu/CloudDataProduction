import { Catalog, TelemetryMsg, STATUS_COLOR_CSS } from "../api";

// 公開設備目錄(學生規格書):每台設備連什麼 port/unit_id、有哪些 tag 在哪個 register。
export default function CatalogView({
  catalog, telemetry,
}: { catalog: Catalog | null; telemetry: TelemetryMsg | null }) {
  if (!catalog) return <div className="catalog">載入目錄中…</div>;

  return (
    <div className="catalog">
      <h2>設備目錄 · {catalog.park}</h2>
      <p className="hint">
        協定模式：<code>{catalog.protocol_mode}</code>。{catalog.hint}
        <br />⚠ 全部為合成數據（synthetic），非真實場域量測。
      </p>

      {catalog.devices.map((d) => {
        const live = telemetry?.devices[d.id];
        const mb = d.connection?.modbus ?? {};
        return (
          <div key={d.id} style={{ marginBottom: 26 }}>
            <h3 style={{ marginBottom: 4 }}>
              {d.id}{" "}
              <span style={{ color: "var(--muted)", fontWeight: 400 }}>
                · {d.template} · {d.company_id}
              </span>{" "}
              {live && (
                <span className="badge" style={{ background: STATUS_COLOR_CSS[live.state] ?? "#8a93a6" }}>
                  {live.state}
                </span>
              )}
            </h3>
            <div className="hint">
              Modbus TCP：<code>{mb.host}:{mb.port}</code> unit_id=<code>{mb.unit_id}</code>{" "}
              {mb.word_order}-endian（高字組在前,不需 swap）。 ModScan 位址：holding=reg+40001、
              discrete input=addr+10001、input register=addr+30001。第 1 個 holding 是 <code>state</code>（int16），float 量測由第 2 格起。
            </div>

            {/* Holding registers（FC03,量測）*/}
            <table>
              <thead>
                <tr>
                  <th>tag (FC03 holding)</th><th>單位</th><th>型別</th>
                  <th>reg</th><th>ModScan</th><th>mqtt field</th><th>即時值</th>
                </tr>
              </thead>
              <tbody>
                {d.tags.map((t) => (
                  <tr key={t.name}>
                    <td>{t.name}</td>
                    <td>{t.unit}</td>
                    <td><code>{t.datatype}</code></td>
                    <td><code>{t.modbus_register}</code></td>
                    <td><code>{40001 + t.modbus_register}</code></td>
                    <td style={{ color: "var(--muted)" }}>{t.mqtt_field}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {live ? live.tags[t.name]?.toFixed(2) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Discrete inputs（FC02,狀態 bit）*/}
            {d.discrete_inputs && d.discrete_inputs.length > 0 && (
              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr><th>discrete input (FC02)</th><th>型別</th><th>addr</th><th>ModScan</th><th>mqtt field</th><th>即時值</th></tr>
                </thead>
                <tbody>
                  {d.discrete_inputs.map((p) => {
                    const v = live?.discretes?.[p.name];
                    return (
                      <tr key={p.name}>
                        <td>{p.name}</td>
                        <td><code>bool</code></td>
                        <td><code>{p.address}</code></td>
                        <td><code>{10001 + p.address}</code></td>
                        <td style={{ color: "var(--muted)" }}>{p.mqtt_field}</td>
                        <td style={{ textAlign: "right" }}>{v === undefined ? "—" : v ? "1 ●" : "0 ○"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}

            {/* Input registers（FC04,唯讀 int）*/}
            {d.input_registers && d.input_registers.length > 0 && (
              <table style={{ marginTop: 8 }}>
                <thead>
                  <tr><th>input register (FC04)</th><th>單位</th><th>型別</th><th>addr</th><th>ModScan</th><th>scale</th><th>即時值</th></tr>
                </thead>
                <tbody>
                  {d.input_registers.map((p) => {
                    const v = live?.input_regs?.[p.name];
                    return (
                      <tr key={p.name}>
                        <td>{p.name}</td>
                        <td>{p.unit}</td>
                        <td><code>{p.datatype}</code></td>
                        <td><code>{p.address}</code></td>
                        <td><code>{30001 + p.address}</code></td>
                        <td><code>÷{p.scale}</code></td>
                        <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                          {v === undefined ? "—" : v}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        );
      })}
    </div>
  );
}
