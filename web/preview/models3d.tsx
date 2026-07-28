/**
 * 3D 機種預覽(dev only)—— 用合成 snapshot 檢視全部 11 種設備動畫,不必啟後端。
 *
 *   cd web && npx vite
 *   瀏覽器開 http://localhost:5173/preview/models3d.html
 *   自動截圖:node preview/shot3d.mjs <outdir>
 *
 * 每個 template 各兩格:健康 running / 退化中(或故障),用來驗收
 * docs/animation_binding.md 的綁定表與視覺語彙是否真的接上資料。
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { buildMotion } from "../src/world/deviceMotion";
import CncMachine3D from "../src/world/CncMachine3D";
import RobotArm3D from "../src/world/RobotArm3D";
import InjectionMolding3D from "../src/world/InjectionMolding3D";
import AgvMobileRobot3D from "../src/world/AgvMobileRobot3D";
import Conveyor3D from "../src/world/Conveyor3D";
import StampingPress3D from "../src/world/StampingPress3D";
import WindTurbine3D from "../src/world/WindTurbine3D";
import AirCompressor3D from "../src/world/AirCompressor3D";
import EnergyMeter3D from "../src/world/EnergyMeter3D";
import ProcessChamber3D from "../src/world/ProcessChamber3D";
import HeatTreatFurnace3D from "../src/world/HeatTreatFurnace3D";
import FactoryLine3D from "../src/world/FactoryLine3D";

type Case = { title: string; template: string; state: string; tags: Record<string, number>;
              setpoints?: Record<string, number>; coils?: Record<string, boolean> };

const CASES: Case[] = [
  { title: "CNC · 健康", template: "cnc_machining_center", state: "running",
    tags: { spindle_speed: 8000, spindle_load: 70, spindle_current: 8, spindle_temp: 58, vibration_rms: 1.3,
            tool_wear: 8, coolant_temp: 30, cycle_time: 45, part_count: 12, pos_x: -140, pos_y: 20, pos_z: -50 },
    setpoints: { spindle_rpm_setpoint: 8000, machining_pattern: 0 } },
  { title: "CNC · 軸承退化 + 刀鈍", template: "cnc_machining_center", state: "running",
    tags: { spindle_speed: 8000, spindle_load: 70, spindle_current: 10.6, spindle_temp: 91, vibration_rms: 9.2,
            tool_wear: 82, coolant_temp: 39, cycle_time: 57, part_count: 40, pos_x: 90, pos_y: -40, pos_z: -50 },
    setpoints: { machining_pattern: 1 } },
  { title: "手臂 · 取件姿態", template: "robot_arm_6axis", state: "running",
    tags: { joint_angle_1: -45, joint_angle_2: 15, joint_angle_3: 50, joint_angle_4: 0, joint_angle_5: 25,
            joint_angle_6: 0, vibration_rms: 1.1, cycle_count: 88, joint_temp_1: 40, joint_temp_3: 43 } },
  { title: "手臂 · 減速機退化", template: "robot_arm_6axis", state: "running",
    tags: { joint_angle_1: 45, joint_angle_2: -20, joint_angle_3: 30, joint_angle_4: 0, joint_angle_5: 80,
            joint_angle_6: 0, vibration_rms: 8.6, cycle_count: 640, joint_temp_1: 52, joint_temp_3: 58 } },
  { title: "AGV · 載貨移動", template: "agv_mobile_robot", state: "moving",
    tags: { pos_x: 12, pos_y: 2, heading: 0, speed: 0.15, payload: 30, battery_soc: 74, battery_voltage: 51.3,
            motor_current_l: 4.4, motor_current_r: 4.0, motor_temp: 38, vibration_rms: 0 } },
  { title: "AGV · 停靠上料站", template: "agv_mobile_robot", state: "moving",
    tags: { pos_x: 18, pos_y: 2, heading: 90, speed: 0, payload: 0, battery_soc: 22, battery_voltage: 47.8,
            motor_current_l: 0.4, motor_current_r: 0.4, motor_temp: 47 } },
  { title: "輸送帶 · 健康", template: "conveyor", state: "running",
    tags: { belt_speed: 1.0, motor_current: 5.1, vibration_rms: 0.52 } },
  { title: "輸送帶 · 軸承退化", template: "conveyor", state: "running",
    tags: { belt_speed: 1.0, motor_current: 6.8, vibration_rms: 1.9 } },
  { title: "沖壓 · 下死點", template: "stamping_press", state: "running",
    tags: { tonnage: 198, stroke_rate: 60, ram_position: 3, die_temp: 66, motor_current: 32,
            vibration_rms: 1.5, lubrication_pressure: 3.0, burr_rate: 0.6, stroke_count: 3200 } },
  { title: "沖壓 · 模具磨耗 + 潤滑不足", template: "stamping_press", state: "running",
    tags: { tonnage: 205, stroke_rate: 58, ram_position: 96, die_temp: 82, motor_current: 43,
            vibration_rms: 8.8, lubrication_pressure: 1.6, burr_rate: 12.4, stroke_count: 91000 } },
  { title: "射出 · 射出段", template: "injection_molding", state: "running",
    tags: { clamping_force: 130, injection_pressure: 158, screw_speed: 150, barrel_temp_1: 225, barrel_temp_2: 235,
            barrel_temp_3: 240, barrel_temp_4: 230, oil_temp: 58, cycle_time: 30.2, vibration_rms: 1.1, shot_count: 1400 } },
  { title: "射出 · 螺桿磨耗", template: "injection_molding", state: "running",
    tags: { clamping_force: 121, injection_pressure: 95, screw_speed: 128, barrel_temp_1: 234, barrel_temp_2: 228,
            barrel_temp_3: 249, barrel_temp_4: 222, oil_temp: 79, cycle_time: 37.4, vibration_rms: 7.9, shot_count: 52000 } },
  { title: "風機 · 發電中", template: "wind_turbine", state: "running",
    tags: { wind_speed: 11.2, rotor_rpm: 13.4, power_output: 1620, pitch_angle: 0, generator_temp: 62,
            gearbox_temp: 58, nacelle_temp: 31, vibration_rms: 2.1, total_energy: 44000 } },
  { title: "風機 · 教師停機(順槳)", template: "wind_turbine", state: "idle",
    tags: { wind_speed: 10.4, rotor_rpm: 0.03, power_output: 0, pitch_angle: 88, generator_temp: 33,
            gearbox_temp: 34, nacelle_temp: 26, vibration_rms: 0.9, total_energy: 44100 },
    coils: { run_enable: false } },
  { title: "空壓機 · 健康", template: "air_compressor", state: "running",
    tags: { outlet_pressure: 7.42, flow: 7.8, motor_current: 19.1, motor_temp: 57, vibration_rms: 1.0, running_hours: 820 },
    setpoints: { pressure_setpoint: 7.5 } },
  { title: "空壓機 · 濾網阻塞 + 軸承退化", template: "air_compressor", state: "running",
    tags: { outlet_pressure: 7.05, flow: 5.4, motor_current: 26.8, motor_temp: 76, vibration_rms: 8.4, running_hours: 9100 },
    setpoints: { pressure_setpoint: 7.5 } },
  { title: "電表 · 正常", template: "energy_meter", state: "running",
    tags: { active_power: 186, voltage_l1: 376, voltage_l2: 374.5, voltage_l3: 377.2, current_l1: 304,
            current_l2: 298, current_l3: 313, power_factor: 0.941, energy_total: 128400 } },
  { title: "電表 · 功因下滑", template: "energy_meter", state: "running",
    tags: { active_power: 190, voltage_l1: 376, voltage_l2: 374.5, voltage_l3: 377.2, current_l1: 372,
            current_l2: 341, current_l3: 398, power_factor: 0.733, energy_total: 402000 } },
  { title: "腔體 · 製程中", template: "semi_process_chamber", state: "running",
    tags: { chamber_pressure: 57, chamber_temp: 56, rf_power: 1503, gas_flow_1: 50.2, gas_flow_2: 30.1,
            gas_flow_3: 15.0, vacuum_pump_current: 6.4, pump_temp: 55, throughput: 24.6, particle_count: 4.3, wafer_count: 900 } },
  { title: "腔體 · 製程漂移(微粒暴增)", template: "semi_process_chamber", state: "running",
    tags: { chamber_pressure: 74, chamber_temp: 57, rf_power: 1498, gas_flow_1: 60.4, gas_flow_2: 30.0,
            gas_flow_3: 15.1, vacuum_pump_current: 11.8, pump_temp: 74, throughput: 19.8, particle_count: 52, wafer_count: 41000 } },
  { title: "熱處理爐 · 到溫", template: "heat_treat_furnace", state: "running",
    tags: { furnace_temp: 897, temp_uniformity: 4.2, chamber_pressure: 1019, heating_power: 61,
            element_current: 121, atmosphere_flow: 40, oxygen_ppm: 9, energy_kwh: 5400 } },
  { title: "熱處理爐 · 元件老化 + 洩漏", template: "heat_treat_furnace", state: "running",
    tags: { furnace_temp: 842, temp_uniformity: 31, chamber_pressure: 1019, heating_power: 88,
            element_current: 156, atmosphere_flow: 39, oxygen_ppm: 186, energy_kwh: 91000 } },
  { title: "CNC · 故障(停轉 + 冒煙)", template: "cnc_machining_center", state: "fault",
    tags: { spindle_speed: 0, spindle_load: 0, spindle_current: 0.8, spindle_temp: 94, vibration_rms: 12.6,
            tool_wear: 88, coolant_temp: 41, cycle_time: 58, part_count: 51, pos_x: 0, pos_y: 0, pos_z: 100 } },
  { title: "沖壓 · 教師停機", template: "stamping_press", state: "idle",
    tags: { tonnage: 0.2, stroke_rate: 0, ram_position: 0, die_temp: 34, motor_current: 3,
            vibration_rms: 0.15, lubrication_pressure: 1.2, burr_rate: 4, stroke_count: 40000 },
    coils: { run_enable: false } },
];

const SCENES: Record<string, React.ComponentType<any>> = {
  cnc_machining_center: CncMachine3D, robot_arm_6axis: RobotArm3D, injection_molding: InjectionMolding3D,
  agv_mobile_robot: AgvMobileRobot3D, conveyor: Conveyor3D, stamping_press: StampingPress3D,
  wind_turbine: WindTurbine3D, air_compressor: AirCompressor3D, energy_meter: EnergyMeter3D,
  semi_process_chamber: ProcessChamber3D, heat_treat_furnace: HeatTreatFurnace3D,
};

// 用場景預設的 sim 倍率,才看得到真實課堂的視覺換算行為
const MULTIPLIER = 120;

function Cell({ c }: { c: Case }) {
  const Scene = SCENES[c.template];
  const motion = buildMotion(
    { template: c.template, state: c.state, tags: c.tags, setpoints: c.setpoints, coils: c.coils } as any,
    MULTIPLIER,
  );
  return (
    <div className="cell">
      <div className="cap">{c.title}</div>
      <Scene motion={motion} />
    </div>
  );
}

/**
 * 一次只掛一個 Canvas —— 瀏覽器的 WebGL context 上限約 16 個,全部一起開會被回收、
 * 畫面變黑。用 ?i=<index> 逐台看,?all=1 才一次全開(僅供快速掃視,可能超上限)。
 */
/** 廠內產線視圖:一個 Canvas 擺多台,驗收共用燈光 / 縮放 / 標籤。 */
function Line() {
  const picked = [0, 2, 6, 8, 10, 18, 20].map((i) => CASES[i]);
  const snapshots: Record<string, any> = {};
  const devices = picked.map((c, i) => {
    const id = `d${String(i + 1).padStart(2, "0")}`;
    snapshots[id] = { id, template: c.template, state: c.state, state_code: 0,
                      tags: c.tags, setpoints: c.setpoints, coils: c.coils };
    return { id, template: c.template };
  });
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <FactoryLine3D devices={devices} snapshots={snapshots} multiplier={MULTIPLIER} />
    </div>
  );
}

function App() {
  const q = new URLSearchParams(location.search);
  if (q.get("line") === "1") return <Line />;
  if (q.get("all") === "1") {
    return <div className="grid">{CASES.map((c, i) => <Cell c={c} key={i} />)}</div>;
  }
  const i = Math.max(0, Math.min(CASES.length - 1, Number(q.get("i") ?? 0)));
  return (
    <div className="grid" style={{ gridTemplateColumns: "1fr" }}>
      <Cell c={CASES[i]} key={i} />
    </div>
  );
}

(window as any).__caseCount = CASES.length;
(window as any).__caseTitles = CASES.map((c) => c.title);
createRoot(document.getElementById("root")!).render(<App />);
(window as any).__ready = true;
