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
  welding_cell: "source",
  laser_cutter: "source",
  aoi_inspection: "source",
  packaging_machine: "source",
  melting_furnace: "source",
  die_casting_machine: "source",
  induction_heater: "source",
  forging_press: "source",
  trimming_press: "source",
  grinding_polisher: "source",
  cleaning_dryer: "source",
  plating_line: "source",
  assembly_station: "source",
  torque_tester: "source",
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
  welding_cell: "焊接接合",
  laser_cutter: "雷射切割",
  aoi_inspection: "AOI 檢測",
  packaging_machine: "包裝出貨",
  melting_furnace: "熔煉出湯",
  die_casting_machine: "壓鑄成形",
  induction_heater: "感應加熱",
  forging_press: "熱模鍛造",
  trimming_press: "切邊整修",
  grinding_polisher: "研磨拋光",
  cleaning_dryer: "清洗乾燥",
  plating_line: "電鍍表面",
  assembly_station: "零件組裝",
  torque_tester: "扭力測試",
};

/** 各機種在產線視圖中的縮放(風機 20 m 高、電表 6 m,不縮會互相打架)。 */
export const LINE_SCALE: Record<string, number> = {
  wind_turbine: 0.20, stamping_press: 0.40, injection_molding: 0.55,
  heat_treat_furnace: 0.60, semi_process_chamber: 0.65, robot_arm_6axis: 0.75,
  air_compressor: 0.60, conveyor: 0.55, energy_meter: 0.55, agv_mobile_robot: 0.85,
  cnc_machining_center: 0.75,
  aoi_inspection: 0.70, welding_cell: 0.62, laser_cutter: 0.65, packaging_machine: 0.65,
  // 鑄造 / 鍛造上游(2026-08-21):熔煉爐與鍛造壓機都是大機台(鍛壓機 9 m 高),
  // 不縮會把整條線的比例壓垮。
  melting_furnace: 0.55, die_casting_machine: 0.50, induction_heater: 0.58,
  forging_press: 0.42, trimming_press: 0.62,
  // 手工具後段(2026-08-22):清洗機與電鍍線是**橫向很長**的連續機(網帶 13 m / 槽列 15 m),
  // 不縮會把整條產線的視圖撐爆。
  grinding_polisher: 0.60, cleaning_dryer: 0.34, plating_line: 0.30,
  assembly_station: 0.62, torque_tester: 0.68,
};

/**
 * 各機種在主線方向(X)的佔地半寬(世界單位,已含 LINE_SCALE)。
 * 用來讓相鄰工站「邊靠邊」而不是等距排 —— 手臂才伸得到上游機台的出料側。
 * 數字是照各元件的底座尺寸抓的,寧可略寬(留點走道),不要互相穿模。
 */
// 這些是 `node preview/measure.mjs` 從真實場景量回來的(已套 LINE_SCALE)+0.3 餘隙,
// 不是估的。改過任何機種的幾何或 LINE_SCALE 之後,重跑一次量測再貼回來。
//
// [left, right] = 模型「擺放原點」向左 / 向右的實際延伸 —— 不是對稱的 halfW。
// 射出機的料管在原點左邊 5.5、合模部只有 3.3;先前用對稱 4.7 擺,整台向左凸出料道
// 0.8、右側又留 1.4 空隙,取件箭頭就飄在走道上(這正是「設備不在對的位置」的主因)。
const EXTENT_X: Record<string, [number, number]> = {
  cnc_machining_center: [3.2, 3.2],
  stamping_press: [1.5, 1.5],
  injection_molding: [5.8, 3.6],
  semi_process_chamber: [3.1, 3.0],
  heat_treat_furnace: [2.4, 3.0],
  robot_arm_6axis: [3.9, 1.8],
  // AGV 是「巡迴包絡」不是瞬時包圍盒:compact 模式路線縮 0.25 後車體活動半徑
  // ±(8×0.25+1.2)×0.85 ≈ 2.7,再加餘隙 —— 量測抓到的是車子當下停的位置,不能用。
  agv_mobile_robot: [3.0, 3.0],
  conveyor: [3.8, 3.8],
  wind_turbine: [2.4, 1.5],
  air_compressor: [3.3, 3.3],
  energy_meter: [1.5, 1.5],
  // 新機種(2026-08):preview/measure.mjs 實測(含 LINE_SCALE + 0.3 餘隙)
  aoi_inspection: [3.1, 3.1],
  welding_cell: [4.1, 4.0],
  laser_cutter: [3.1, 4.3],
  packaging_machine: [3.2, 3.5],
  // 鑄造 / 鍛造上游(2026-08-21):preview/measure.mjs 實測(含 LINE_SCALE + 0.3 餘隙)
  melting_furnace: [3.0, 2.4],
  die_casting_machine: [3.3, 2.9],
  induction_heater: [3.3, 3.3],
  forging_press: [1.8, 1.8],
  trimming_press: [2.0, 1.8],
  // 手工具後段(2026-08-22):preview/measure.mjs 實測(含 LINE_SCALE + 0.3 餘隙)
  grinding_polisher: [2.1, 2.1],
  cleaning_dryer: [2.5, 2.5],
  plating_line: [2.7, 2.7],
  assembly_station: [2.0, 1.9],
  torque_tester: [1.9, 1.9],
};
const extentX = (t: string): [number, number] => EXTENT_X[t] ?? [3.0, 3.0];

/** 相鄰工站之間留的走道 */
const AISLE = 1.6;
/** 手臂取件時伸進上游機台出料口的深度。先前 1.0 會讓整支前臂穿過 CNC 鈑金 /
 *  沖壓機架 —— 夾爪停在出料口「口沿」內一點就讀得懂,不必潛進機腹。 */
const ARM_REACH_IN = 0.4;
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
  // 輸入序已是「producer → 手臂 → producer」這種合法製程序(手臂夾在兩台 source 之間)
  // 就依原序擺 —— 產線站序(line:)傳進來時不能被角色排序拆散,手臂要伸得到兩站之間。
  const nonUtil = withRole.filter((d) => d.role !== "utility");
  const alternating = nonUtil.length >= 3 && nonUtil.every((d, i) =>
    (d.role === "handler") === (i % 2 === 1)) && nonUtil[nonUtil.length - 1].role !== "handler";
  const main = alternating ? nonUtil
    : nonUtil.sort((a, b) => ORDER[a.role] - ORDER[b.role]);
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
      const [l, r] = extentX(d.template);
      placed.push({ id: d.id, template: d.template, role: d.role, x: cursor + l, z: 0, yaw: 0 });
      cursor += l + r + AISLE;
    }
  });

  // 整條線置中
  const shift = -cursor / 2;
  for (const p of placed) p.x += shift;

  let uCursor = 0;
  const uPlaced: Placed[] = [];
  utils.forEach((d) => {
    const [l, r] = extentX(d.template);
    uPlaced.push({ id: d.id, template: d.template, role: d.role,
                   x: uCursor + l, z: UTILITY_Z, yaw: 0 });
    uCursor += l + r + AISLE;
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

  // 料道只有在「真的有上下游」時才畫 —— 單機廠畫一條線反而誤導。
  // 範圍用實際邊界(x ± extent),不是機台中心 —— 原點偏心的機種(射出機)才不會凸出料道。
  const mainPlaced = placed.filter((p) => p.role !== "utility");
  const lane = main.length >= 2
    ? { from: Math.min(...mainPlaced.map((p) => p.x - extentX(p.template)[0])) - 1,
        to: Math.max(...mainPlaced.map((p) => p.x + extentX(p.template)[1])) + 1 }
    : null;

  return { placed, lane, flowText, utilityText };
}
