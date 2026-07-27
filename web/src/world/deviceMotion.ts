/**
 * 設備動畫資料橋(契約見 docs/animation_binding.md)。
 *
 * 職責只有三件事:
 *   1. 把 snapshot 的 state / coils 正規化成一組動畫用旗標(running / fault / stopped …)。
 *   2. 把觀測 tag 反推成 0..1 的健康連續量(severity / heat / wear)—— 不碰 ground-truth。
 *   3. 提供 delta-based 補間與「視覺換算 + 倍率標示」的工具(L3)。
 *
 * 這裡**不做任何物理模擬**。引擎算過的量(位置 / 角度 / 相位)一律直接用。
 */
import type { DeviceSnapshot } from "../api";

// ── 可讀區間(docs/animation_binding.md §3)────────────────
export const MIN_PERIOD_S = 3.0;    // 週期性動作的牆鐘下限:再快人眼就變閃爍
export const MAX_PERIOD_S = 20.0;   // 上限:再慢學生會以為機台停了
export const MAX_SPIN_RPS = 1.5;    // 旋轉件的畫面上限(rev/s)

// severity 通用門檻(mm/s)。引擎各 template 皆為 base + 10~12×(1-health)^1.8。
const VIB_WARN = 4.5, VIB_FAULT = 11.0;
// 輸送帶的振動量級本來就小(0~2),另立門檻,否則永遠是 0。
const VIB_WARN_LOW = 1.2, VIB_FAULT_LOW = 2.0;
const LOW_VIB_TEMPLATES = new Set(["conveyor"]);

/** 各機種的「主要溫度」與其正常→過熱區間(°C),用於 heat。 */
const HEAT_SPEC: Record<string, { tag: string[]; lo: number; hi: number }> = {
  cnc_machining_center: { tag: ["spindle_temp"], lo: 45, hi: 95 },
  robot_arm_6axis: { tag: ["joint_temp_1", "joint_temp_2", "joint_temp_3", "joint_temp_4", "joint_temp_5", "joint_temp_6"], lo: 38, hi: 60 },
  agv_mobile_robot: { tag: ["motor_temp"], lo: 30, hi: 55 },
  air_compressor: { tag: ["motor_temp"], lo: 45, hi: 80 },
  stamping_press: { tag: ["die_temp"], lo: 60, hi: 85 },
  injection_molding: { tag: ["oil_temp"], lo: 55, hi: 85 },
  wind_turbine: { tag: ["gearbox_temp", "generator_temp"], lo: 45, hi: 95 },
  semi_process_chamber: { tag: ["pump_temp"], lo: 50, hi: 80 },
  heat_treat_furnace: { tag: ["furnace_temp"], lo: 30, hi: 900 },
  conveyor: { tag: [], lo: 0, hi: 1 },
  energy_meter: { tag: [], lo: 0, hi: 1 },
};

/** 各機種的「指標型退化」tag 與其正常→劣化區間,用於 wear(良率 / 品質線索)。 */
const WEAR_SPEC: Record<string, { tag: string; lo: number; hi: number }> = {
  cnc_machining_center: { tag: "tool_wear", lo: 0, hi: 100 },
  stamping_press: { tag: "burr_rate", lo: 0.5, hi: 15 },
  semi_process_chamber: { tag: "particle_count", lo: 4, hi: 70 },
  heat_treat_furnace: { tag: "temp_uniformity", lo: 4, hi: 39 },
  injection_molding: { tag: "cycle_time", lo: 30, hi: 39 },
  air_compressor: { tag: "flow", lo: 8, hi: 4.8 },   // 反向:流量掉 = 濾網阻塞
  wind_turbine: { tag: "vibration_rms", lo: 1, hi: 12 },
  energy_meter: { tag: "power_factor", lo: 0.95, hi: 0.7 },   // 反向:功因下滑 = 電容老化
  conveyor: { tag: "motor_current", lo: 5, hi: 7 },
  robot_arm_6axis: { tag: "vibration_rms", lo: 0.8, hi: 12 },
};

export interface DeviceMotion {
  /** 原始 state 字串,需要細分 tool_change / blocked 時用 */
  raw: string;
  /** 機構應該在動 */
  running: boolean;
  /** 待機(自然停,如換班) */
  idle: boolean;
  /** 故障鎖定:機構必須立刻停下,不只是換顏色 */
  fault: boolean;
  /** 教師寫 run_enable=0 停機,與自然待機要看得出差別 */
  stopped: boolean;
  /** AGV 充電中 */
  charging: boolean;
  /** sim_clock 倍率(TelemetryMsg.multiplier) */
  timeScale: number;
  /** 振動主指標原始值(mm/s) */
  vibration: number;
  /** 0..1 退化嚴重度(由 vibration_rms 換算) */
  severity: number;
  /** 0..1 發熱程度 */
  heat: number;
  /** 0..1 指標型退化(品質 / 良率線索) */
  wear: number;
  tags: Record<string, number>;
  setpoints: Record<string, number>;
}

/**
 * 所有機種 model 與單機 Canvas 的統一介面。
 * 只吃 motion —— state / tags / setpoints / 時間倍率都已經在裡面,
 * 不再由各元件自己解讀 state 字串或猜 tag 名稱。
 */
export interface MachineProps { motion: DeviceMotion }

export const IDLE_MOTION: DeviceMotion = {
  raw: "idle", running: false, idle: true, fault: false, stopped: false, charging: false,
  timeScale: 1, vibration: 0, severity: 0, heat: 0, wear: 0, tags: {}, setpoints: {},
};

export function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/** 線性正規化;支援 hi < lo(反向指標,例如流量掉 = 劣化)。 */
function norm(v: number, lo: number, hi: number) {
  if (hi === lo) return 0;
  return clamp01((v - lo) / (hi - lo));
}

/**
 * 由一筆 snapshot + sim 倍率建出動畫用的正規化狀態。
 * 在 Canvas **外面**呼叫,結果當一般 prop 傳進 model —— react-three-fiber 的
 * reconciler 是獨立的,Canvas 外的 React context 不會自動穿透進去。
 */
export function buildMotion(
  snap: Pick<DeviceSnapshot, "template" | "state" | "tags"> & Partial<Pick<DeviceSnapshot, "coils" | "setpoints">> | null | undefined,
  timeScale = 1,
): DeviceMotion {
  if (!snap) return { ...IDLE_MOTION, timeScale };
  const tags = snap.tags || {};
  const setpoints = snap.setpoints || {};
  const state = snap.state || "idle";
  const tmpl = snap.template || "";

  const fault = state === "fault" || state === "alarm";
  const stopped = snap.coils?.run_enable === false;
  const charging = state === "charging";
  const running = !fault && !stopped &&
    (state === "running" || state === "moving" || state === "charging" || state === "tool_change");
  const idle = !running && !fault && !stopped;

  const vibration = tags.vibration_rms ?? 0;
  const low = LOW_VIB_TEMPLATES.has(tmpl);
  const severity = norm(vibration, low ? VIB_WARN_LOW : VIB_WARN, low ? VIB_FAULT_LOW : VIB_FAULT);

  const hs = HEAT_SPEC[tmpl];
  let heat = 0;
  if (hs && hs.tag.length) {
    let peak = -Infinity;
    for (const t of hs.tag) if (typeof tags[t] === "number") peak = Math.max(peak, tags[t]);
    if (peak > -Infinity) heat = norm(peak, hs.lo, hs.hi);
  }

  const ws = WEAR_SPEC[tmpl];
  const wear = ws && typeof tags[ws.tag] === "number" ? norm(tags[ws.tag], ws.lo, ws.hi) : 0;

  return { raw: state, running, idle, fault, stopped, charging, timeScale: timeScale || 1,
           vibration, severity, heat, wear, tags, setpoints };
}

// ── 補間(delta-based;絕不用 frame-rate 相依的固定係數)────

/** 指數趨近:tau 是時間常數(秒),與 frame rate 無關。 */
export function approach(current: number, target: number, tau: number, dt: number) {
  if (tau <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

/** 角度版(度),走最短路徑,不會在 ±180 邊界甩一整圈。 */
export function approachAngleDeg(current: number, target: number, tau: number, dt: number) {
  let diff = ((target - current) % 360 + 540) % 360 - 180;
  return current + diff * (1 - Math.exp(-dt / tau));
}

/** 角度版(弧度)。 */
export function approachAngleRad(current: number, target: number, tau: number, dt: number) {
  const TAU = Math.PI * 2;
  let diff = ((target - current) % TAU + TAU * 1.5) % TAU - Math.PI;
  return current + diff * (1 - Math.exp(-dt / tau));
}

// ── L3 視覺換算(必須標示倍率)──────────────────────────

export interface VisualScale {
  /** 換算後實際用於動畫的值 */
  value: number;
  /** 相對真實值的倍率(1 = 未換算) */
  factor: number;
  /** 給畫面顯示的說明;未換算時為空字串 */
  label: string;
}

/**
 * 週期性動作:sim 週期(秒)→ 牆鐘週期(秒),夾在可讀區間內並標示倍率。
 * 例:cycle_time=45 s、multiplier=120 → 真實牆鐘 0.375 s,夾成 3 s → 標「動畫慢放 ×8」。
 */
export function visualPeriod(simPeriodS: number, timeScale: number): VisualScale {
  const real = Math.max(1e-3, simPeriodS) / Math.max(1e-6, timeScale);
  const shown = Math.min(MAX_PERIOD_S, Math.max(MIN_PERIOD_S, real));
  const factor = shown / real;
  let label = "";
  if (factor > 1.05) label = `動畫慢放 ×${fmt(factor)}`;
  else if (factor < 0.95) label = `動畫快轉 ×${fmt(1 / factor)}`;
  return { value: shown, factor, label };
}

/**
 * 旋轉件:rpm →(牆鐘)rev/s,超過 MAX_SPIN_RPS 就降頻並標示。
 * timeScale 也要算進去 —— sim 加速時真實轉速在牆鐘上更快。
 */
export function visualSpin(rpm: number, timeScale: number): VisualScale {
  const real = (Math.abs(rpm) / 60) * Math.max(1e-6, timeScale);
  const shown = Math.min(MAX_SPIN_RPS, real);
  const factor = real > 1e-6 ? shown / real : 1;
  const label = factor < 0.95 ? `轉速視覺 ×1/${fmt(1 / factor)}` : "";
  return { value: shown * Math.sign(rpm || 1), factor, label };
}

function fmt(v: number) {
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, "");
}

/** 把多個換算說明併成一行(給畫面角落的小字)。 */
export function scaleNote(...scales: (VisualScale | string | undefined)[]): string {
  const parts = scales
    .map((s) => (typeof s === "string" ? s : s?.label))
    .filter((s): s is string => !!s);
  return parts.length ? parts.join(" · ") : "";
}

// ── CNC 刀路:與引擎 engine/templates/cnc_machining_center.py 完全同一組參數式 ──
//
// 前端不重算物理,但**必須**知道這條參數曲線,才能由 1 Hz 的 pos_x/pos_y/pos_z
// 反推出當下相位,再於兩次遙測之間平滑推進(相位鎖定,而不是各跑各的)。

/** 與引擎 get_target_pos() 逐行對應。progress ∈ [0,1),回傳 mm。 */
export function cncToolPath(progress: number, pattern: number): [number, number, number] {
  if (pattern === 1) {
    if (progress < 0.05 || progress > 0.95) return [0, -150, 50];
    const p = (progress - 0.05) / 0.9;
    return [Math.cos((p - 0.25) * Math.PI * 2) * 150, Math.sin((p - 0.25) * Math.PI * 2) * 150, -50];
  }
  if (pattern === 2) {
    if (progress < 0.05 || progress > 0.95) return [-150, -150, 50];
    const p = (progress - 0.05) / 0.9;
    if (p < 0.25) return [-150 + 300 * (p / 0.25), -150, -50];
    if (p < 0.5) return [150, -150 + 300 * ((p - 0.25) / 0.25), -50];
    if (p < 0.75) return [150 - 300 * ((p - 0.5) / 0.25), 150, -50];
    return [-150, 150 - 300 * ((p - 0.75) / 0.25), -50];
  }
  const strokes: number[][][] = [
    [[-220, -60], [-220, 60]],
    [[-220, 60], [-140, -60]],
    [[-140, -60], [-140, 60]],
    [[-40, 60], [-100, 60], [-100, -60], [-40, -60]],
    [[40, 60], [40, -60], [100, -60], [100, 60]],
    [[140, 60], [220, 60]],
    [[180, 60], [180, -60]],
  ];
  const total = strokes.length;
  const segProgress = progress * total;
  const segIdx = Math.min(Math.floor(segProgress), total - 1);
  const localP = segProgress - segIdx;
  const stroke = strokes[segIdx];
  const pts = stroke.length;
  if (localP < 0.1) return [stroke[0][0], stroke[0][1], 50 - 100 * (localP / 0.1)];
  if (localP > 0.9) return [stroke[pts - 1][0], stroke[pts - 1][1], -50 + 100 * ((localP - 0.9) / 0.1)];
  const cutP = (localP - 0.1) / 0.8;
  const cutSegs = pts - 1;
  const cIdx = Math.min(Math.floor(cutP * cutSegs), cutSegs - 1);
  const ccP = cutP * cutSegs - cIdx;
  const p1 = stroke[cIdx], p2 = stroke[cIdx + 1];
  return [p1[0] + (p2[0] - p1[0]) * ccP, p1[1] + (p2[1] - p1[1]) * ccP, -50];
}

/**
 * 相位鎖定:由引擎回報的 (x, y) 找出最接近的相位,再把本地相位往它拉。
 *
 * 只在「本地相位附近的窗」內搜尋,避免刀路自交(pattern 0 的 CNC 字樣)時亂跳;
 * 若誤差大到超出窗(剛開機 / 換件 / 學生改了 pattern)就直接硬同步。
 *
 * @returns 修正後的相位 ∈ [0,1)
 */
export function lockCncPhase(local: number, reportedX: number, reportedY: number, pattern: number): number {
  const SAMPLES = 128;
  const WINDOW = 0.12;              // 只信任前後 12% 的相位窗
  let bestNear = -1, bestNearErr = Infinity;
  let bestAny = -1, bestAnyErr = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const ph = i / SAMPLES;
    const [x, y] = cncToolPath(ph, pattern);
    const err = (x - reportedX) ** 2 + (y - reportedY) ** 2;
    if (err < bestAnyErr) { bestAnyErr = err; bestAny = ph; }
    let d = Math.abs(ph - local);
    d = Math.min(d, 1 - d);
    if (d <= WINDOW && err < bestNearErr) { bestNearErr = err; bestNear = ph; }
  }
  // 窗內找得到(< 25 mm 誤差)→ 溫和拉近,保住畫面連續;否則硬同步。
  if (bestNear >= 0 && bestNearErr < 25 * 25) {
    let diff = bestNear - local;
    if (diff > 0.5) diff -= 1; else if (diff < -0.5) diff += 1;
    const next = local + diff * 0.25;
    return (next % 1 + 1) % 1;
  }
  return bestAny >= 0 ? bestAny : local;
}
