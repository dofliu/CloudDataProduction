import { useEffect, useState } from "react";
import { OeeRow, OeeDevice, getOee } from "../api";

// OEE = 可用率 × 表現 × 良率。公開排名榜,資料來自引擎 ground-truth 累積。
function pct(x: number) { return (x * 100).toFixed(1) + "%"; }
function barColor(x: number) { return x > 0.85 ? "var(--ok)" : x > 0.6 ? "var(--warn)" : "var(--fault)"; }

function Bar({ label, v }: { label: string; v: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "3px 0" }}>
      <span style={{ width: 46, fontSize: 11, color: "var(--dim)" }}>{label}</span>
      <div style={{ flex: 1, maxWidth: 240, background: "var(--line-3)", borderRadius: 4, height: 8, overflow: "hidden" }}>
        <div style={{ width: pct(v), height: "100%", borderRadius: 4, background: barColor(v), transition: "width .3s ease" }} />
      </div>
      <span className="mono" style={{ width: 56, textAlign: "right", fontSize: 12 }}>{pct(v)}</span>
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
  const top3 = ranking.slice(0, 3);

  return (
    <div className="page">
      <h2>OEE 設備總效率排名榜</h2>
      <p className="sub">
        OEE = <b>可用率</b>(運轉 / 計畫時間)× <b>表現</b>(實際 / 理論產出)× <b>良率</b>(良品率)。
        由引擎 ground-truth 累積;越快處置故障、可用率越高。全部為合成數據。
      </p>

      {/* 前三名卡 */}
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(230px,1fr))", marginBottom: 18 }}>
        {top3.map((r, i) => (
          <div key={r.company} className="card float" style={{
            background: i === 0 ? "linear-gradient(150deg,#fbf1dc,#f6efe2)" : "var(--panel)",
            borderColor: i === 0 ? "#eeddba" : "var(--line)",
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: i === 0 ? "var(--warn)" : "var(--dim)" }}>#{i + 1}</span>
              <span className="mono" style={{ fontSize: 30, fontWeight: 700, color: barColor(r.oee) }}>{pct(r.oee)}</span>
            </div>
            <div style={{ fontWeight: 600, marginTop: 4 }}>{r.name}</div>
            <div className="muted" style={{ fontSize: 11.5, marginBottom: 6 }}>{r.owner ?? "未認領"} · {r.devices.length} 台</div>
            <div className="mono muted" style={{ fontSize: 11.5 }}>
              可用 {pct(r.availability)} · 表現 {pct(r.performance)} · 良率 {pct(r.quality)}
            </div>
          </div>
        ))}
      </div>

      {/* 完整排名 */}
      <div className="card" style={{ padding: "6px 16px" }}>
        {ranking.map((r, i) => {
          const fault = r.devices.some((d) => devMap[d]?.down_h > 0 && devMap[d]?.availability < 0.99);
          return (
            <div key={r.company} style={{ display: "flex", gap: 20, alignItems: "center",
                                          padding: "11px 0", borderBottom: i < ranking.length - 1 ? "1px solid var(--line-3)" : "none" }}>
              <div className="mono" style={{ width: 26, fontSize: 16, textAlign: "center", color: i === 0 ? "var(--warn)" : "var(--dim)" }}>{i + 1}</div>
              <div style={{ width: 150 }}>
                <div style={{ fontWeight: 600, color: fault ? "var(--fault)" : "var(--text)" }}>{r.name}</div>
                <div className="muted" style={{ fontSize: 11 }}>{r.owner ?? "未認領"} · {r.devices.length} 台</div>
              </div>
              <div className="mono" style={{ width: 96, textAlign: "center", fontSize: 26, fontWeight: 700, color: barColor(r.oee) }}>{pct(r.oee)}</div>
              <div style={{ flex: 1, maxWidth: 340 }}>
                <Bar label="可用率" v={r.availability} />
                <Bar label="表現" v={r.performance} />
                <Bar label="良率" v={r.quality} />
              </div>
            </div>
          );
        })}
      </div>

      <h3 style={{ margin: "22px 0 8px", fontSize: 15 }}>各設備明細</h3>
      <div className="card" style={{ padding: "4px 16px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>
            {["設備", "OEE", "可用率", "表現", "良率", "運轉(h)", "停機(h)"].map((h, i) => (
              <th key={h} className="mono" style={{ textAlign: i === 0 ? "left" : "right", padding: "7px 8px",
                color: "var(--dim)", fontSize: 10.5, letterSpacing: ".5px", borderBottom: "1px solid var(--line)", textTransform: "uppercase", fontWeight: 500 }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {ranking.flatMap((r) => r.devices).map((did) => {
              const d = devMap[did]; if (!d) return null;
              return (
                <tr key={did}>
                  <td className="mono" style={{ padding: "6px 8px", borderBottom: "1px solid var(--line-3)" }}>{did}</td>
                  <td className="mono" style={{ textAlign: "right", padding: "6px 8px", color: barColor(d.oee), fontWeight: 600, borderBottom: "1px solid var(--line-3)" }}>{pct(d.oee)}</td>
                  <td className="mono" style={{ textAlign: "right", padding: "6px 8px", borderBottom: "1px solid var(--line-3)" }}>{pct(d.availability)}</td>
                  <td className="mono" style={{ textAlign: "right", padding: "6px 8px", borderBottom: "1px solid var(--line-3)" }}>{pct(d.performance)}</td>
                  <td className="mono" style={{ textAlign: "right", padding: "6px 8px", borderBottom: "1px solid var(--line-3)" }}>{pct(d.quality)}</td>
                  <td className="mono" style={{ textAlign: "right", padding: "6px 8px", borderBottom: "1px solid var(--line-3)" }}>{d.run_h}</td>
                  <td className="mono" style={{ textAlign: "right", padding: "6px 8px", color: d.down_h > 0 ? "var(--fault)" : "var(--muted)", borderBottom: "1px solid var(--line-3)" }}>{d.down_h}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
