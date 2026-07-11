import { useEffect, useState } from "react";
import {
  Park, TelemetryMsg, HealthGT, Ticket, ScoreRow, PredScoreRow, ScenarioScript, ScenarioStatus,
  CourseWeek, CourseStatus, GradebookRow,
  setTeacherToken, getTeacherToken, setClock,
  injectFault, resetDevice, getHealth, getTickets, ackTicket, resolveTicket, getScores, getPredictionScores,
  getScenarios, runScenario, stopScenario, createFactory, resetSession,
  getCourseWeeks, getCourseStatus, applyCourseWeek, getGradebook,
  UserRow, listUsers, createUsers, resetUserPassword, deleteUser,
  StudentOverviewRow, getStudentsOverview, StudentDetail, getStudentDetail,
} from "../api";
import ClassroomTeacherPanel from "./ClassroomTeacherPanel";

const FAULT_TYPES = [
  "gradual", "sudden", "intermittent", "cascading",
  "sensor_drift", "sensor_stuck", "sensor_bias", "sensor_noise", "sensor_dropout",
];

export default function TeacherView({
  park, telemetry, onParkChanged,
}: { park: Park; telemetry: TelemetryMsg | null; onParkChanged: () => void }) {
  const [token, setTok] = useState(getTeacherToken());
  const [dev, setDev] = useState<string>("");
  const [ftype, setFtype] = useState("gradual");
  const [target, setTarget] = useState("");
  const [severity, setSeverity] = useState(1.0);
  const [msg, setMsg] = useState("");
  const [clockMult, setClockMult] = useState<number | null>(null);

  const [health, setHealth] = useState<HealthGT | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [scores, setScores] = useState<ScoreRow[]>([]);
  const [predScores, setPredScores] = useState<PredScoreRow[]>([]);
  const [scripts, setScripts] = useState<ScenarioScript[]>([]);
  const [scenStatus, setScenStatus] = useState<ScenarioStatus | null>(null);
  const [scenName, setScenName] = useState("disaster_day");
  const [factoryDesc, setFactoryDesc] = useState("建一間有 3 台機械手臂的公司");
  const [courseWeeks, setCourseWeeks] = useState<CourseWeek[]>([]);
  const [courseStatus, setCourseStatus] = useState<CourseStatus | null>(null);
  const [gradebook, setGradebook] = useState<GradebookRow[]>([]);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [roster, setRoster] = useState("s001, pw001\ns002, pw002");
  const [newRole, setNewRole] = useState<"student" | "teacher">("student");
  const [overview, setOverview] = useState<StudentOverviewRow[]>([]);
  const [detail, setDetail] = useState<StudentDetail | null>(null);

  const deviceIds = telemetry ? Object.keys(telemetry.devices) : [];
  const isSensor = ftype.startsWith("sensor_");
  // 目標選項:感測器故障 → tag;設備故障 → 退化元件(從 ground-truth)
  const targetOpts = isSensor
    ? (telemetry && dev ? Object.keys(telemetry.devices[dev]?.tags ?? {}) : [])
    : (health?.components.map((c) => c.name) ?? []);

  useEffect(() => { if (!dev && deviceIds.length) setDev(deviceIds[0]); }, [deviceIds, dev]);

  // 輪詢 ground-truth / 工單 / 評分
  useEffect(() => {
    const tick = async () => {
      try { if (dev) setHealth(await getHealth(dev)); } catch { /* token 未設會 401 */ }
      try { setTickets((await getTickets()).tickets); } catch { /* */ }
      try { setScores((await getScores()).ranking); } catch { /* */ }
      try { setPredScores((await getPredictionScores()).ranking); } catch { /* */ }
      try { const s = await getScenarios(); setScripts(s.scripts); setScenStatus(s.status); } catch { /* */ }
      try { setCourseStatus(await getCourseStatus()); } catch { /* */ }
      try { setGradebook((await getGradebook()).gradebook); } catch { /* */ }
      try { setUsers((await listUsers()).users); } catch { /* 未登入教師會 401 */ }
      try { setOverview((await getStudentsOverview()).students); } catch { /* */ }
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => clearInterval(id);
  }, [dev]);

  useEffect(() => { getCourseWeeks().then((r) => setCourseWeeks(r.weeks)).catch(() => {}); }, []);

  const doApplyWeek = async (n: number) => {
    try {
      const r = await applyCourseWeek(n);
      setMsg(`📅 已套用第 ${r.applied_week} 週「${r.title}」— 異常 ${r.faults === "injected" ? `注入 ${r.injected.length} 台` : r.faults} · 稼動率 ${r.utilization}`);
      setCourseStatus(await getCourseStatus());
    } catch (e: any) {
      const hint = String(e.message).includes("401") ? "先填 dev-teacher-token 並儲存" : "";
      setMsg(`套用失敗:${e.message} ${hint}`);
    }
  };

  const doCreateRoster = async () => {
    const list = roster.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const p = l.split(/[,\s]+/);
      return { username: p[0], password: p[1] || p[0] };
    }).filter((u) => u.username);
    if (!list.length) { setMsg("名冊是空的(一行一個:帳號, 密碼)"); return; }
    try {
      const r = await createUsers(list, newRole);
      setMsg(`✅ 已建立 ${r.created.length} 個${newRole === "teacher" ? "教師" : "學生"}帳號${r.skipped.length ? `,略過 ${r.skipped.length}(已存在/格式錯)` : ""}`);
      setUsers((await listUsers()).users);
    } catch (e: any) {
      const hint = String(e.message).includes("401") ? "先填 dev-teacher-token / 教師帳號登入" : "";
      setMsg(`建帳號失敗:${e.message} ${hint}`);
    }
  };
  const doResetPw = async (u: string) => {
    const pw = window.prompt(`重設「${u}」的新密碼:`);
    if (!pw) return;
    try { await resetUserPassword(u, pw); setMsg(`已重設 ${u} 密碼`); } catch (e: any) { setMsg(`重設失敗:${e.message}`); }
  };
  const doDeleteUser = async (u: string) => {
    if (!window.confirm(`刪除帳號「${u}」?其登入將立即失效。`)) return;
    try { await deleteUser(u); setUsers((await listUsers()).users); setMsg(`已刪除 ${u}`); } catch (e: any) { setMsg(`刪除失敗:${e.message}`); }
  };
  const openDetail = async (u: string) => {
    try { setDetail(await getStudentDetail(u)); } catch (e: any) { setMsg(`讀取細項失敗:${e.message}`); }
  };
  const exportCsv = () => {
    const head = ["學生", "有帳號", "認領公司", "作業完成", "平均分", "工單開", "工單結", "預測送", "預測命中"];
    const rows = overview.map((s) => [s.student, s.has_account ? "是" : "否", s.company?.name ?? "",
      s.assignments_done, s.avg_score ?? "", s.tickets_open, s.tickets_resolved, s.predictions, s.pred_hits]);
    const csv = [head, ...rows].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });   // BOM:Excel 正確顯示中文
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "學生成績總覽.csv"; a.click();
    URL.revokeObjectURL(a.href);
    setMsg(`已匯出 ${overview.length} 位學生成績 CSV`);
  };

  const saveToken = () => { setTeacherToken(token); setMsg("已儲存 teacher token"); };

  const doInject = async () => {
    try {
      await injectFault({ device: dev, fault_type: ftype, target, severity });
      setMsg(`已注入 ${ftype} → ${dev}.${target}（severity ${severity}）`);
    } catch (e: any) {
      const hint = String(e.message).includes("401")
        ? "token 不符,請填 .env 的 TEACHER_TOKEN(預設 dev-teacher-token)並按儲存"
        : "檢查 target 是否選對";
      setMsg(`注入失敗:${e.message} — ${hint}`);
    }
  };
  const doReset = async () => {
    try { await resetDevice(dev); setMsg(`已 reset ${dev}`); }
    catch (e: any) { setMsg(`reset 失敗:${e.message}`); }
  };
  // 課堂 demo:對此設備第一個(本體)退化元件注入快速劣化,高時間倍率下幾分鐘內故障 → 學生立刻有工單可練。
  const doQuickFault = async () => {
    const comp = health?.components?.[0]?.name;
    if (!dev || !comp) { setMsg("請先選設備,並等 ground-truth 載入(需 teacher token)"); return; }
    try {
      await injectFault({ device: dev, fault_type: "gradual", target: comp, severity: 1.0 });
      setMsg(`⚡ 已對 ${dev}.${comp} 注入快速劣化 — 把時鐘調 600×/3600× 加速,幾分鐘內會故障並自動開單`);
    } catch (e: any) {
      const hint = String(e.message).includes("401") ? "先填 dev-teacher-token 並儲存" : "";
      setMsg(`快速故障失敗:${e.message} ${hint}`);
    }
  };
  const doResetSession = async () => {
    if (!window.confirm("重置課堂資料?\n將清空所有公司認領、工單、階段二預測、OEE 累積,並把所有設備修回健康。\n(不刪 DB 檔;適合換班 / 下堂課歸零)")) return;
    try {
      const r = await resetSession();
      const c = r.cleared || {};
      setMsg(`🧹 已重置課堂資料:認領 ${c.claims ?? 0} · 工單 ${c.tickets ?? 0} · 預測 ${c.predictions ?? 0} · OEE ${c.oee_reset ?? 0} 台 · 設備修復 ${c.devices_reset ?? 0} 台`);
    } catch (e: any) {
      const hint = String(e.message).includes("401") ? "先填 dev-teacher-token / .env 的 TEACHER_TOKEN 並儲存" : "";
      setMsg(`重置失敗:${e.message} ${hint}`);
    }
  };
  const doFactory = async () => {
    try {
      const r = await createFactory(factoryDesc);
      const via = r?.via === "llm" ? "🤖 AI 解析" : "規則式";
      setMsg(`已建廠(${via}):${r?.summary ?? r?.name ?? "新公司"}（2D 世界 + Modbus/OPC-UA/MQTT 皆即時上線,免重啟)`);
      onParkChanged();   // 重抓 park → 2D 世界 / 目錄 / OEE 顯示新公司
    } catch (e: any) {
      const hint = String(e.message).includes("401") ? "先填 dev-teacher-token 並儲存"
        : String(e.message).includes("422") ? "描述需含設備類型(CNC/空壓機/AGV/機械手臂)與數量" : "";
      setMsg(`建廠失敗:${e.message} ${hint}`);
    }
  };

  const clk = (m: number) => { setClock({ multiplier: m }); setClockMult(m); };

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <h2 style={{ margin: 0 }}>教師控制台 · 上帝視角</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <input className="inp" value={token} onChange={(e) => setTok(e.target.value)} placeholder="dev-teacher-token" style={{ width: 150 }} />
          <button className="btn ghost" onClick={saveToken}>儲存</button>
          {getTeacherToken() && <span className="pill" style={{ color: "var(--warn)", borderColor: "#5a4a1e", background: "#241d0c" }}>🔑 已載入</span>}
          <span className="muted" style={{ fontSize: 11 }}>倍率</span>
          {[60, 600, 3600].map((m) => (
            <button key={m} className={`btn ghost${clockMult === m ? " speed-active" : ""}`} onClick={() => clk(m)}
              style={clockMult === m ? { background: "#14304d", borderColor: "var(--accent)", color: "var(--accent)" } : {}}>{m}×</button>
          ))}
          <button className="btn ghost" onClick={() => setClock({ paused: true })}>⏸</button>
          <button className="btn ghost" onClick={() => setClock({ paused: false })}>▶</button>
        </div>
      </div>

      <div style={{ display: "flex", gap: 18, alignItems: "flex-start" }}>
        {/* 左:actions */}
        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 14 }}>
          <div className="card">
            <div className="card-title">📅 課程情境(每週釋出)</div>
            <div className="hint" style={{ margin: "0 0 8px" }}>
              一鍵套用當週條件(設異常 / 訂單密度,並記錄「這週的資料窗」給學生作業比對)。
              目前:{courseStatus?.current_week != null
                ? <b style={{ color: "var(--accent)" }}>第 {courseStatus.current_week} 週「{courseStatus.title}」· 稼動率 {courseStatus.utilization}</b>
                : <span className="muted">尚未套用(自由運轉)</span>}
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {courseWeeks.length === 0 && <span className="muted" style={{ fontSize: 12 }}>(讀不到 scenarios/course_weeks.yaml)</span>}
              {courseWeeks.map((w) => {
                const active = courseStatus?.current_week === w.week;
                return (
                  <button key={w.week} className="btn ghost" onClick={() => doApplyWeek(w.week)}
                    title={`異常:${w.faults} · 密度:${w.order_density ?? "—"}`}
                    style={active ? { background: "#14304d", borderColor: "var(--accent)", color: "var(--accent)" } : {}}>
                    第{w.week}週 · {w.title}
                    <span style={{ marginLeft: 6, fontSize: 10, color: w.faults === "injected" ? "var(--fault)" : w.faults === "clear" ? "var(--ok)" : "var(--dim)" }}>
                      {w.faults === "injected" ? "●異常" : w.faults === "clear" ? "○正常" : "—沿用"}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <ClassroomTeacherPanel onMsg={setMsg} />

          <div className="card">
            <div className="card-title">👥 帳號管理(名冊)</div>
            <div className="hint" style={{ margin: "0 0 8px" }}>
              一行一個「帳號, 密碼」批次建立(密碼省略則同帳號)。學生用帳密登入,只看得到任務中心 / 目錄 / 學生面,且只能改自己認領公司的設備;教師帳號可進控制台。
            </div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <span className="muted" style={{ fontSize: 11.5 }}>建立角色:</span>
              {(["student", "teacher"] as const).map((r) => (
                <button key={r} className={`chip${newRole === r ? " on" : ""}`} style={{ cursor: "pointer" }} onClick={() => setNewRole(r)}>
                  {r === "student" ? "🎓 學生" : "🧑‍🏫 教師"}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
              <textarea className="inp mono" value={roster} onChange={(e) => setRoster(e.target.value)}
                        rows={4} style={{ flex: 1, minWidth: 220, resize: "vertical", fontSize: 12 }} placeholder={"s001, pw001\ns002, pw002"} />
              <button className="btn" style={{ background: "var(--ok)", color: "#08121e" }} onClick={doCreateRoster}>
                ＋ 建立{newRole === "teacher" ? "教師" : "學生"}
              </button>
            </div>
            {users.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <div className="sec-label" style={{ marginTop: 0 }}>已建帳號 · {users.length}</div>
                <div style={{ maxHeight: 132, overflowY: "auto", display: "grid", gap: 3 }}>
                  {users.map((u) => (
                    <div key={u.username} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                      <span className="mono" style={{ flex: 1 }}>{u.username}</span>
                      <span className="pill" style={{ fontSize: 10, padding: "1px 7px",
                            color: u.role === "teacher" ? "var(--warn)" : "var(--text-2)" }}>{u.role}</span>
                      <button className="btn ghost" style={{ padding: "1px 7px", fontSize: 11 }} onClick={() => doResetPw(u.username)}>改密碼</button>
                      <button className="btn ghost" style={{ padding: "1px 7px", fontSize: 11, color: "var(--fault)" }} onClick={() => doDeleteUser(u.username)}>刪</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">🏭 建廠(自然語言)</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input className="inp" value={factoryDesc} onChange={(e) => setFactoryDesc(e.target.value)}
                     placeholder="例:半導體封裝廠,3 台手臂 + 2 台製程腔體 + 1 台電表" style={{ flex: 1, minWidth: 260 }} />
              <button className="btn" style={{ background: "var(--ok)", color: "#08121e" }} onClick={doFactory}>＋ 建立公司</button>
            </div>
            <div className="hint" style={{ margin: "6px 0 0" }}>
              設了 Gemini key → 🤖 AI 解析自由描述、可<b>多型別混搭</b>;否則規則式(單一型別 + 數量)。建立後即時長出新公司(三協定免重啟)。
            </div>
          </div>

          <div className="card">
            <div className="card-title">⚠ 注入故障</div>
            <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
              <Field label="設備"><select className="inp" value={dev} onChange={(e) => setDev(e.target.value)}>{deviceIds.map((d) => <option key={d}>{d}</option>)}</select></Field>
              <Field label="故障型態"><select className="inp" value={ftype} onChange={(e) => { setFtype(e.target.value); setTarget(""); }}>{FAULT_TYPES.map((f) => <option key={f}>{f}</option>)}</select></Field>
              <Field label={isSensor ? "目標 tag" : "目標元件"}><select className="inp" value={target} onChange={(e) => setTarget(e.target.value)}><option value="">— 選擇 —</option>{targetOpts.map((t) => <option key={t}>{t}</option>)}</select></Field>
              <Field label="severity"><input className="inp" type="number" min={0} max={1} step={0.1} value={severity} onChange={(e) => setSeverity(parseFloat(e.target.value))} style={{ width: 68 }} /></Field>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <button className="btn" style={{ background: "var(--fault)", color: "#fff" }} disabled={!dev || !target} onClick={doInject}>注入</button>
              <button className="btn" style={{ background: "var(--pred)", color: "#08121e" }} disabled={!dev || !health?.components?.length}
                      onClick={doQuickFault} title="對此設備主元件注入快速劣化,課堂 demo 用">⚡ 快速故障(demo)</button>
              <button className="btn ghost" onClick={doReset}>reset 設備</button>
            </div>
            <div className="hint" style={{ margin: "6px 0 0" }}>選運轉中機台 → ⚡ 快速故障 → 時鐘 600×↑ → 幾分鐘內故障自動開單,學生即可練。</div>
            {msg && <div style={{ marginTop: 8, color: "var(--accent)", fontSize: 12 }}>{msg}</div>}
          </div>

          <div className="card">
            <div className="card-title">🎬 情境腳本(期末測驗)</div>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <select className="inp" value={scenName} onChange={(e) => setScenName(e.target.value)}>{scripts.map((s) => <option key={s.name} value={s.name}>{s.name}({s.steps} 步)</option>)}</select>
              <button className="btn" style={{ background: "var(--pred)", color: "#08121e" }} disabled={!!scenStatus?.running}
                      onClick={async () => { try { await runScenario(scenName); setMsg(`已啟動情境 ${scenName}`); } catch (e: any) { setMsg(`啟動失敗:${e.message}`); } }}>▶ 執行</button>
              <button className="btn ghost" onClick={async () => { await stopScenario(); setMsg("已停止情境"); }}>停止</button>
              {scenStatus?.running && <span style={{ color: "var(--pred)", fontSize: 12 }}>● 執行中:{scenStatus.running}</span>}
            </div>
            {scripts.find((s) => s.name === scenName) && <div className="hint" style={{ margin: "6px 0 0" }}>{scripts.find((s) => s.name === scenName)!.description}</div>}
            {scenStatus && scenStatus.log.length > 0 && (
              <div className="mono" style={{ marginTop: 6, fontSize: 11, color: "var(--muted)" }}>
                {scenStatus.log.slice(0, 6).map((l, i) => <div key={i}>{(l.sim_t / 3600).toFixed(1)}h · {l.message}</div>)}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-title">🔬 Ground-truth · <span className="mono" style={{ fontWeight: 400 }}>{dev}</span></div>
            {health ? (
              <>
                <div className="hint" style={{ margin: "0 0 6px" }}>
                  state=<b>{health.state}</b> · RUL={health.rul_sim_s === null ? "—" : (health.rul_sim_s / 3600).toFixed(1)}h
                  {health.is_sensor_fault && <span style={{ color: "var(--warn)" }}> · 含感測器故障 {Object.keys(health.sensor_faults).join(",")}</span>}
                </div>
                {health.components.map((c) => (
                  <div key={c.name} style={{ display: "flex", alignItems: "center", gap: 10, margin: "5px 0" }}>
                    <span style={{ width: 150, fontSize: 12 }}>{c.name}</span>
                    <div style={{ flex: 1, maxWidth: 300, background: "var(--line-3)", borderRadius: 4, height: 8, overflow: "hidden" }}>
                      <div style={{ width: `${c.health * 100}%`, height: "100%", borderRadius: 4, transition: "width .3s ease",
                        background: c.health > 0.5 ? "var(--ok)" : c.health > 0.2 ? "var(--warn)" : "var(--fault)" }} />
                    </div>
                    <span className="mono" style={{ width: 70, textAlign: "right", fontSize: 12 }}>h={c.health.toFixed(2)}</span>
                  </div>
                ))}
              </>
            ) : <div className="hint" style={{ margin: 0 }}>(設好 token 後顯示隱藏健康狀態)</div>}
          </div>
        </div>

        {/* 右:工單 / 評分 / 重置 */}
        <div style={{ width: 452, flex: "0 0 452px", display: "grid", gap: 14 }}>
          <div className="card" style={{ padding: "12px 14px" }}>
            <div className="card-title">🎫 工單板</div>
            <MiniTable head={["單號", "設備", "元件", "狀態", "MTTR", "處置"]}
              rows={tickets.slice(0, 12).map((t) => [
                t.id, t.device, t.component ?? "—",
                <span key="s" className="badge" style={{ background: t.status === "resolved" ? "var(--ok)" : t.status === "acked" ? "var(--warn)" : "var(--fault)", fontSize: 10 }}>{t.status}</span>,
                t.mttr_sim_s !== null ? (t.mttr_sim_s / 3600).toFixed(1) + "h" : "—",
                <span key="a" style={{ display: "flex", gap: 4 }}>
                  <button className="btn ghost" style={{ padding: "2px 7px", fontSize: 11 }} onClick={() => ackTicket(t.id)}>ack</button>
                  <button className="btn" style={{ padding: "2px 7px", fontSize: 11, background: "var(--ok)", color: "#08121e" }} onClick={() => resolveTicket(t.id)}>fix</button>
                </span>,
              ])} empty="尚無工單" />
          </div>

          <div className="card" style={{ padding: "12px 14px" }}>
            <div className="card-title">📊 故障管理評分榜</div>
            <MiniTable head={["#", "公司", "偵測", "解決", "漏", "分"]}
              rows={scores.map((s, i) => [String(i + 1), s.name, s.detected, s.resolved, s.missed, <b key="b">{s.score}</b>])} empty="尚無資料" />
          </div>

          <div className="card" style={{ padding: "12px 14px" }}>
            <div className="card-title">🔮 階段二預測榜(lead time)</div>
            <MiniTable head={["#", "學生", "命中", "誤報", "提前h", "分"]}
              rows={predScores.map((s, i) => [String(i + 1), s.student,
                <span key="h" style={{ color: "var(--ok)" }}>{s.hits}</span>,
                <span key="f" style={{ color: "var(--fault)" }}>{s.false_alarms}</span>,
                s.avg_lead_time_h ?? "—", <b key="b">{s.score}</b>])} empty="尚無預測(student_kit p3 上傳)" />
          </div>

          <div className="card" style={{ padding: "12px 14px" }}>
            <div className="card-title" style={{ justifyContent: "space-between" }}>
              <span>📋 學生進度總覽</span>
              <button className="btn ghost" style={{ padding: "3px 10px", fontSize: 11 }} onClick={exportCsv} disabled={!overview.length}>⬇ 匯出 CSV</button>
            </div>
            <MiniTable head={["學生", "認領", "作業", "工單", "預測"]}
              rows={overview.slice(0, 40).map((s) => [
                <button key="u" onClick={() => openDetail(s.student)} title="看細項"
                        style={{ background: "none", border: "none", padding: 0, color: "var(--accent)", cursor: "pointer",
                                 fontFamily: "var(--font-mono)", fontSize: 11.5, display: "flex", alignItems: "center", gap: 4 }}>
                  {s.has_account ? "" : <span title="無帳號(legacy)" style={{ color: "var(--dim)" }}>·</span>}{s.student}
                </button>,
                s.company ? <span key="c" title={`${s.company.devices} 台`}>{s.company.name}</span> : <span key="c" className="muted">—</span>,
                s.assignments_done > 0
                  ? <span key="a"><b style={{ color: (s.avg_score ?? 0) >= 60 ? "var(--ok)" : "var(--warn)" }}>{s.avg_score}</b> <span className="muted">({s.assignments_done})</span></span>
                  : <span key="a" className="muted">—</span>,
                (s.tickets_open + s.tickets_resolved) > 0
                  ? <span key="t"><span style={{ color: s.tickets_open ? "var(--fault)" : "var(--muted)" }}>{s.tickets_open}</span>/<span style={{ color: "var(--ok)" }}>{s.tickets_resolved}</span></span>
                  : <span key="t" className="muted">—</span>,
                s.predictions > 0 ? <span key="p"><span style={{ color: "var(--ok)" }}>{s.pred_hits}</span>/{s.predictions}</span> : <span key="p" className="muted">—</span>,
              ])} empty="尚無學生資料(建立帳號後,學生登入即出現)" />
            <div className="hint" style={{ margin: "6px 0 0" }}>作業=平均分(完成項數) · 工單=開/結 · 預測=命中/送出。</div>
          </div>

          <div className="card" style={{ padding: "12px 14px" }}>
            <div className="card-title">📗 作業成績冊(自動批改)</div>
            <MiniTable head={["#", "學生", "作業數", "平均"]}
              rows={gradebook.slice(0, 12).map((g, i) => [
                String(i + 1), g.student, g.count,
                <b key="b" style={{ color: g.avg >= 60 ? "var(--ok)" : "var(--warn)" }}>{g.avg}</b>,
              ])} empty="尚無繳交(學生任務中心可繳交作業)" />
            <div className="hint" style={{ margin: "6px 0 0" }}>每項作業取最佳分彙整平均;期末專題人工 rubric 另計後併入。</div>
          </div>

          <div className="card" style={{ borderColor: "#4a2620", background: "#160f10" }}>
            <div className="card-title" style={{ color: "var(--fault)" }}>🧹 重置課堂資料</div>
            <div className="hint" style={{ margin: "0 0 8px" }}>換班 / 下堂課歸零:清認領 / 工單 / 預測 / OEE,設備修回健康(不刪 DB)。</div>
            <button className="btn" style={{ background: "var(--fault)", color: "#fff" }} onClick={doResetSession}>🧹 重置課堂資料</button>
          </div>
        </div>
      </div>

      {detail && <StudentDetailModal detail={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function StudentDetailModal({ detail, onClose }: { detail: StudentDetail; onClose: () => void }) {
  const g: Record<string, SubmissionRow> = {};   // 每項作業取最佳分
  for (const s of detail.submissions) {
    const k = `${s.type}·W${s.week ?? "-"}`;
    if (!g[k] || s.score > g[k].score) g[k] = { key: k, score: s.score, passed: s.passed, feedback: s.feedback };
  }
  const assignments = Object.values(g).sort((a, b) => a.key.localeCompare(b.key));
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(4,8,14,0.66)", zIndex: 1100,
                  display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} className="card float" style={{ width: "min(620px,100%)", padding: "18px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <h2 style={{ margin: 0, fontSize: 17 }}>🎓 {detail.student}</h2>
          <button className="btn ghost" style={{ padding: "4px 12px" }} onClick={onClose}>✕ 關閉</button>
        </div>
        <div className="hint" style={{ margin: "0 0 12px" }}>
          認領:{detail.company ? <b style={{ color: "var(--accent)" }}>{detail.company.name}（{detail.company.device_ids.length} 台）</b> : "未認領"}
        </div>

        <div className="sec-label" style={{ marginTop: 0 }}>作業(每項最佳分) · {assignments.length}</div>
        {assignments.length ? (
          <div style={{ display: "grid", gap: 4, marginBottom: 12 }}>
            {assignments.map((a) => (
              <div key={a.key} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12.5 }}>
                <span className="mono" style={{ width: 130, flex: "0 0 130px" }}>{a.key}</span>
                <b style={{ color: a.passed ? "var(--ok)" : "var(--warn)", width: 42 }}>{a.score}</b>
                <span className="hint" style={{ margin: 0, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.feedback}</span>
              </div>
            ))}
          </div>
        ) : <div className="hint" style={{ margin: "0 0 12px" }}>尚無繳交</div>}

        <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
          <div>
            <div className="sec-label" style={{ marginTop: 0 }}>工單 · {detail.tickets.length}</div>
            {detail.tickets.length ? detail.tickets.slice(0, 8).map((t) => (
              <div key={t.id} style={{ fontSize: 12 }} className="mono">{t.device} · <span style={{ color: t.status === "resolved" ? "var(--ok)" : "var(--fault)" }}>{t.status}</span></div>
            )) : <div className="hint" style={{ margin: 0 }}>—</div>}
          </div>
          <div>
            <div className="sec-label" style={{ marginTop: 0 }}>預測 · {detail.predictions.length}</div>
            {detail.predictions.length ? detail.predictions.slice(0, 8).map((p: any, i: number) => (
              <div key={i} style={{ fontSize: 12 }} className="mono">{p.device} · <span style={{ color: p.status === "hit" ? "var(--ok)" : p.status === "false" ? "var(--fault)" : "var(--muted)" }}>{p.status}</span></div>
            )) : <div className="hint" style={{ margin: 0 }}>—</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
interface SubmissionRow { key: string; score: number; passed: boolean; feedback: string; }

function Field({ label, children }: { label: string; children: any }) {
  return <div><div className="muted" style={{ fontSize: 10.5, marginBottom: 3 }}>{label}</div>{children}</div>;
}

function MiniTable({ head, rows, empty }: { head: string[]; rows: React.ReactNode[][]; empty: string }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse" }}>
      <thead><tr>{head.map((h, i) => (
        <th key={h} className="mono" style={{ textAlign: i === 0 ? "left" : "left", padding: "5px 6px", color: "var(--dim)", fontSize: 10, letterSpacing: ".4px", borderBottom: "1px solid var(--line)", fontWeight: 500 }}>{h}</th>
      ))}</tr></thead>
      <tbody>
        {rows.length === 0 ? <tr><td colSpan={head.length} className="hint" style={{ padding: "8px 6px" }}>{empty}</td></tr> :
          rows.map((r, i) => (
            <tr key={i}>{r.map((c, j) => (
              <td key={j} className={j === 0 || (typeof c === "string" && /^[\w.-]+$/.test(c)) ? "mono" : ""}
                  style={{ padding: "5px 6px", fontSize: 11.5, borderBottom: "1px solid var(--line-3)", color: "var(--text-2)" }}>{c}</td>
            ))}</tr>
          ))}
      </tbody>
    </table>
  );
}
