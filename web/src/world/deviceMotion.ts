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
export interface MachineProps {
  motion: DeviceMotion;
  /**
   * 測試接縫:掛在 Canvas 內的額外節點。正式畫面永遠不傳,
   * 只有 tests/animation 的驗證載具會塞一個探針回報器進去讀場景世界座標。
   */
  debug?: unknown;
}

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
 * 週期性動作:sim 週期(秒)→ 牆鐘週期(秒)。太快會變閃爍,因此只夾**快的那一端**。
 *
 * 刻意不夾慢的那一端 —— 「加速播放」會破壞畫面與 pos_* / ram_position 的座標對應,
 * 而那正是本平台最有說服力的一課(學生用 Modbus 讀到的位置要對得上畫面)。
 * 機台本來就慢,畫面就該跟著慢;慢不是問題,對不上才是。
 *
 * 例:cycle_time=45 s、multiplier=120 → 牆鐘 0.375 s,夾成 3 s → 標「動畫慢放 ×8」。
 *     cycle_time=45 s、multiplier=1   → 牆鐘 45 s,factor=1 → 不換算,相位鎖回遙測。
 */
export function visualPeriod(simPeriodS: number, timeScale: number): VisualScale {
  const real = Math.max(1e-3, simPeriodS) / Math.max(1e-6, timeScale);
  const shown = Math.max(MIN_PERIOD_S, real);
  const factor = shown / real;
  const label = factor > 1.05 ? `動畫慢放 ×${fmt(factor)}` : "";
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
/**
 * pattern 0 的刀路:刻字(預設「NCUT」,文字可由 setpoint engrave_char_1..8 改)。
 * **STROKE_FONT 必須與 engine/templates/_stroke_font.py 的 GLYPHS 逐點相同** ——
 * 相位鎖定(lockCncPhase)就是拿同一條曲線去比對引擎回報的 pos_x/y/z,兩邊不一致
 * 就鎖不上。驗證見 tests/animation §1(刀尖世界座標 ↔ pos_*,R²≈1)。
 *
 * 字面朝向:引擎 pos_y 對到世界 Z,而相機在 +Z 看向原點,所以世界 +Z 在畫面上是往下,
 * 字母的「上緣」在引擎座標是 y = -60。用 +60 當上緣會畫成上下鏡像的「И Ⅽ ∩ ⊥」。
 */
const GY_TOP = -60, GY_BOT = 60;
const GLYPH_W = 60, GLYPH_GAP = 40;
const ENGRAVE_MAX_WIDTH = 440;      // 行程 ±220;總寬超過就整體等比縮小
export const ENGRAVE_MAX_CHARS = 8;

/** 每字 = 筆畫列表;每筆畫 = [xu, yu] 折線(xu 0..1 字寬、yu 0..1 上緣→下緣)。 */
const STROKE_FONT: Record<string, number[][][]> = {
  " ": [],
  "-": [[[0.2, 0.5], [0.8, 0.5]]],
  A: [[[0, 1], [0.5, 0], [1, 1]], [[0.2, 0.6], [0.8, 0.6]]],
  B: [[[0, 0], [0, 1]], [[0, 0], [0.9, 0.1], [0.9, 0.4], [0, 0.5]], [[0, 0.5], [1, 0.6], [1, 0.9], [0, 1]]],
  C: [[[1, 0], [0, 0], [0, 1], [1, 1]]],
  D: [[[0, 0], [0, 1]], [[0, 0], [0.7, 0], [1, 0.3], [1, 0.7], [0.7, 1], [0, 1]]],
  E: [[[1, 0], [0, 0], [0, 1], [1, 1]], [[0, 0.5], [0.7, 0.5]]],
  F: [[[1, 0], [0, 0], [0, 1]], [[0, 0.5], [0.7, 0.5]]],
  G: [[[1, 0], [0, 0], [0, 1], [1, 1], [1, 0.55], [0.5, 0.55]]],
  H: [[[0, 0], [0, 1]], [[1, 0], [1, 1]], [[0, 0.5], [1, 0.5]]],
  I: [[[0.2, 0], [0.8, 0]], [[0.5, 0], [0.5, 1]], [[0.2, 1], [0.8, 1]]],
  J: [[[0.3, 0], [0.9, 0]], [[0.7, 0], [0.7, 0.8], [0.5, 1], [0.2, 1], [0, 0.8]]],
  K: [[[0, 0], [0, 1]], [[1, 0], [0, 0.5], [1, 1]]],
  L: [[[0, 0], [0, 1], [1, 1]]],
  M: [[[0, 1], [0, 0], [0.5, 0.6], [1, 0], [1, 1]]],
  N: [[[0, 1], [0, 0]], [[0, 0], [1, 1]], [[1, 1], [1, 0]]],
  O: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
  P: [[[0, 1], [0, 0], [1, 0], [1, 0.5], [0, 0.5]]],
  Q: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], [[0.6, 0.6], [1, 1]]],
  R: [[[0, 1], [0, 0], [1, 0], [1, 0.5], [0, 0.5]], [[0.3, 0.5], [1, 1]]],
  S: [[[1, 0], [0, 0], [0, 0.5], [1, 0.5], [1, 1], [0, 1]]],
  T: [[[0, 0], [1, 0]], [[0.5, 0], [0.5, 1]]],
  U: [[[0, 0], [0, 1], [1, 1], [1, 0]]],
  V: [[[0, 0], [0.5, 1], [1, 0]]],
  W: [[[0, 0], [0.25, 1], [0.5, 0.4], [0.75, 1], [1, 0]]],
  X: [[[0, 0], [1, 1]], [[1, 0], [0, 1]]],
  Y: [[[0, 0], [0.5, 0.5], [1, 0]], [[0.5, 0.5], [0.5, 1]]],
  Z: [[[0, 0], [1, 0], [0, 1], [1, 1]]],
  "0": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], [[1, 0.15], [0, 0.85]]],
  "1": [[[0.2, 0.2], [0.5, 0], [0.5, 1]], [[0.2, 1], [0.8, 1]]],
  "2": [[[0, 0], [1, 0], [1, 0.5], [0, 0.5], [0, 1], [1, 1]]],
  "3": [[[0, 0], [1, 0], [1, 1], [0, 1]], [[0.3, 0.5], [1, 0.5]]],
  "4": [[[0, 0], [0, 0.5], [1, 0.5]], [[1, 0], [1, 1]]],
  "5": [[[1, 0], [0, 0], [0, 0.5], [1, 0.5], [1, 1], [0, 1]]],
  "6": [[[1, 0], [0, 0], [0, 1], [1, 1], [1, 0.5], [0, 0.5]]],
  "7": [[[0, 0], [1, 0], [1, 1]]],
  "8": [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], [[0, 0.5], [1, 0.5]]],
  "9": [[[1, 0.5], [0, 0.5], [0, 0], [1, 0], [1, 1], [0, 1]]],
};

/** 文字 → 引擎座標(mm)筆畫;與引擎 _stroke_font.text_strokes() 逐點相同。 */
export function textStrokes(text: string): number[][][] {
  const t = text.slice(0, ENGRAVE_MAX_CHARS);
  const n = t.length;
  if (!n) return [];
  const total = n * GLYPH_W + (n - 1) * GLYPH_GAP;
  const s = Math.min(1, ENGRAVE_MAX_WIDTH / total);
  const w = GLYPH_W * s, gap = GLYPH_GAP * s;
  const yTop = GY_TOP * s, yBot = GY_BOT * s;
  const left0 = -(n * w + (n - 1) * gap) / 2;
  const out: number[][][] = [];
  for (let i = 0; i < n; i++) {
    const left = left0 + i * (w + gap);
    for (const stroke of STROKE_FONT[t[i]] ?? []) {
      out.push(stroke.map(([xu, yu]) => [left + xu * w, yTop + yu * (yBot - yTop)]));
    }
  }
  return out;
}

/** setpoint 的 ASCII 碼列 → 文字;與引擎 codes_to_text() 同規則(0 / 未知碼 = 空白,去尾)。 */
export function engraveText(setpoints: Record<string, number>): string {
  if (!("engrave_char_1" in setpoints)) return "NCUT";   // 舊 telemetry(無此 setpoint)→ 預設
  let s = "";
  for (let i = 1; i <= ENGRAVE_MAX_CHARS; i++) {
    const code = Math.round(setpoints[`engrave_char_${i}`] ?? 0);
    const ch = code >= 32 && code < 127 ? String.fromCharCode(code).toUpperCase() : " ";
    s += ch in STROKE_FONT ? ch : " ";
  }
  return s.replace(/\s+$/, "");
}

const NCUT_STROKES = textStrokes("NCUT");

// 刻字筆畫快取:文字沒變就沿用同一個陣列(參照相等,呼叫端可拿來當 dirty key)
let engraveCache: { text: string; strokes: number[][][] } = { text: "NCUT", strokes: NCUT_STROKES };

/** 由 snapshot.setpoints 取得目前刻字筆畫(mm)。 */
export function engraveStrokes(setpoints: Record<string, number>): number[][][] {
  const text = engraveText(setpoints);
  if (text !== engraveCache.text) engraveCache = { text, strokes: textStrokes(text) };
  return engraveCache.strokes;
}

export function cncToolPath(
  progress: number, pattern: number, strokes: number[][][] = NCUT_STROKES,
): [number, number, number] {
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
  if (!strokes.length) return [0, 0, 50];   // 全空白:停刀在原點上方(與引擎一致)
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
 * 相位鎖定:由引擎回報的 (x, y, z) 找出最接近的相位,再把本地相位往它拉。
 *
 * **三個座標都要比對**。只用 (x, y) 會在刀路自交處對不準:pattern 0 的「CNC」字樣裡,
 * 每一筆畫的起點與終點在 XY 上重合(抬刀 z=+50 與下刀 z=-50 是同一個 XY),
 * 只比 XY 就可能鎖到相反的抬刀 / 下刀相位 —— 畫面上會看到刀該抬時沒抬。
 * z 的量級(±50)比 XY(±220)小,所以加權放大,讓它真的能當判別依據。
 *
 * 只在「本地相位附近的窗」內搜尋,避免每次遙測到達就跳一大段;
 * 若誤差大到超出窗(剛開機 / 換件 / 學生改了 pattern)就直接硬同步。
 *
 * @returns 修正後的相位 ∈ [0,1)
 */
const Z_WEIGHT = 4;                 // z 的權重(補償它比 XY 小一個量級)
const LOCK_TAU = 0.05;              // 收斂時間常數(秒)

export function lockCncPhase(
  local: number, reportedX: number, reportedY: number, reportedZ: number, pattern: number,
  dt = 1 / 60, strokes: number[][][] = NCUT_STROKES,
): number {
  const SAMPLES = 256;
  const WINDOW = 0.12;              // 只信任前後 12% 的相位窗
  let bestNear = -1, bestNearErr = Infinity;
  let bestAny = -1, bestAnyErr = Infinity;
  for (let i = 0; i < SAMPLES; i++) {
    const ph = i / SAMPLES;
    const [x, y, z] = cncToolPath(ph, pattern, strokes);
    const err = (x - reportedX) ** 2 + (y - reportedY) ** 2 + (Z_WEIGHT * (z - reportedZ)) ** 2;
    if (err < bestAnyErr) { bestAnyErr = err; bestAny = ph; }
    let d = Math.abs(ph - local);
    d = Math.min(d, 1 - d);
    if (d <= WINDOW && err < bestNearErr) { bestNearErr = err; bestNear = ph; }
  }
  // 窗內找得到(誤差 < 30 mm 等效)→ 拉近;否則硬同步到全域最佳。
  if (bestNear >= 0 && bestNearErr < 30 * 30) {
    let diff = bestNear - local;
    if (diff > 0.5) diff -= 1; else if (diff < -0.5) diff += 1;
    // 增益必須是 delta-based。用固定的每幀比例會讓「相位自己往前走」與「被拉回來」
    // 的平衡點隨 frame rate 改變 —— 低 fps 機器上刀尖會固定落後遙測位置一小段。
    const next = local + diff * (1 - Math.exp(-dt / LOCK_TAU));
    return (next % 1 + 1) % 1;
  }
  return bestAny >= 0 ? bestAny : local;
}
