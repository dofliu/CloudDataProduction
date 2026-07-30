/**
 * 廠內產線的製程語意:設備在一條線上各自扮演什麼角色、怎麼排、料怎麼流。
 *
 * 為什麼需要這層:先前廠內視圖是把設備等距排成一列,各做各的 —— 一支手臂在空中
 * 取放、旁邊一台 CNC 自己加工,看不出兩者有任何關係。學生看不懂「這條線在做什麼」。
 *
 * 這裡**只決定擺位與說明文字**,不動任何設備的動作 —— 每台的動畫仍然完全由自己的
 * 引擎 tag 驅動(契約 §0 鐵則一)。手臂的取放點是它自己 keyframe 姿態算出來的,
 * 這裡做的是反過來把「上游機台的出料側」擺到那個取件點上、把輸送帶擺到放件點上。
 *
 * 誠實邊界(2026-07 更新):公司 YAML 有 `line:` 宣告時,引擎層真的有工件在流
 * (engine/line.py),FactoryLine3D 會把緩衝方塊擺在這裡算出的取放點上 —— 空間對位
 * 與物料帳在同一個點會合。沒有 `line:` 的公司仍只是空間對位,前端不假裝同步。
 */
import { ARM_PICK_LOCAL } from "./RobotArm3D";

/** 製程角色。決定排列順序與說明文字。 */
export type Role = "source" | "handler" | "transport" | "utility";

const ROLE: Record<string, Role> = {
  cnc_machining_center: "source",
  stamping_press: "source",
  injection_molding: "source",
  semi_process_chamber: "source",
  heat_treat_furnace: "source",
  robot_arm_6axis: "handler",
  agv_mobile_robot: "handler",
  conveyor: "transport",
  air_compressor: "utility",
  energy_meter: "utility",
  wind_turbine: "utility",
};

export const roleOf = (template: string): Role => ROLE[template] ?? "utility";

/** 製程動詞:這台在這條線上「做什麼」,用於流程說明。 */
const VERB: Record<string, string> = {
  cnc_machining_center: "CNC 加工",
  stamping_press: "沖壓成形",
  injection_molding: "射出成型",
  semi_process_chamber: "腔體製程",
  heat_treat_furnace: "熱處理",
  robot_arm_6axis: "手臂取放",
  agv_mobile_robot: "AGV 搬運",
  conveyor: "輸送帶出料",
  air_compressor: "空壓供氣",
  energy_meter: "用電計量",
  wind_turbine: "風力發電",
};

/** 各機種在產線視圖中的縮放(風機 20 m 高、電表 6 m,不縮會互相打架)。 */
export const LINE_SCALE: Record<string, number> = {
  wind_turbine: 0.20, stamping_press: 0.40, injection_molding: 0.55,
  heat_treat_furnace: 0.60, semi_process_chamber: 0.65, robot_arm_6axis: 0.75,
  air_compressor: 0.60, conveyor: 0.55, energy_meter: 0.55, agv_mobile_robot: 0.85,
  cnc_machining_center: 0.75,
};

/**
 * 各機種在主線方向(X)的佔地半寬(世界單位,已含 LINE_SCALE)。
 * 用來讓相鄰工站「邊靠邊」而不是等距排 —— 手臂才伸得到上游機台的出料側。
 * 數字是照各元件的底座尺寸抓的,寧可略寬(留點走道),不要互相穿模。
 */
// 這些是 `node preview/measure.mjs` 從真實場景量回來的(已套 LINE_SCALE)+0.3 餘隙,
// 不是估的。改過任何機種的幾何或 LINE_SCALE 之後,重跑一次量測再貼回來。
const HALF_W: Record<string, number> = {
  cnc_machining_center: 3.2, stamping_press: 1.5, injection_molding: 4.7,
  semi_process_chamber: 3.0, heat_treat_furnace: 2.7, conveyor: 3.8,
  agv_mobile_robot: 1.5, air_compressor: 3.3, energy_meter: 1.5, wind_turbine: 2.1,
  robot_arm_6axis: 2.9,
};
const halfW = (t: string) => HALF_W[t] ?? 3.0;

/** 相鄰工站之間留的走道 */
const AISLE = 1.6;
/** 手臂取件時伸進上游機台出料口的深度 —— 夾爪要在機台裡面,不是站在走道上比劃 */
const ARM_REACH_IN = 1.0;
/** 手臂放件點壓在輸送帶起點上一點,看起來才是「放到帶子上」 */
const ARM_DROP_OVER = 0.8;
/** 廠務排在主線後方 */
const UTILITY_Z = -7.5;

/**
 * 手臂轉 +90°:取放兩點在本地座標的連線是沿 Z 的(j1=∓45° 只差在繞基座的方向),
 * 轉 90° 之後就落在 X 軸 = 主線方向,取件在 −X(上游)、放件在 +X(下游)。
 */
const ARM_YAW = Math.PI / 2;
/** 轉 90° 後,取放點相對手臂基座的 X 位移與 Z 位移(已含縮放)。
 *  REACH_X 供 FactoryLine3D 把產線緩衝方塊擺在手臂真正的取件 / 放件點上。 */
const ARM_S = LINE_SCALE.robot_arm_6axis ?? 0.7;
export const ARM_REACH_X = Math.abs(ARM_PICK_LOCAL[2]) * ARM_S;   // 本地 z → 轉後的 X
const ARM_REACH_Z = Math.abs(ARM_PICK_LOCAL[0]) * ARM_S;   // 本地 x → 轉後的 Z

export interface Placed {
  id: string;
  template: string;
  role: Role;
  x: number;
  z: number;
  /** 繞 Y 軸轉向(rad) */
  yaw: number;
  /** 手臂專用:上下游有真機台接手時,不要再畫自己的料檯 */
  stations?: { pick?: boolean; place?: boolean };
}

export interface Layout {
  placed: Placed[];
  /** 主線料道的 x 範圍(畫地面導引線用);沒有成線就是 null */
  lane: { from: number; to: number } | null;
  /** 「射出成型 → 手臂取放 → 輸送帶出料」 */
  flowText: string;
  /** 「廠務:空壓供氣 · 用電計量」,沒有就空字串 */
  utilityText: string;
}

/**
 * 把一組設備排成一條看得懂的產線。
 *
 * 主線由左至右:產出機台 → 搬運 → 輸送帶,相鄰工站邊靠邊。廠務類(空壓 / 電表 / 風機)
 * 不佔主線、排在後方 —— 它們不參與工件流動,擺進主線反而讓流程讀不出來。
 */
export function layoutLine(devices: { id: string; template: string }[]): Layout {
  const ORDER: Record<Role, number> = { source: 0, handler: 1, transport: 2, utility: 3 };
  const withRole = devices.map((d) => ({ ...d, role: roleOf(d.template) }));
  const main = withRole
    .filter((d) => d.role !== "utility")
    .sort((a, b) => ORDER[a.role] - ORDER[b.role]);
  const utils = withRole.filter((d) => d.role === "utility");

  const placed: Placed[] = [];
  let cursor = 0;              // 下一台可以開始佔用的 x
  main.forEach((d, i) => {
    if (d.template === "robot_arm_6axis") {
      // 手臂:把取件點對到 cursor(= 上游機台的出料側),放件點就成為下一台的起點。
      // 基座往後退 ARM_REACH_Z,手臂才是「伸進線上」而不是站在線中間擋路。
      // 取件點要落在上游機台的出料口「裡面」一點(cursor 是上游的右緣)
      const pickAt = i === 0 ? cursor : cursor - AISLE - ARM_REACH_IN;
      const x = pickAt + ARM_REACH_X;
      placed.push({
        id: d.id, template: d.template, role: d.role,
        x, z: -ARM_REACH_Z, yaw: ARM_YAW,
        // 上游有機台就不畫取料檯;下游有輸送帶就不畫放料檯
        stations: { pick: i === 0, place: i === main.length - 1 },
      });
      // 放件點壓在下一台(輸送帶)的起點上
      cursor = x + ARM_REACH_X - ARM_DROP_OVER;
    } else {
      const hw = halfW(d.template);
      placed.push({ id: d.id, template: d.template, role: d.role, x: cursor + hw, z: 0, yaw: 0 });
      cursor += 2 * hw + AISLE;
    }
  });

  // 整條線置中
  const shift = -cursor / 2;
  for (const p of placed) p.x += shift;

  let uCursor = 0;
  const uPlaced: Placed[] = [];
  utils.forEach((d) => {
    const hw = halfW(d.template);
    uPlaced.push({ id: d.id, template: d.template, role: d.role,
                   x: uCursor + hw, z: UTILITY_Z, yaw: 0 });
    uCursor += 2 * hw + AISLE;
  });
  for (const p of uPlaced) p.x += -uCursor / 2;
  placed.push(...uPlaced);

  const flowText = main.length
    ? main.map((d) => VERB[d.template] ?? d.template).join(" → ")
      + (main.length === 1 ? "(單機)" : "")
    : "";
  const utilityText = utils.length
    ? "廠務:" + utils.map((d) => VERB[d.template] ?? d.template).join(" · ")
    : "";

  // 料道只有在「真的有上下游」時才畫 —— 單機廠畫一條線反而誤導
  const lane = main.length >= 2
    ? { from: Math.min(...placed.filter((p) => p.role !== "utility").map((p) => p.x)) - 4,
        to: Math.max(...placed.filter((p) => p.role !== "utility").map((p) => p.x)) + 4 }
    : null;

  return { placed, lane, flowText, utilityText };
}
