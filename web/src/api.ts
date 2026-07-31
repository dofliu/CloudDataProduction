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
/** 產線物料流(engine/line.py):站間緩衝 / 手臂在手 / 出貨,學生面公開視圖。 */
export interface LineStation {
  device: string; template: string;
  role: "source" | "mid" | "sink" | "handler" | "terminal";
  in_buffer: number | null;    // 入料緩衝(非首站 producer)
  out_buffer: number | null;   // 出料緩衝(非末站 producer)
  carrying: number | null;     // 手臂在手件數(handler)
  moved: number | null;        // 手臂累積搬運件數(handler)
  on_belt: number | null;      // 帶上工件數(terminal 輸送帶;走完帶長才算出貨)
}
export interface LineView { company: string; stations: LineStation[]; shipped: number; }

export interface TelemetryMsg {
  wall_t: number; sim_t: number; multiplier: number;
  devices: Record<string, DeviceSnapshot>;
  lines?: LineView[];          // 產線物料流(有 line: 宣告的公司才有)
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
  const r = await fetch(path, { headers: authHeaders() });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

export const getPark = () => getJSON<Park>("/api/park");
export const getCatalog = () => getJSON<Catalog>("/api/catalog");

// ── 身分:登入 session token,或教師 token(管理員 bootstrap)──────
export interface Session { token: string | null; username: string; role: string; }
let session: Session | null = (() => {
  try { return JSON.parse(localStorage.getItem("session") || "null"); } catch { return null; }
})();
export function getSession(): Session | null { return session; }
export function setSession(s: Session | null) {
  session = s;
  if (s) localStorage.setItem("session", JSON.stringify(s));
  else localStorage.removeItem("session");
}
let teacherToken = localStorage.getItem("teacher_token") || "";
export function setTeacherToken(t: string) { teacherToken = t; localStorage.setItem("teacher_token", t); }
export function getTeacherToken() { return teacherToken; }
function bearer(): string | null { return (session && session.token) || teacherToken || null; }
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  const b = bearer();
  if (b) h["Authorization"] = `Bearer ${b}`;
  return h;
}
// 一律帶身分標頭(公開端點會忽略;受保護端點才用)。第三參數保留相容,已不再需要。
async function post(path: string, body?: any, _auth = false) {
  const r = await fetch(path, {
    method: "POST",
    headers: authHeaders(),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json().catch(() => ({}));
}

// ── 登入 / 帳號 API ─────────────────────────────────────────
export interface AuthStatus { auth_required: boolean; has_users: boolean; }
export interface UserRow { username: string; role: string; created: number | null; }
export const getAuthStatus = () => getJSON<AuthStatus>("/api/auth/status");
export const getMe = () => getJSON<{ username: string; role: string }>("/api/auth/me");
export async function login(username: string, password: string): Promise<Session> {
  const r = await post("/api/auth/login", { username, password });
  const s: Session = { token: r.token, username: r.username, role: r.role };
  setSession(s);
  return s;
}
export async function loginWithToken(token: string): Promise<Session> {   // 教師 / 管理員 token
  setTeacherToken(token);
  try {
    const me = await getMe();
    const s: Session = { token: null, username: me.username === "__admin__" ? "管理員" : me.username, role: me.role };
    setSession(s);
    return s;
  } catch (e) { setTeacherToken(""); throw e; }
}
export async function logout() {
  try { await post("/api/auth/logout"); } catch { /* */ }
  setSession(null);
  setTeacherToken("");
}
export const listUsers = () => getJSON<{ users: UserRow[] }>("/api/auth/users");
export const createUsers = (users: { username: string; password: string; role?: string }[], role?: string) =>
  post("/api/auth/users", { users, role }) as Promise<{ created: string[]; skipped: string[] }>;

export interface StudentOverviewRow {
  student: string; has_account: boolean;
  company: { id: string; name: string; devices: number } | null;
  submissions: number; assignments_done: number; avg_score: number | null;
  tickets_open: number; tickets_resolved: number;
  predictions: number; pred_hits: number;
}
export const getStudentsOverview = () => getJSON<{ students: StudentOverviewRow[] }>("/api/students/overview");

export interface StudentDetail {
  student: string;
  company: { id: string; name: string; device_ids: string[] } | null;
  submissions: SubmissionResult[];
  tickets: Ticket[];
  predictions: any[];
}
export const getStudentDetail = (username: string) =>
  getJSON<StudentDetail>(`/api/students/${encodeURIComponent(username)}`);
export const resetUserPassword = (username: string, password: string) =>
  post(`/api/auth/users/${encodeURIComponent(username)}/password`, { password });
export const deleteUser = (username: string) =>
  fetch(`/api/auth/users/${encodeURIComponent(username)}`, { method: "DELETE", headers: authHeaders() }).then((r) => r.json());
export const releaseCompany = (companyId: string) => post(`/api/companies/${companyId}/release`);

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
// component / fault_type 只有教師身分拿得到 —— 那是根因(等於答案),學生面被後端遮掉。
export interface Ticket {
  id: string; device: string; company: string; owner: string | null;
  component?: string | null; fault_type?: string | null; onset_sim_t: number;
  status: string; ack_sim_t: number | null; resolve_sim_t: number | null;
  detection_latency_sim_s: number | null; mttr_sim_s: number | null;
  symptom?: string;                                  // 學生看得到的症狀(不含根因)
  attempts?: { action: string; success: boolean; sim_t: number; actor: string | null }[];
  wrong_attempts?: number;                           // 誤修次數
  repair_downtime_h?: number;                        // 這張單累計花掉的維修工時(含白花的)
}
export const getTickets = (owner?: string) =>
  getJSON<{ tickets: Ticket[] }>(`/api/tickets${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`);
export const ackTicket = (id: string) => post(`/api/tickets/${id}/ack`);

/** 結案要帶處置動作:選對才修得好,選錯扣工時且工單退回處理中。 */
export interface RepairResult {
  action: string; success: boolean; still_faulted: boolean; downtime_h: number;
}
export const resolveTicket = (id: string, action: string, student?: string) =>
  post(`/api/tickets/${id}/resolve`, { action, student }) as
    Promise<{ ok: boolean; ticket: Ticket; repair: RepairResult | null; note?: string }>;

/** 維修手冊:有哪些處置動作、各要多少工時、在數據上長什麼樣(公開,不含哪台該用哪個)。 */
export interface RepairAction {
  action: string; label: string; duration_h: number; signature: string;
}
export const getRepairActions = () =>
  getJSON<{ actions: RepairAction[]; note: string }>("/api/repair/actions");

// ── 預防保養(需認領授權)────────────────────────────────
export interface MaintenanceRec {
  id: string; device: string; company: string | null; actor: string | null;
  action: string; sim_t: number; downtime_h: number; health_gain: number; effective: boolean;
}
export const doMaintenance = (device: string, action: string, student?: string) =>
  post("/api/maintenance", { device, action, student }) as
    Promise<{ ok: boolean; maintenance: MaintenanceRec; hint: string | null }>;
export const getMaintenance = (actor?: string) =>
  getJSON<{ maintenance: MaintenanceRec[]; summary: { rows: any[]; total: number } }>(
    `/api/maintenance${actor ? `?actor=${encodeURIComponent(actor)}` : ""}`);

// ── 學生託管告警規則(平台代跑,對 ground-truth 算 F1 / lead time)──
export interface AlarmRule {
  id: string; student: string; device: string; tag: string;
  agg: "raw" | "ema"; window_s: number; op: string; threshold: number;
  for_s: number; enabled: boolean; created_sim_t: number;
}
export interface AlarmAlert {
  id: string; rule: string; student: string; device: string; tag: string;
  value: number; sim_t: number;
}
export interface AlarmScoreRow {
  student: string; rules: number; alerts: number; hits: number;
  false_alarms: number; misses: number; duplicates: number;
  precision: number; recall: number; f1: number;
  avg_lead_time_h: number | null; score: number;
}
export const createAlarmRule = (r: Partial<AlarmRule> & { device: string; tag: string; threshold: number }) =>
  post("/api/alarm_rules", r) as Promise<{ ok: boolean; rule: AlarmRule; note: string }>;
export const getAlarmRules = (student?: string) =>
  getJSON<{ rules: AlarmRule[]; alerts: AlarmAlert[] }>(
    `/api/alarm_rules${student ? `?student=${encodeURIComponent(student)}` : ""}`);
export const getAlarmScores = () =>
  getJSON<{ horizon_h: number; ranking: AlarmScoreRow[] }>("/api/alarm_rules/scores");
export async function deleteAlarmRule(id: string) {
  const r = await fetch(`/api/alarm_rules/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!r.ok) throw new Error(`delete rule ${id} -> ${r.status}`);
  return r.json();
}

// ── 資料的一生九關(api/levels.py)──────────────────────────
export interface LevelState {
  id: string; name: string; title: string; week: number | null;
  hint: string; manual: boolean; done: boolean; evidence: string;
}
export interface AccessRow {
  device: string; protocol: string; reads: number;
  last_wall_t: number | null; avg_interval_s: number | null;
}
export interface LevelStatus {
  student: string; levels: LevelState[]; badges: LevelState[];
  done: number; total: number; next: LevelState | null; access: AccessRow[];
}
export interface LevelBoard {
  students: LevelStatus[];
  levels: { id: string; name: string; week: number | null; manual: boolean; done: number; stuck: number }[];
  bottleneck: { id: string; name: string; count: number } | null;
  count: number;
}
export const getLevelStatus = (student: string) =>
  getJSON<LevelStatus>(`/api/levels/${encodeURIComponent(student)}`);
export const getLevelBoard = () => getJSON<LevelBoard>("/api/levels/board/all");
export const markLevel = (student: string, level: string, done: boolean) =>
  post("/api/levels/mark", { student, level, done });
export const getAccessLog = () =>
  getJSON<{ rows: AccessRow[]; note: string }>("/api/access_log");

export interface ScoreRow {
  company: string; name: string; owner: string | null;
  faults: number; detected: number; resolved: number; missed: number;
  wrong_repairs?: number;
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

// CNC 刻字文字(糖衣:一次寫進 engrave_char_1..8 八個設定點)
export const setEngraveText = (id: string, text: string) =>
  post(`/api/devices/${id}/engrave_text`, { text }) as
    Promise<{ ok: boolean; text: string; setpoints: Record<string, number> }>;

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

// ── 課堂即時練習 ────────────────────────────────────────────
export interface ClassroomQuestion {
  id: string; tier: "simple" | "complex"; prompt: string;
  type: "choice" | "numeric"; choices?: string[]; unit?: string; hint?: string;
}
export interface ClassroomExercise {
  id: string; title: string; difficulty: string; brief?: string;
  questions: number; setup?: Record<string, any>;
}
export interface ClassroomActive {
  exercise: string; title: string; brief?: string; difficulty?: string;
  target: string; launched_wall: number; questions: ClassroomQuestion[];
  // 倒數用 wall clock(學生盯的是教室裡的鐘,不是模擬時鐘)
  deadline_wall?: number | null; remain_s?: number | null; closed?: boolean;
}
export interface ClassroomAnswerResult {
  correct: boolean; passed: boolean; score: number; feedback: string; explain?: string;
  first?: boolean; elapsed_s?: number | null;      // 全班第一個答對的人留名
}
export interface ClassroomBoardRow {
  question: string; prompt: string; tier: string; students: number;
  correct: number; rate: number | null; avg: number | null; dist: Record<string, number>;
  first_solver?: string | null; first_elapsed_s?: number | null;
}
export const getClassroomExercises = () =>
  getJSON<{ name: string; exercises: ClassroomExercise[] }>("/api/classroom/exercises");
export const getClassroomActive = () => getJSON<{ active: ClassroomActive | null }>("/api/classroom/active");
export const answerClassroom = (exercise: string, question: string, student: string, answer: any) =>
  post("/api/classroom/answer", { exercise, question, student, answer }) as Promise<ClassroomAnswerResult>;
export const launchClassroom = (exerciseId: string, duration_s?: number | null) =>
  post(`/api/classroom/exercises/${exerciseId}/launch`, { duration_s: duration_s ?? null }, true) as
    Promise<{ target: string; applied: Record<string, any>; deadline_wall: number | null }>;
export const extendClassroom = (seconds: number) =>
  post("/api/classroom/extend", { seconds }, true) as Promise<{ ok: boolean; deadline_wall: number }>;
export const stopClassroom = (reset = true) =>
  post("/api/classroom/stop", { reset }, true) as Promise<{ stopped: boolean; target: string | null; reset: boolean }>;
export const getClassroomBoard = (exercise?: string) =>
  getJSON<{ exercise: string; title: string; questions: ClassroomBoardRow[];
            remain_s: number | null; closed: boolean; target: string | null }>(
    `/api/classroom/board${exercise ? `?exercise=${encodeURIComponent(exercise)}` : ""}`);

// ── 全班投票(沒有正解的取捨題;收票後平台照多數決真的去動引擎)──
export interface PollOption { id: string; label: string; detail?: string; }
export interface PollDef { id: string; question: string; brief?: string; options: PollOption[]; }
export interface PollActive {
  poll: string; question: string; brief?: string; device: string | null;
  options: PollOption[]; tally: Record<string, number>; votes: number;
  remain_s: number | null; closed: boolean;
}
export interface PollRecord {
  poll: string; question: string; device: string | null; closed_wall: number;
  sim_t: number; votes: number; tally: Record<string, number>;
  winner: string | null; winner_label: string | null;
  result: { kind: string; detail: string; ok?: boolean };
}
export const getPolls = () => getJSON<{ polls: PollDef[] }>("/api/polls");
export const getActivePoll = () =>
  getJSON<{ active: PollActive | null; history: PollRecord[] }>("/api/polls/active");
export const openPoll = (id: string, duration_s: number | null = 120, device?: string) =>
  post(`/api/polls/${id}/open`, { duration_s, device }, true) as Promise<{ ok: boolean; active: PollActive }>;
export const votePoll = (poll: string, option: string, student: string) =>
  post("/api/polls/vote", { poll, option, student }) as
    Promise<{ ok: boolean; voted: string; tally: Record<string, number> }>;
export const closePoll = (execute = true) =>
  post("/api/polls/close", { execute }, true) as Promise<{ ok: boolean; closed: PollRecord }>;
export const getPollHistory = () => getJSON<{ history: PollRecord[] }>("/api/polls/history");
export const getClassroomGradebook = () =>
  getJSON<{ gradebook: { student: string; answered: number; avg: number }[] }>("/api/classroom/gradebook");

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
