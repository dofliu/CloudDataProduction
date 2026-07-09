import { useEffect, useMemo, useState } from "react";
import { Catalog, SubmissionResult, postSubmission, getSubmissions, getCourseStatus } from "../api";

/**
 * 📤 繳交作業(自動批改)—— 學生把算出的結果送上來,平台對 ground-truth 容差計分。
 * 四型別對應課程規劃:connect(W2)/ stats(W4·期中)/ oee(W11)/ anomaly(W6)。
 * 目的是讓沒有電腦教室、人多無助教的課,作業能即時自動回饋與計分。
 */

type SubType = "connect" | "stats" | "oee" | "anomaly";
const TYPES: { key: SubType; label: string; hint: string }[] = [
  { key: "connect", label: "連線讀值 · W2", hint: "交某設備某 tag 的即時讀值,驗證你連對了。" },
  { key: "stats", label: "敘述統計 · W4/期中", hint: "交一段時間某 tag 的統計(mean/std),對照當週資料窗真值。" },
  { key: "oee", label: "OEE 指標 · W11", hint: "交你算出的 OEE / 可用率 / 表現 / 良率,對照平台累積值。" },
  { key: "anomaly", label: "異常判斷 · W6", hint: "勾出你判斷為異常的設備,對照本週實際被動手腳的設備(F1)。" },
];

export default function SubmissionForm({
  student, deviceIds, catalog,
}: { student: string; deviceIds: string[]; catalog: Catalog | null }) {
  const [type, setType] = useState<SubType>("connect");
  const [device, setDevice] = useState(deviceIds[0] || "");
  const [tag, setTag] = useState("");
  const [metric, setMetric] = useState("mean");
  const [metricOee, setMetricOee] = useState("oee");
  const [value, setValue] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [week, setWeek] = useState<string>("");
  const [result, setResult] = useState<SubmissionResult | null>(null);
  const [history, setHistory] = useState<SubmissionResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => { if (!device && deviceIds.length) setDevice(deviceIds[0]); }, [deviceIds]);
  useEffect(() => {
    getCourseStatus().then((s) => { if (s.current_week != null) setWeek(String(s.current_week)); }).catch(() => {});
  }, []);
  const refreshHistory = () => getSubmissions(student).then((r) => setHistory(r.submissions)).catch(() => {});
  useEffect(() => { if (student) refreshHistory(); }, [student]);

  const tags = useMemo(() => {
    const d = catalog?.devices.find((x) => x.id === device);
    return d ? d.tags.map((t) => t.name) : [];
  }, [catalog, device]);
  useEffect(() => { if (tags.length && !tags.includes(tag)) setTag(tags[0]); }, [tags]);

  const submit = async () => {
    setErr(""); setResult(null); setBusy(true);
    try {
      const payload: Record<string, any> = { student, type };
      if (week) payload.week = Number(week);
      if (type === "anomaly") {
        payload.devices = [...picked];
      } else {
        payload.device = device;
        if (type === "connect" || type === "stats") payload.tag = tag;
        if (type === "stats") payload.metric = metric;
        if (type === "oee") payload.metric = metricOee;
        const num = parseFloat(value);
        if (Number.isNaN(num)) { setErr("請輸入數字結果"); setBusy(false); return; }
        payload.value = num;
      }
      const r = await postSubmission(payload);
      setResult(r);
      refreshHistory();
    } catch (e: any) {
      setErr(String(e.message).includes("400") ? "欄位不完整或型別不符,檢查後再送" : `送出失敗:${e.message}`);
    } finally { setBusy(false); }
  };

  const active = TYPES.find((t) => t.key === type)!;

  return (
    <div className="card" style={{ marginTop: 12 }}>
      {/* 型別選擇 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        {TYPES.map((t) => (
          <button key={t.key} className={`chip${type === t.key ? " on" : ""}`} onClick={() => { setType(t.key); setResult(null); setErr(""); }}
                  style={{ cursor: "pointer", fontSize: 12 }}>{t.label}</button>
        ))}
      </div>
      <div className="hint" style={{ margin: "0 0 10px" }}>{active.hint}</div>

      {/* 欄位 */}
      <div style={{ display: "flex", gap: 8, alignItems: "end", flexWrap: "wrap" }}>
        <F label="週次"><input className="inp" value={week} onChange={(e) => setWeek(e.target.value)} placeholder="週" style={{ width: 56 }} /></F>

        {type !== "anomaly" && (
          <F label="設備">
            <select className="inp" value={device} onChange={(e) => setDevice(e.target.value)}>
              {deviceIds.map((d) => <option key={d}>{d}</option>)}
            </select>
          </F>
        )}

        {(type === "connect" || type === "stats") && (
          <F label="tag">
            <select className="inp" value={tag} onChange={(e) => setTag(e.target.value)}>
              {tags.map((t) => <option key={t}>{t}</option>)}
            </select>
          </F>
        )}

        {type === "stats" && (
          <F label="統計量">
            <select className="inp" value={metric} onChange={(e) => setMetric(e.target.value)}>
              <option value="mean">mean 平均</option><option value="std">std 標準差</option>
            </select>
          </F>
        )}

        {type === "oee" && (
          <F label="指標">
            <select className="inp" value={metricOee} onChange={(e) => setMetricOee(e.target.value)}>
              <option value="oee">OEE</option><option value="availability">可用率</option>
              <option value="performance">表現</option><option value="quality">良率</option>
            </select>
          </F>
        )}

        {type !== "anomaly" && (
          <F label="你算出的值"><input className="inp mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="數字" style={{ width: 110 }} /></F>
        )}

        <button className="btn primary" onClick={submit} disabled={busy || (type === "anomaly" && picked.size === 0 && false)}>
          {busy ? "評分中…" : "送出並自動批改"}
        </button>
      </div>

      {/* anomaly:勾選設備 */}
      {type === "anomaly" && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
          {deviceIds.map((d) => {
            const on = picked.has(d);
            return (
              <button key={d} className={`chip${on ? " on" : ""}`} style={{ cursor: "pointer" }}
                onClick={() => setPicked((p) => { const n = new Set(p); n.has(d) ? n.delete(d) : n.add(d); return n; })}>
                {on ? "●" : "○"} {d}
              </button>
            );
          })}
          {deviceIds.length === 0 && <span className="hint" style={{ margin: 0 }}>你的公司沒有可判斷的設備。</span>}
        </div>
      )}

      {err && <div style={{ marginTop: 8, color: "var(--fault)", fontSize: 12 }}>{err}</div>}

      {/* 結果 */}
      {result && (
        <div style={{ marginTop: 12, padding: "10px 12px", borderRadius: 8,
                      border: `1px solid ${result.passed ? "#2f7a4f" : "#6b2f34"}`,
                      background: result.passed ? "#13241b" : "#1e1416", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ fontSize: 26, fontWeight: 800, color: result.passed ? "#37d67a" : "#e0503f" }}>{result.score}</div>
          <div style={{ minWidth: 0 }}>
            <span className="badge" style={{ background: result.passed ? "#37d67a" : "#e0503f" }}>{result.passed ? "通過" : "未過"}</span>
            <div className="hint" style={{ margin: "4px 0 0" }}>{result.feedback}</div>
          </div>
        </div>
      )}

      {/* 我的繳交紀錄 */}
      {history.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="sec-label" style={{ marginTop: 0 }}>我的繳交紀錄</div>
          <div style={{ display: "grid", gap: 4 }}>
            {history.slice(0, 6).map((s) => (
              <div key={s.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--text-2)" }}>
                <span className="mono">{s.type}{s.week != null ? ` · W${s.week}` : ""}</span>
                <span style={{ color: s.passed ? "#37d67a" : "#e0503f", fontWeight: 600 }}>{s.score} {s.passed ? "✓" : "✗"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function F({ label, children }: { label: string; children: any }) {
  return <div><div className="muted" style={{ fontSize: 10.5, marginBottom: 3 }}>{label}</div>{children}</div>;
}
