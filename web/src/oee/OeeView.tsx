import { useEffect, useState } from "react";
import { OeeRow, OeeDevice, getOee } from "../api";

// OEE = 可用率 × 表現 × 良率。公開排名榜,資料來自引擎 ground-truth 累積。
function pct(x: number) { return (x * 100).toFixed(1) + "%"; }
function barColor(x: number) { return x > 0.85 ? "#37d67a" : x > 0.6 ? "#f2c037" : "#e24c4c"; }

function Bar({ label, v }: { label: string; v: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "2px 0" }}>
      <span className="hint" style={{ width: 52 }}>{label}</span>
      <div style={{ flex: 1, maxWidth: 220, background: "#222c3c", borderRadius: 4, height: 10 }}>
        <div style={{ width: pct(v), height: "100%", borderRadius: 4, background: barColor(v) }} />
      </div>
      <span style={{ width: 56, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{pct(v)}</span>
    </div>
  );
}

export default function OeeView() {
  const [ranking, setRanking] = useState<OeeRow[]>([]);
  const [devices, setDevices] = useState<OeeDevice[]>([]);

  useEffect(() => {
    const tick = async () => { try { const d = await getOee(); setRanking(d.ranking); setDevices(d.devices); } catch { /* */ } };
    tick(); const id = setInterval(tick, 2500); return () => clearInterval(id);
  }, []);

  const devMap = Object.fromEntries(devices.map((d) => [d.device, d]));

  return (
    <div className="catalog">
      <h2>OEE 設備總效率排名榜</h2>
      <p className="hint">
        OEE = <b>可用率</b>(運轉 / 計畫時間)× <b>表現</b>(實際 / 理論產出)× <b>良率</b>(良品率)。
        全部由引擎 ground-truth 累積;可用率由故障停機長短決定 —— 越快處置故障越高。全部為合成數據。
      </p>

      {ranking.map((r, i) => (
        <div key={r.company} style={{ display: "flex", gap: 24, alignItems: "center",
                                      padding: "12px 0", borderBottom: "1px solid var(--line)" }}>
          <div style={{ width: 28, fontSize: 22, textAlign: "center", color: i === 0 ? "#f2c037" : "var(--muted)" }}>{i + 1}</div>
          <div style={{ width: 150 }}>
            <div style={{ fontWeight: 600 }}>{r.name}</div>
            <div className="hint">{r.owner ?? "未認領"} · {r.devices.length} 台</div>
          </div>
          <div style={{ width: 110, textAlign: "center" }}>
            <div style={{ fontSize: 30, fontWeight: 700, color: barColor(r.oee), fontVariantNumeric: "tabular-nums" }}>{pct(r.oee)}</div>
            <div className="hint">OEE</div>
          </div>
          <div style={{ flex: 1, maxWidth: 320 }}>
            <Bar label="可用率" v={r.availability} />
            <Bar label="表現" v={r.performance} />
            <Bar label="良率" v={r.quality} />
          </div>
        </div>
      ))}

      <h3 style={{ marginTop: 24 }}>各設備明細</h3>
      <table>
        <thead><tr><th>設備</th><th>OEE</th><th>可用率</th><th>表現</th><th>良率</th><th>運轉(h)</th><th>停機(h)</th></tr></thead>
        <tbody>
          {ranking.flatMap((r) => r.devices).map((did) => {
            const d = devMap[did]; if (!d) return null;
            return (
              <tr key={did}>
                <td><b>{did}</b></td>
                <td style={{ color: barColor(d.oee), fontWeight: 600 }}>{pct(d.oee)}</td>
                <td>{pct(d.availability)}</td><td>{pct(d.performance)}</td><td>{pct(d.quality)}</td>
                <td>{d.run_h}</td><td style={{ color: d.down_h > 0 ? "#e24c4c" : undefined }}>{d.down_h}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
