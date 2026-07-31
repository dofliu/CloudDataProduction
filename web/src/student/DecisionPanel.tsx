import { useEffect, useState } from "react";
import {
  RepairAction, MaintenanceRec, AlarmRule, AlarmAlert, TelemetryMsg,
  doMaintenance, getMaintenance, createAlarmRule, getAlarmRules, deleteAlarmRule,
} from "../api";

/**
 * 學生的兩個「有代價的決策」:預防保養與託管告警規則。
 *
 * 這頁刻意不給任何 ground-truth —— 看不到健康度、看不到 RUL、看不到根因。
 * 學生只能從遙測資料判斷,決策的後果由引擎誠實反映在 OEE 與 F1 上。
 */
export default function DecisionPanel({ me, myDevices, telemetry, actions }: {
  me: string;
  myDevices: string[];
  telemetry: TelemetryMsg | null;
  actions: RepairAction[];
}) {
  const [tab, setTab] = useState<"manual" | "maint" | "alarm">("manual");
  const [msg, setMsg] = useState("");

  // 保養
  const [mDev, setMDev] = useState("");
  const [mAct, setMAct] = useState("");
  const [mLog, setMLog] = useState<MaintenanceRec[]>([]);

  // 告警規則
  const [rDev, setRDev] = useState("");
  const [rTag, setRTag] = useState("");
  const [rOp, setROp] = useState(">");
  const [rTh, setRTh] = useState("");
  const [rAgg, setRAgg] = useState<"raw" | "ema">("ema");
  const [rWin, setRWin] = useState("3600");
  const [rFor, setRFor] = useState("1800");
  const [rules, setRules] = useState<AlarmRule[]>([]);
  const [alerts, setAlerts] = useState<AlarmAlert[]>([]);

  const devices = myDevices.length ? myDevices : Object.keys(telemetry?.devices ?? {});
  const tagsOf = (d: string) => Object.keys(telemetry?.devices?.[d]?.tags ?? {});

  useEffect(() => { if (!mDev && devices.length) setMDev(devices[0]); }, [devices.join(",")]);
  useEffect(() => { if (!rDev && devices.length) setRDev(devices[0]); }, [devices.join(",")]);
  useEffect(() => { const t = tagsOf(rDev); if (t.length && !t.includes(rTag)) setRTag(t[0]); }, [rDev, telemetry ? 1 : 0]);

  const refresh = () => {
    if (me) getMaintenance(me).then((r) => setMLog(r.maintenance)).catch(() => {});
    getAlarmRules(me || undefined).then((r) => { setRules(r.rules); setAlerts(r.alerts); }).catch(() => {});
  };
  useEffect(() => { refresh(); const id = setInterval(refresh, 6000); return () => clearInterval(id); }, [me]);

  const runMaintenance = async () => {
    if (!mDev || !mAct) { setMsg("請先選設備與保養動作"); return; }
    try {
      const r = await doMaintenance(mDev, mAct, me || undefined);
      const g = r.maintenance.health_gain;
      setMsg(g > 0
        ? `✅ ${mDev} 保養完成:買到壽命 +${(g * 100).toFixed(1)}%,停機 ${r.maintenance.downtime_h}h`
        : `⚠️ ${mDev} 保養完成,但買到壽命 0 —— 這個部位現在沒在退化,${r.maintenance.downtime_h}h 停機是白花的`);
      refresh();
    } catch { setMsg("保養失敗:只能保養你認領公司的設備,而且不能在維修工時中重複下單"); }
  };

  const addRule = async () => {
    const th = Number(rTh);
    if (!rDev || !rTag || !Number.isFinite(th)) { setMsg("請填設備 / tag / 門檻"); return; }
    try {
      await createAlarmRule({
        device: rDev, tag: rTag, op: rOp, threshold: th, agg: rAgg,
        window_s: rAgg === "ema" ? Number(rWin) || 0 : 0, for_s: Number(rFor) || 0,
        student: me || undefined,
      } as any);
      setMsg(`已託管規則:${rDev}.${rTag} ${rOp} ${th}`);
      refresh();
    } catch { setMsg("規則建立失敗(檢查 tag 名稱與數值)"); }
  };

  const TABS: [typeof tab, string][] = [["manual", "📖 維修手冊"], ["maint", "🔧 預防保養"], ["alarm", "🔔 告警規則"]];

  return (
    <div className="card" style={{ padding: "12px 14px", marginTop: 22 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginBottom: 10 }}>
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className="btn"
            style={{ padding: "4px 11px", fontSize: 12.5, background: tab === k ? "var(--accent)" : "var(--panel-3)",
                     color: tab === k ? "#fffaf0" : "var(--text-2)", border: "none" }}>{label}</button>
        ))}
        <span style={{ flex: 1 }} />
        {!me && <span className="muted" style={{ fontSize: 11.5 }}>先在上方設定學號</span>}
      </div>
      {msg && <div className="hint" style={{ color: "var(--accent)", marginBottom: 10 }}>· {msg}</div>}

      {tab === "manual" && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            工單不會寫根因。這張表告訴你每種故障<b>在數據上長什麼樣</b> —— 對照你抓到的訊號選動作。
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["處置動作", "工時", "數據上的徵候"].map((h) => (
              <th key={h} className="mono" style={{ textAlign: "left", padding: "5px 6px", color: "var(--dim)", fontSize: 10.5, borderBottom: "1px solid var(--line)", fontWeight: 500 }}>{h}</th>
            ))}</tr></thead>
            <tbody>
              {actions.map((a) => (
                <tr key={a.action}>
                  <td style={{ padding: "6px", borderBottom: "1px solid var(--line-3)", fontSize: 12, fontWeight: 600 }}>{a.label}</td>
                  <td className="mono" style={{ padding: "6px", borderBottom: "1px solid var(--line-3)", fontSize: 12, textAlign: "right" }}>{a.duration_h}h</td>
                  <td className="muted" style={{ padding: "6px", borderBottom: "1px solid var(--line-3)", fontSize: 11.5 }}>{a.signature}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {tab === "maint" && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            在<b>還沒壞之前</b>做保養。保養要停機,停機會扣可用率 —— 做太勤跟完全不做都會讓 OEE 難看,
            這題沒有標準答案,自己權衡。
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <select className="inp" value={mDev} onChange={(e) => setMDev(e.target.value)} style={{ padding: "5px 8px", fontSize: 12.5 }}>
              {devices.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select className="inp" value={mAct} onChange={(e) => setMAct(e.target.value)} style={{ padding: "5px 8px", fontSize: 12.5, maxWidth: 240 }}>
              <option value="">選擇保養項目…</option>
              {actions.map((a) => <option key={a.action} value={a.action} title={a.signature}>{a.label}({a.duration_h}h)</option>)}
            </select>
            <button className="btn primary" style={{ padding: "5px 13px", fontSize: 12.5 }} onClick={runMaintenance}>執行保養</button>
          </div>
          <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginBottom: 4 }}>最近保養</div>
          {mLog.length === 0 ? <p className="hint" style={{ margin: 0 }}>還沒做過保養。</p> : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {mLog.slice(0, 8).map((r) => (
                  <tr key={r.id}>
                    <td className="mono" style={{ padding: "4px 6px", fontSize: 11.5, borderBottom: "1px solid var(--line-3)" }}>{r.device}</td>
                    <td style={{ padding: "4px 6px", fontSize: 11.5, borderBottom: "1px solid var(--line-3)" }}>{r.action}</td>
                    <td className="mono" style={{ padding: "4px 6px", fontSize: 11.5, textAlign: "right", borderBottom: "1px solid var(--line-3)" }}>−{r.downtime_h}h</td>
                    <td className="mono" style={{ padding: "4px 6px", fontSize: 11.5, textAlign: "right", borderBottom: "1px solid var(--line-3)",
                        color: r.effective ? "var(--ok)" : "var(--fault)" }}>
                      {r.effective ? `+${(r.health_gain * 100).toFixed(1)}% 壽命` : "白花"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}

      {tab === "alarm" && (
        <>
          <p className="hint" style={{ marginTop: 0 }}>
            交一條規則,平台幫你 24 小時跑。抓到<b>故障發生前 24 小時內</b>的告警算命中,
            沒有後續故障的算誤報,監控中的設備壞了卻沒叫算漏報 —— 系統用真實故障時刻算 F1 與提前量。
            門檻拉太低會被雜訊洗成誤報機,拉太高就漏報,這是要調的。
          </p>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <select className="inp" value={rDev} onChange={(e) => setRDev(e.target.value)} style={{ padding: "5px 8px", fontSize: 12.5 }}>
              {devices.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <select className="inp" value={rTag} onChange={(e) => setRTag(e.target.value)} style={{ padding: "5px 8px", fontSize: 12.5 }}>
              {tagsOf(rDev).map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="inp" value={rAgg} onChange={(e) => setRAgg(e.target.value as "raw" | "ema")} style={{ padding: "5px 8px", fontSize: 12.5 }}>
              <option value="raw">原始值</option>
              <option value="ema">移動平均(EMA)</option>
            </select>
            {rAgg === "ema" && (
              <label className="mono" style={{ fontSize: 11.5, color: "var(--dim)" }}>
                時間常數 <input className="inp" value={rWin} onChange={(e) => setRWin(e.target.value)} style={{ width: 66, padding: "4px 6px" }} />s
              </label>
            )}
            <select className="inp" value={rOp} onChange={(e) => setROp(e.target.value)} style={{ padding: "5px 8px", fontSize: 12.5, width: 64 }}>
              {[">", ">=", "<", "<="].map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
            <input className="inp" value={rTh} onChange={(e) => setRTh(e.target.value)} placeholder="門檻" style={{ width: 78, padding: "5px 8px", fontSize: 12.5 }} />
            <label className="mono" style={{ fontSize: 11.5, color: "var(--dim)" }}>
              持續 <input className="inp" value={rFor} onChange={(e) => setRFor(e.target.value)} style={{ width: 66, padding: "4px 6px" }} />s
            </label>
            <button className="btn primary" style={{ padding: "5px 13px", fontSize: 12.5 }} onClick={addRule}>託管規則</button>
          </div>

          <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginBottom: 4 }}>
            我的規則(同一台同一 tag 只留最新一條)
          </div>
          {rules.length === 0 ? <p className="hint" style={{ margin: "0 0 10px" }}>還沒託管任何規則。</p> : (
            <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 10 }}>
              <tbody>
                {rules.map((r) => (
                  <tr key={r.id}>
                    <td className="mono" style={{ padding: "4px 6px", fontSize: 11.5, borderBottom: "1px solid var(--line-3)" }}>
                      {r.device}.{r.tag}
                    </td>
                    <td className="mono" style={{ padding: "4px 6px", fontSize: 11.5, borderBottom: "1px solid var(--line-3)" }}>
                      {r.agg === "ema" ? `EMA(${r.window_s}s)` : "原始值"} {r.op} {r.threshold}
                    </td>
                    <td className="mono" style={{ padding: "4px 6px", fontSize: 11.5, borderBottom: "1px solid var(--line-3)" }}>持續 {r.for_s}s</td>
                    <td style={{ padding: "4px 6px", borderBottom: "1px solid var(--line-3)", textAlign: "right" }}>
                      <button className="btn" style={{ padding: "2px 8px", fontSize: 11 }}
                              onClick={() => deleteAlarmRule(r.id).then(refresh).catch(() => setMsg("刪除失敗"))}>刪除</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="mono" style={{ fontSize: 11, color: "var(--dim)", marginBottom: 4 }}>最近告警</div>
          {alerts.length === 0 ? <p className="hint" style={{ margin: 0 }}>還沒有告警。</p> : (
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              {alerts.slice(0, 6).map((a) => (
                <div key={a.id} className="mono" style={{ fontSize: 11.5, color: "var(--text-2)" }}>
                  <span style={{ color: "var(--warn)" }}>●</span> {a.device}.{a.tag} = {a.value}
                  <span className="muted"> @ sim {(a.sim_t / 3600).toFixed(1)}h</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
