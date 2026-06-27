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
              holding registers（{mb.word_order}-endian）
            </div>
            <table>
              <thead>
                <tr>
                  <th>tag</th><th>單位</th><th>型別</th>
                  <th>modbus reg</th><th>opcua node</th><th>mqtt field</th><th>即時值</th>
                </tr>
              </thead>
              <tbody>
                {d.tags.map((t) => (
                  <tr key={t.name}>
                    <td>{t.name}</td>
                    <td>{t.unit}</td>
                    <td><code>{t.datatype}</code></td>
                    <td><code>{t.modbus_register}</code></td>
                    <td style={{ color: "var(--muted)" }}>{t.opcua_node}</td>
                    <td style={{ color: "var(--muted)" }}>{t.mqtt_field}</td>
                    <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                      {live ? live.tags[t.name]?.toFixed(2) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}
