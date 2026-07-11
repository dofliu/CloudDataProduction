import { useEffect, useMemo, useState } from "react";
import { Catalog, SubmissionResult, postSubmission, getSubmissions, getCourseStatus } from "../api";

/**
 * 📤 繳交作業(自動批改)—— 學生把算出的結果送上來,平台對 ground-truth 容差計分。
 * 四型別對應課程規劃:connect(W2)/ stats(W4·期中)/ oee(W11)/ anomaly(W6)。
 * 目的是讓沒有電腦教室、人多無助教的課,作業能即時自動回饋與計分。
 */

type SubType = "connect" | "stats" | "aggregate" | "anomaly" | "events" | "oee"
  | "correlation" | "rul" | "root_cause" | "slope" | "count_over";
type Tier = "基礎" | "進階";
const TYPES: { key: SubType; label: string; tier: Tier; hint: string }[] = [
  { key: "connect", label: "連線讀值 · W2", tier: "基礎", hint: "交某設備某 tag 的即時讀值,驗證你連對了。" },
  { key: "stats", label: "敘述統計 · W4/期中", tier: "基礎", hint: "交某 tag 的統計(mean/std/min/max/median/p95),對照當週資料窗真值。" },
  { key: "anomaly", label: "異常判斷 · W6", tier: "基礎", hint: "勾出你判斷為異常的設備,對照本週實際被動手腳的設備(F1)。" },
  { key: "count_over", label: "越界計數 · W6/8", tier: "基礎", hint: "資料窗內某 tag 超過門檻的樣本數;自己過濾計數。" },
  { key: "events", label: "事件流 · W10", tier: "基礎", hint: "交本週該設備的完工工單數(訂閱事件 / 計 done),對照 MES 實際完工數。" },
  { key: "aggregate", label: "時序聚合 · W7", tier: "進階", hint: "交某 tag 在某小時(0–23)的平均,對照依 hour-of-day 重取樣的真值。" },
  { key: "slope", label: "趨勢斜率 · W7/13", tier: "進階", hint: "某 tag 的線性趨勢斜率(每小時變化量),用最小平方法擬合。" },
  { key: "correlation", label: "訊號相關 · W8", tier: "進階", hint: "交兩個 tag 的皮爾森相關係數 r;要自己撈兩條序列、對齊、算相關。" },
  { key: "root_cause", label: "根因判斷 · W8", tier: "進階", hint: "判斷某設備異常是「感測器故障」還是「設備故障」。" },
  { key: "oee", label: "OEE 指標 · W11", tier: "進階", hint: "交你算出的 OEE / 可用率 / 表現 / 良率,對照平台累積值。" },
  { key: "rul", label: "剩餘壽命 RUL · W14", tier: "進階", hint: "估計某設備距故障還有幾小時;正解不公開(隱藏狀態),靠退化趨勢推。" },
];

export default function SubmissionForm({
  student, deviceIds, catalog,
}: { student: string; deviceIds: string[]; catalog: Catalog | null }) {
  const [type, setType] = useState<SubType>("connect");
  const [device, setDevice] = useState(deviceIds[0] || "");
  const [tag, setTag] = useState("");
  const [metric, setMetric] = useState("mean");
  const [metricOee, setMetricOee] = useState("oee");
  const [hour, setHour] = useState("14");
  const [threshold, setThreshold] = useState("6");
  const [tagB, setTagB] = useState("");
  const [cause, setCause] = useState<"sensor" | "equipment">("equipment");
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
      } else if (type === "root_cause") {
        payload.device = device;
        payload.cause = cause;
      } else {
        payload.device = device;
        if (["connect", "stats", "aggregate", "correlation", "slope", "count_over"].includes(type)) payload.tag = tag;
        if (type === "correlation") { payload.tag_a = tag; payload.tag_b = tagB; }
        if (type === "stats") payload.metric = metric;
        if (type === "oee") payload.metric = metricOee;
        if (type === "aggregate") payload.hour = Number(hour);
        if (type === "count_over") payload.threshold = Number(threshold);
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
                  style={{ cursor: "pointer", fontSize: 12, display: "inline-flex", alignItems: "center", gap: 5 }}>
            {t.label}
            <span style={{ fontSize: 9.5, padding: "0 5px", borderRadius: 8, fontWeight: 700,
                           color: t.tier === "進階" ? "#f0883c" : "#8a94a6",
                           background: t.tier === "進階" ? "rgba(240,136,60,.14)" : "var(--panel-2)" }}>{t.tier}</span>
          </button>
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

        {["connect", "stats", "aggregate", "correlation", "slope", "count_over"].includes(type) && (
          <F label={type === "correlation" ? "tag A" : "tag"}>
            <select className="inp" value={tag} onChange={(e) => setTag(e.target.value)}>
              {tags.map((t) => <option key={t}>{t}</option>)}
            </select>
          </F>
        )}

        {type === "correlation" && (
          <F label="tag B">
            <select className="inp" value={tagB} onChange={(e) => setTagB(e.target.value)}>
              <option value="">— 選另一個 —</option>
              {tags.map((t) => <option key={t}>{t}</option>)}
            </select>
          </F>
        )}

        {type === "root_cause" && (
          <F label="根因">
            <select className="inp" value={cause} onChange={(e) => setCause(e.target.value as "sensor" | "equipment")}>
              <option value="equipment">設備故障(健康度退化)</option>
              <option value="sensor">感測器故障(讀值脫鉤)</option>
            </select>
          </F>
        )}

        {type === "aggregate" && (
          <F label="小時 0–23"><input className="inp mono" value={hour} onChange={(e) => setHour(e.target.value)} style={{ width: 56 }} /></F>
        )}

        {type === "stats" && (
          <F label="統計量">
            <select className="inp" value={metric} onChange={(e) => setMetric(e.target.value)}>
              <option value="mean">mean 平均</option><option value="std">std 標準差</option>
              <option value="min">min 最小</option><option value="max">max 最大</option>
              <option value="median">median 中位</option><option value="p95">p95 95百分位</option>
            </select>
          </F>
        )}

        {type === "count_over" && (
          <F label="門檻 >"><input className="inp mono" value={threshold} onChange={(e) => setThreshold(e.target.value)} style={{ width: 70 }} /></F>
        )}

        {type === "oee" && (
          <F label="指標">
            <select className="inp" value={metricOee} onChange={(e) => setMetricOee(e.target.value)}>
              <option value="oee">OEE</option><option value="availability">可用率</option>
              <option value="performance">表現</option><option value="quality">良率</option>
            </select>
          </F>
        )}

        {type !== "anomaly" && type !== "root_cause" && (
          <F label={type === "correlation" ? "相關 r (−1~1)" : type === "rul" ? "估計 (小時)"
                    : type === "slope" ? "斜率 /小時" : type === "count_over" ? "樣本數" : "你算出的值"}>
            <input className="inp mono" value={value} onChange={(e) => setValue(e.target.value)} placeholder="數字" style={{ width: 110 }} /></F>
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
