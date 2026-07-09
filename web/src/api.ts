// 與後端世界溝通:REST 取目錄 / 園區,WebSocket 收即時遙測與事件。
// 一律用相對路徑(/api、/ws),開發走 Vite proxy、正式同源(見 vite.config.ts)。

export interface MapPos { x: number; y: number; }
export interface Company {
  id: string; name: string; industry: string;
  owner: string | null; map_pos: MapPos | null; device_ids: string[];
  product?: string | null; intro?: string | null;
}
export interface Park {
  name: string; protocol_mode: string;
  ports: Record<string, number>; companies: Company[];
}

export interface DeviceSnapshot {
  id: string; template: string; state: string;
  state_code: number; tags: Record<string, number>;
  discretes?: Record<string, boolean>;     // 離散輸入(FC02)
  input_regs?: Record<string, number>;     // 輸入暫存器(FC04)
  coils?: Record<string, boolean>;         // 命令線圈(FC01/05)
  setpoints?: Record<string, number>;      // 學生可寫設定點(holding,受控範圍)
}
export interface TelemetryMsg {
  wall_t: number; sim_t: number; multiplier: number;
  devices: Record<string, DeviceSnapshot>;
}
export interface EventMsg {
  type: string; device: string; company?: string;
  from?: string; to?: string; component?: string;
  fault_type?: string; sim_t: number;
  student?: string; lead_time_sim?: number; confidence?: number;  // 預測事件
  message?: string;                                                // 情境事件
  coil?: string; value?: boolean;                                  // 命令線圈事件
}

export interface CatalogTag {
  name: string; unit: string; datatype: string;
  object?: string; fc?: number; access?: string;
  modbus_register: number; opcua_node: string; mqtt_field: string;
}
export interface CatalogDiscrete {
  name: string; object: string; fc: number; datatype: string;
  access: string; address: number; opcua_node: string; mqtt_field: string;
}
export interface CatalogInputReg {
  name: string; unit: string; object: string; fc: number; datatype: string;
  access: string; scale: number; address: number; opcua_node: string; mqtt_field: string;
}
export interface CatalogCoil {
  name: string; object: string; fc_read: number; fc_write: number; datatype: string;
  access: string; momentary: boolean; address: number; opcua_node: string; mqtt_field: string;
}
export interface CatalogSetpoint {
  name: string; object: string; fc_read: number; fc_write: number; datatype: string;
  access: string; unit: string; scale: number; min: number; max: number; default: number;
  register: number; opcua_node: string; mqtt_field: string;
}
export interface CatalogDevice {
  id: string; template: string; company_id: string;
  protocols: Record<string, any>;
  tags: CatalogTag[];
  discrete_inputs?: CatalogDiscrete[];
  input_registers?: CatalogInputReg[];
  coils?: CatalogCoil[];
  setpoints?: CatalogSetpoint[];
  connection: Record<string, any>;
}
export interface Catalog {
  park: string; protocol_mode: string; synthetic: boolean;
  devices: CatalogDevice[]; hint: string;
}

export async function getJSON<T>(path: string): Promise<T> {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

export const getPark = () => getJSON<Park>("/api/park");
export const getCatalog = () => getJSON<Catalog>("/api/catalog");

// ── 教師 token(教師面端點需帶)──────────────────────────
let teacherToken = localStorage.getItem("teacher_token") || "";
export function setTeacherToken(t: string) {
  teacherToken = t;
  localStorage.setItem("teacher_token", t);
}
export function getTeacherToken() { return teacherToken; }
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (teacherToken) h["Authorization"] = `Bearer ${teacherToken}`;
  return h;
}
async function post(path: string, body?: any, auth = false) {
  const r = await fetch(path, {
    method: "POST",
    headers: auth ? authHeaders() : { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json().catch(() => ({}));
}

// 模擬時鐘(教師面)
export const setClock = (body: { multiplier?: number; paused?: boolean }) =>
  post("/api/sim/clock", body, true);

// ── 故障注入 / ground-truth(教師面)─────────────────────
export interface FaultBody {
  device: string; fault_type: string; target: string;
  severity?: number; onset_sim_s?: number; params?: Record<string, any>;
}
export const injectFault = (body: FaultBody) => post("/api/faults", body, true);

// 自然語言建廠(教師面):一句話 → 即時長出新公司
export const createFactory = (description: string) => post("/api/factory", { description }, true);
export const resetDevice = (id: string) => post(`/api/devices/${id}/reset`, undefined, true);
// 教師「重置課堂資料」:清認領 / 工單 / 預測 / OEE、設備修回健康(換班 / 下堂課歸零)
export interface SessionResetScope { claims?: boolean; tickets?: boolean; predictions?: boolean; oee?: boolean; devices?: boolean; }
export const resetSession = (scope: SessionResetScope = {}) =>
  post("/api/session/reset", scope, true) as Promise<{ reset: boolean; cleared: Record<string, number> }>;
// 教師命令線圈(FC05 認證版):run_enable 停機/復機、reset_fault 清故障
export const setCoil = (id: string, name: string, value: boolean) =>
  post(`/api/devices/${id}/coil`, { name, value }, true);

export interface ComponentGT { name: string; health: number; rul_sim_s: number | null; failed: boolean; trajectory: string; }
export interface HealthGT {
  id: string; state: string; rul_sim_s: number | null;
  fault_onset_sim_t: number | null; components: ComponentGT[];
  sensor_faults: Record<string, any>; is_sensor_fault: boolean; injected: any[];
}
export async function getHealth(id: string): Promise<HealthGT> {
  const r = await fetch(`/api/devices/${id}/health`, { headers: authHeaders() });
  if (!r.ok) throw new Error(`health ${id} -> ${r.status}`);
  return r.json();
}

// ── 工單 / 評分(學生面公開)─────────────────────────────
export interface Ticket {
  id: string; device: string; company: string; owner: string | null;
  component: string | null; fault_type: string | null; onset_sim_t: number;
  status: string; ack_sim_t: number | null; resolve_sim_t: number | null;
  detection_latency_sim_s: number | null; mttr_sim_s: number | null;
}
export const getTickets = (owner?: string) =>
  getJSON<{ tickets: Ticket[] }>(`/api/tickets${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`);
export const ackTicket = (id: string) => post(`/api/tickets/${id}/ack`);
export const resolveTicket = (id: string) => post(`/api/tickets/${id}/resolve`);

export interface ScoreRow {
  company: string; name: string; owner: string | null;
  faults: number; detected: number; resolved: number; missed: number;
  avg_detection_h: number | null; avg_mttr_h: number | null; score: number;
}
export const getScores = () => getJSON<{ ranking: ScoreRow[] }>("/api/scores");

// 學生認領公司(公開,免 auth)
export const claimCompany = (companyId: string, studentId: string) =>
  post(`/api/companies/${companyId}/claim`, { student_id: studentId });

// 學生寫設定點(公開,受控範圍;後端夾限)
export const setSetpoint = (id: string, name: string, value: number) =>
  post(`/api/devices/${id}/setpoint`, { name, value }) as
    Promise<{ ok: boolean; value: number; clamped: boolean; range: [number, number]; unit: string }>;

// ── 階段二:預測(學生面公開)───────────────────────────
export interface PredictionBody {
  device: string; student: string; predicted_fault?: string;
  eta_sim_s?: number; confidence?: number;
}
export const postPrediction = (body: PredictionBody) => post("/api/predictions", body);

export interface PredScoreRow {
  student: string; predictions: number; hits: number; false_alarms: number;
  pending: number; avg_lead_time_h: number | null; hit_rate: number | null; score: number;
}
export const getPredictionScores = () => getJSON<{ ranking: PredScoreRow[] }>("/api/predictions/scores");

// ── 課程情境(每週釋出)+ 作業自動比對 ──────────────────
export interface CourseWeek { week: number; title: string | null; faults: string; order_density: string | null; }
export interface CourseStatus {
  name: string; current_week: number | null; title: string | null;
  window_start_sim_t: number | null; window_start_wall: number | null;
  utilization: number; default_tolerance: number;
}
export const getCourseWeeks = () => getJSON<{ weeks: CourseWeek[] }>("/api/course/weeks");
export const getCourseStatus = () => getJSON<CourseStatus>("/api/course/status");
export const applyCourseWeek = (n: number) =>
  post(`/api/course/weeks/${n}/apply`, undefined, true) as Promise<{
    applied_week: number; title: string; faults: string; injected: any[]; order_density: string | null; utilization: number;
  }>;

// 作業繳交(學生面公開):type = connect / stats / oee / anomaly
export interface SubmissionResult {
  id: string; student: string; week: number | string | null; type: string;
  submitted_wall: number; sim_t: number; score: number; passed: boolean; feedback: string;
}
export const postSubmission = (payload: Record<string, any>) =>
  post("/api/submissions", payload) as Promise<SubmissionResult>;
export const getSubmissions = (student?: string, week?: string, type?: string) => {
  const q = new URLSearchParams();
  if (student) q.set("student", student);
  if (week) q.set("week", week);
  if (type) q.set("type", type);
  const qs = q.toString();
  return getJSON<{ submissions: SubmissionResult[] }>(`/api/submissions${qs ? `?${qs}` : ""}`);
};
export interface GradebookRow {
  student: string; count: number; avg: number;
  assignments: { type: string; week: string | null; score: number }[];
}
export const getGradebook = (week?: string, type?: string) => {
  const q = new URLSearchParams();
  if (week) q.set("week", week);
  if (type) q.set("type", type);
  const qs = q.toString();
  return getJSON<{ gradebook: GradebookRow[] }>(`/api/submissions/gradebook${qs ? `?${qs}` : ""}`);
};
export const getSubmissionsLeaderboard = (week?: string, type?: string) => {
  const q = new URLSearchParams();
  if (week) q.set("week", week);
  if (type) q.set("type", type);
  const qs = q.toString();
  return getJSON<{ leaderboard: { student: string; score: number; type: string; week: any }[] }>(
    `/api/submissions/leaderboard${qs ? `?${qs}` : ""}`);
};

// ── 協定連線自測 / 戰情版 ───────────────────────────────
export interface DiagRow {
  device?: string; ok: boolean; value?: number;
  tag?: string; addr?: string; latency_ms?: number; error?: string;
}
export interface DiagProto { summary: { reachable: number; total: number; port: number }; devices: DiagRow[]; }
export interface Diagnostics {
  host: string;
  protocols: { modbus: DiagProto; opcua: DiagProto; mqtt: DiagProto; modbus_multiport?: DiagProto };
}
export const getDiagnostics = () => getJSON<Diagnostics>("/api/diagnostics/protocols");

// ── 情境腳本(災難日)───────────────────────────────────
export interface ScenarioScript { name: string; description: string; steps: number; }
export interface ScenarioStatus { running: string | null; log: { message: string; sim_t: number }[]; }
export const getScenarios = () => getJSON<{ scripts: ScenarioScript[]; status: ScenarioStatus }>("/api/scenarios");
export const runScenario = (name: string) => post(`/api/scenarios/${name}/run`, undefined, true);
export const stopScenario = () => post("/api/scenarios/stop", undefined, true);

// ── OEE 設備總效率排名(公開)───────────────────────────
export interface OeeDevice {
  device: string; availability: number; performance: number; quality: number;
  oee: number; run_h: number; down_h: number;
}
export interface OeeRow {
  company: string; name: string; owner: string | null;
  oee: number; availability: number; performance: number; quality: number; devices: string[];
}
export const getOee = () => getJSON<{ ranking: OeeRow[]; devices: OeeDevice[] }>("/api/oee");

// 自動重連的 WebSocket 訂閱;回傳 close 函式。
export function subscribe<T>(path: string, onMessage: (msg: T) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  let timer: number | undefined;

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${location.host}${path}`;

  const open = () => {
    ws = new WebSocket(url);
    ws.onmessage = (e) => {
      try { onMessage(JSON.parse(e.data)); } catch { /* 忽略壞封包 */ }
    };
    ws.onclose = () => {
      if (!closed) timer = window.setTimeout(open, 1000); // 斷線 1 秒後重連
    };
    ws.onerror = () => ws?.close();
  };
  open();

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    ws?.close();
  };
}

// ── 狀態 → 顏色 / 嚴重度(2D 世界燈號)──────────────────
// 綠=正常 / 黃=警告 / 橘=預測故障(P3) / 紅=故障 / 灰=停機
export const STATUS_COLOR: Record<string, number> = {
  running: 0x37d67a, moving: 0x37d67a,
  idle: 0x8a93a6, charging: 0x5b9bd5, maintenance: 0x8a93a6,
  alarm: 0xf2c037, tool_change: 0xf2c037, blocked: 0xf2c037,
  fault: 0xe24c4c, predicted_fault: 0xf08c2e,
};
export const STATUS_COLOR_CSS: Record<string, string> = {
  running: "#37d67a", moving: "#37d67a",
  idle: "#8a93a6", charging: "#5b9bd5", maintenance: "#8a93a6",
  alarm: "#f2c037", tool_change: "#f2c037", blocked: "#f2c037",
  fault: "#e24c4c", predicted_fault: "#f08c2e",
};
const SEVERITY: Record<string, number> = {
  fault: 5, predicted_fault: 4, alarm: 3, tool_change: 3, blocked: 3,
  running: 2, moving: 2, charging: 1, idle: 1, maintenance: 1,
};

export function worstState(states: string[]): string {
  let worst = "idle", sev = -1;
  for (const s of states) {
    const v = SEVERITY[s] ?? 0;
    if (v > sev) { sev = v; worst = s; }
  }
  return worst;
}

export function colorOf(state: string): number {
  return STATUS_COLOR[state] ?? 0x8a93a6;
}
