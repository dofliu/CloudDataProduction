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
import AoiInspection3D from "../src/world/AoiInspection3D";
import WeldingCell3D from "../src/world/WeldingCell3D";
import LaserCutter3D from "../src/world/LaserCutter3D";
import PackagingMachine3D from "../src/world/PackagingMachine3D";
import MeltingFurnace3D from "../src/world/MeltingFurnace3D";
import DieCastingMachine3D from "../src/world/DieCastingMachine3D";
import InductionHeater3D from "../src/world/InductionHeater3D";
import ForgingPress3D from "../src/world/ForgingPress3D";
import TrimmingPress3D from "../src/world/TrimmingPress3D";
import GrindingPolisher3D from "../src/world/GrindingPolisher3D";
import CleaningDryer3D from "../src/world/CleaningDryer3D";
import PlatingLine3D from "../src/world/PlatingLine3D";
import AssemblyStation3D from "../src/world/AssemblyStation3D";
import TorqueTester3D from "../src/world/TorqueTester3D";
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
            joint_angle_6: 0, vibration_rms: 1.1, cycle_count: 88, joint_temp_1: 40, joint_temp_3: 43,
            // tcp 由引擎 forward_kinematics(同組角度)算出 —— 假資料也不能自己編一組
            tcp_x: 821.5, tcp_y: -821.5, tcp_z: 151.3 } },
  { title: "手臂 · 減速機退化", template: "robot_arm_6axis", state: "running",
    tags: { joint_angle_1: 45, joint_angle_2: -20, joint_angle_3: 30, joint_angle_4: 0, joint_angle_5: 80,
            joint_angle_6: 0, vibration_rms: 8.6, cycle_count: 640, joint_temp_1: 52, joint_temp_3: 58,
            tcp_x: 624.9, tcp_y: 624.9, tcp_z: 1013.0 } },
  { title: "AGV · 載貨移動", template: "agv_mobile_robot", state: "moving",
    tags: { pos_x: 12, pos_y: 2, heading: 0, speed: 0.15, payload: 30, battery_soc: 74, battery_voltage: 51.3,
            motor_current_l: 4.4, motor_current_r: 4.0, motor_temp: 38, vibration_rms: 0,
            battery_temp: 29.6 } },
  { title: "AGV · 停靠上料站", template: "agv_mobile_robot", state: "moving",
    tags: { pos_x: 18, pos_y: 2, heading: 90, speed: 0, payload: 0, battery_soc: 22, battery_voltage: 47.8,
            motor_current_l: 0.4, motor_current_r: 0.4, motor_temp: 47, battery_temp: 34.2 } },
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
  // ── 新產業四機種(2026-08):索引 24 起,LINE_COMBOS 依賴前面的索引不動 ──
  { title: "AOI · 掃描中", template: "aoi_inspection", state: "running",
    tags: { camera_pos_x: 60, camera_pos_y: -50, light_intensity: 99, focus_score: 95,
            false_call_rate: 0.7, inspect_time: 15.2, vibration_rms: 0.4, inspected_count: 1240 } },
  { title: "AOI · 鏡頭污染 + 光源衰減", template: "aoi_inspection", state: "running",
    tags: { camera_pos_x: -30, camera_pos_y: 0, light_intensity: 81, focus_score: 66,
            false_call_rate: 9.4, inspect_time: 16.8, vibration_rms: 2.1, inspected_count: 45210 } },
  { title: "焊接 · 電弧沿焊道", template: "welding_cell", state: "running",
    tags: { torch_pos_x: 40, torch_pos_y: -60, arc_current: 181, arc_voltage: 24.2, wire_feed_rate: 7.9,
            gas_flow: 14.8, torch_temp: 315, spatter_rate: 1.1, vibration_rms: 0.5, weld_count: 860 } },
  { title: "焊接 · 噴嘴堵 + 送絲磨損", template: "welding_cell", state: "running",
    tags: { torch_pos_x: -120, torch_pos_y: 60, arc_current: 152, arc_voltage: 25.1, wire_feed_rate: 6.1,
            gas_flow: 10.2, torch_temp: 322, spatter_rate: 9.6, vibration_rms: 5.8, weld_count: 30400 } },
  { title: "雷切 · 沿輪廓出光", template: "laser_cutter", state: "running",
    tags: { head_pos_x: 150, head_pos_y: 20, laser_power: 2985, lens_temp: 46, chiller_temp: 22.4,
            assist_gas_pressure: 12.1, cut_speed: 34.6, dross_rate: 0.8, vibration_rms: 0.4, cut_count: 2210 } },
  { title: "雷切 · 鏡片污損 + 冷卻劣化", template: "laser_cutter", state: "running",
    tags: { head_pos_x: -80, head_pos_y: -100, laser_power: 2440, lens_temp: 88, chiller_temp: 33.5,
            assist_gas_pressure: 11.4, cut_speed: 24.8, dross_rate: 6.2, vibration_rms: 0.5, cut_count: 51300 } },
  { title: "包裝 · 封口循環", template: "packaging_machine", state: "running",
    tags: { jaw_gap: 12, seal_temp: 144.6, film_tension: 45.3, index_rate: 3.95, cycle_time: 15.2,
            reject_rate: 0.6, motor_current: 7.1, vibration_rms: 0.5, package_count: 6100 } },
  { title: "包裝 · 加熱器老化(封不牢)", template: "packaging_machine", state: "running",
    tags: { jaw_gap: 66, seal_temp: 118.2, film_tension: 41.0, index_rate: 3.28, cycle_time: 18.3,
            reject_rate: 7.8, motor_current: 9.4, vibration_rms: 3.2, package_count: 88400 } },
  // ── 鑄造 / 鍛造上游(2026-08-21)──────────────────────────
  { title: "熔煉 · 出湯傾轉", template: "melting_furnace", state: "running",
    tags: { tilt_angle: -38, bath_level: 42, melt_temp: 1447, shell_temp: 131, slag_ratio: 0.9,
            electrode_current: 792, power_input: 540, melt_cycle_time: 72.4, energy_kwh: 21600,
            tap_count: 4180 } },
  { title: "熔煉 · 爐襯磨蝕 + 爐渣堆積", template: "melting_furnace", state: "running",
    tags: { tilt_angle: 0, bath_level: 88, melt_temp: 1387, shell_temp: 233, slag_ratio: 6.8,
            electrode_current: 731, power_input: 685, melt_cycle_time: 112.9, energy_kwh: 48600,
            tap_count: 51200 } },
  { title: "壓鑄 · 鎖模射出", template: "die_casting_machine", state: "running",
    tags: { clamping_force: 347, shot_speed: 4.18, intensify_press: 878, die_temp_fixed: 219,
            die_temp_moving: 220, vacuum_level: 67, cycle_time: 68.4, shrinkage_rate: 0.38,
            porosity_rate: 0.72, vibration_rms: 1.9, cast_count: 3120 } },
  { title: "壓鑄 · 模具熱疲勞 + 真空劣化", template: "die_casting_machine", state: "running",
    tags: { clamping_force: 121, shot_speed: 0, intensify_press: 60, die_temp_fixed: 205,
            die_temp_moving: 242, vacuum_level: 232, cycle_time: 84.8, shrinkage_rate: 6.0,
            porosity_rate: 6.3, vibration_rms: 9.1, cast_count: 44800 } },
  { title: "感應加熱 · 棒料出料 1180 °C", template: "induction_heater", state: "running",
    tags: { billet_temp_out: 1181, coil_temp: 78, coil_current: 1439, output_power: 252,
            frequency: 7.8, power_factor: 0.95, leakage_current: 2.0, cooling_flow: 93,
            billet_count: 8400, energy_kwh: 1035 } },
  { title: "感應加熱 · 絕緣劣化 + 結垢降額", template: "induction_heater", state: "running",
    tags: { billet_temp_out: 1072, coil_temp: 147, coil_current: 976, output_power: 174,
            frequency: 7.9, power_factor: 0.76, leakage_current: 39.7, cooling_flow: 57,
            billet_count: 92000, energy_kwh: 17340 } },
  { title: "鍛造 · 下死點成形", template: "forging_press", state: "running",
    tags: { ram_position: -176, forging_tonnage: 1520, die_temp: 353, billet_temp_in: 1173,
            descale_pressure: 178, ram_deviation: 0.08, stroke_rate: 4.9, underfill_rate: 0.5,
            scale_defect_rate: 0.4, vibration_rms: 2.6, forge_count: 11500 } },
  { title: "鍛造 · 鍛模磨耗 + 除鱗噴嘴堵", template: "forging_press", state: "running",
    tags: { ram_position: -42, forging_tonnage: 118, die_temp: 355, billet_temp_in: 1168,
            descale_pressure: 79, ram_deviation: 1.42, stroke_rate: 3.6, underfill_rate: 7.6,
            scale_defect_rate: 8.2, vibration_rms: 11.7, forge_count: 148000 } },
  { title: "切邊 · 飛邊切除", template: "trimming_press", state: "running",
    tags: { slide_position: -84, trim_force: 214, burr_height: 0.03, ejector_stroke: 24.6,
            motor_current: 12.4, cycle_time: 9.2, deform_rate: 0.3, vibration_rms: 1.5,
            trim_count: 21400 } },
  { title: "切邊 · 刀口鈍化(毛刺超規)", template: "trimming_press", state: "running",
    tags: { slide_position: -12, trim_force: 336, burr_height: 0.35, ejector_stroke: 18.9,
            motor_current: 18.1, cycle_time: 11.7, deform_rate: 5.2, vibration_rms: 9.4,
            trim_count: 176000 } },
  // ── 手工具後段五機種(2026-08-22):索引 42 起,LINE_COMBOS 依賴前面的索引不動 ──
  { title: "研磨 · 拋光中(新砂輪)", template: "grinding_polisher", state: "running",
    tags: { spindle_rpm: 2841, grind_force: 86, surface_ra: 0.35, wheel_diameter: 344,
            extraction_dp: 0.98, extraction_flow: 2312, spindle_temp: 54, motor_current: 14.2,
            cycle_time: 18.3, vibration_rms: 1.3, ground_count: 8600 } },
  { title: "研磨 · 砂輪磨耗 + 集塵堵(粗糙度超規)", template: "grinding_polisher", state: "running",
    tags: { spindle_rpm: 2738, grind_force: 156, surface_ra: 1.51, wheel_diameter: 271,
            extraction_dp: 4.42, extraction_flow: 1268, spindle_temp: 96, motor_current: 22.8,
            cycle_time: 23.9, vibration_rms: 6.9, ground_count: 148000 } },
  { title: "清洗 · 連續網帶(三區同時)", template: "cleaning_dryer", state: "running",
    tags: { bath_temp: 61.8, bath_conductivity: 402, spray_pressure: 3.19, spray_flow: 172,
            dry_temp: 102, residue_level: 0.44, moisture_ppm: 53, pump_current: 11.7,
            cycle_time: 15.2, transit_time: 91, vibration_rms: 1.0, washed_count: 9400 } },
  { title: "清洗 · 噴嘴堵(壓力升但流量掉)", template: "cleaning_dryer", state: "running",
    tags: { bath_temp: 61.5, bath_conductivity: 1980, spray_pressure: 4.86, spray_flow: 88,
            dry_temp: 83, residue_level: 3.79, moisture_ppm: 486, pump_current: 15.9,
            cycle_time: 17.4, transit_time: 106, vibration_rms: 5.2, washed_count: 162000 } },
  { title: "電鍍 · 連續掛鍍(鍍層合格)", template: "plating_line", state: "running",
    tags: { current_density: 3.86, cell_voltage: 5.83, rectifier_ripple: 1.35, bath_temp: 54.8,
            bath_ph: 4.46, coating_thickness: 9.28, porosity_count: 0.81, anode_mass: 114,
            rectifier_temp: 50.4, cycle_time: 12.2, dwell_time: 732, plated_count: 11200 } },
  { title: "電鍍 · 陽極消耗 + 鍍液老化(過薄 + 孔隙)", template: "plating_line", state: "running",
    tags: { current_density: 2.53, cell_voltage: 8.74, rectifier_ripple: 8.9, bath_temp: 54.6,
            bath_ph: 5.34, coating_thickness: 7.09, porosity_count: 4.86, anode_mass: 57,
            rectifier_temp: 75.2, cycle_time: 14.3, dwell_time: 858, plated_count: 205000 } },
  { title: "組裝 · 壓入 + 鎖付", template: "assembly_station", state: "running",
    tags: { press_depth: 21.4, press_force: 14.1, screw_torque: 8.94, feed_success: 97.2,
            feeder_level: 78, missing_rate: 0.26, actuator_current: 9.4, cycle_time: 14.4,
            vibration_rms: 0.95, assembled_count: 7300 } },
  { title: "組裝 · 給料卡料 + 起子扭力衰退", template: "assembly_station", state: "running",
    tags: { press_depth: 24.0, press_force: 18.9, screw_torque: 6.21, feed_success: 67.4,
            feeder_level: 21, missing_rate: 5.38, actuator_current: 12.6, cycle_time: 18.5,
            vibration_rms: 5.1, assembled_count: 154000 } },
  { title: "扭力測試 · 合格(錶針在允收帶內)", template: "torque_tester", state: "running",
    tags: { applied_torque: 58.4, peak_torque: 62.1, torque_angle: 30.8, sensor_bias: 0.22,
            clamp_pressure: 40.9, slip_events: 6, load_rate: 9.06, motor_current: 6.9,
            cycle_time: 11.3, vibration_rms: 0.82, tested_count: 6400 } },
  { title: "扭力測試 · 感測器漂移(良品被誤退)", template: "torque_tester", state: "running",
    tags: { applied_torque: 51.2, peak_torque: 53.9, torque_angle: 46.2, sensor_bias: -4.61,
            clamp_pressure: 28.7, slip_events: 341, load_rate: 6.78, motor_current: 8.4,
            cycle_time: 13.3, vibration_rms: 4.8, tested_count: 139000 } },
];

const SCENES: Record<string, React.ComponentType<any>> = {
  cnc_machining_center: CncMachine3D, robot_arm_6axis: RobotArm3D, injection_molding: InjectionMolding3D,
  agv_mobile_robot: AgvMobileRobot3D, conveyor: Conveyor3D, stamping_press: StampingPress3D,
  wind_turbine: WindTurbine3D, air_compressor: AirCompressor3D, energy_meter: EnergyMeter3D,
  semi_process_chamber: ProcessChamber3D, heat_treat_furnace: HeatTreatFurnace3D,
  aoi_inspection: AoiInspection3D, welding_cell: WeldingCell3D,
  laser_cutter: LaserCutter3D, packaging_machine: PackagingMachine3D,
  grinding_polisher: GrindingPolisher3D, cleaning_dryer: CleaningDryer3D,
  plating_line: PlatingLine3D, assembly_station: AssemblyStation3D,
  torque_tester: TorqueTester3D,
  melting_furnace: MeltingFurnace3D, die_casting_machine: DieCastingMachine3D,
  induction_heater: InductionHeater3D, forging_press: ForgingPress3D,
  trimming_press: TrimmingPress3D,
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
/**
 * 廠內產線視圖:驗收製程佈局(上游 → 手臂 → 出料)、共用燈光 / 縮放 / 標籤。
 * `?line=<key>` 選組合,對應真實場景裡會出現的配方。
 */
const LINE_COMBOS: Record<string, number[]> = {
  // CNC 加工 → 手臂取件 → 輸送帶出料(machine_tool / precision_parts 的配方)
  cnc: [0, 2, 6],
  // 射出成型 → 手臂取件 → 輸送帶(plastics 的配方,對應使用者截圖 3)
  inj: [10, 2, 6],
  // 沖壓 → 手臂取件(metal_forming)
  press: [8, 2],
  // CNC → AGV 搬運 → 輸送帶:驗 AGV compact(巡迴路線縮尺進機台格,不在產線裡亂開)
  agv: [0, 4, 6],
  // 單機 + 廠務:不該畫料道,廠務要退到後排
  solo: [0, 14, 16],
  // 焊接 → 手臂 → 輸送帶(c66 的配方)
  weld: [26, 2, 6],
  // 雷切 → 手臂 → 包裝(c67:包裝機當產線終站)
  laserpack: [28, 2, 30],
  // 射出 → 手臂 → AOI 全檢(c68)
  aoi: [10, 2, 24],
  // 熔煉 → 手臂 → 壓鑄 → 手臂 → 輸送帶(c70 / x01-f4 的五站鑄造線)
  casting: [32, 2, 34, 2, 6],
  // 感應加熱 → 手臂 → 鍛造 → 手臂 → 切邊(c71 / x01-f5 的五站鍛造線)
  forging: [36, 2, 38, 2, 40],
  // 研磨 → 手臂 → 清洗 → 手臂 → 電鍍(c72 / x01-f6 的五站表面處理線)
  finishing: [42, 2, 44, 2, 46],
  // 組裝 → 手臂 → 扭力測試 → 手臂 → 輸送帶(c73 / x01-f7 的五站組裝檢驗線)
  handtool: [48, 2, 50, 2, 6],
  // 全部混一起,壓力測試
  mixed: [0, 2, 6, 8, 10, 18, 20],
};

/**
 * 量測模式(`?line=measure`):把每個機種各掛一次,讀出**已套 LINE_SCALE** 的世界包圍盒,
 * 寫到 window.__measured 給 preview/measure.mjs 收。用來訂 processFlow 的 HALF_W ——
 * 那張表用猜的就會穿模或留一大段空隙。
 */
function Measure() {
  const one: Record<string, any> = {};
  for (const c of CASES) if (!one[c.template]) one[c.template] = c;
  const list = Object.values(one) as typeof CASES;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <FactoryLine3D
        devices={list.map((c, i) => ({ id: `m${i}`, template: c.template }))}
        snapshots={Object.fromEntries(list.map((c, i) => [`m${i}`, {
          id: `m${i}`, template: c.template, state: c.state, state_code: 0,
          tags: c.tags, setpoints: c.setpoints, coils: c.coils } as any]))}
        multiplier={MULTIPLIER}
        onMeasured={(rows: any) => { (window as any).__measured = rows; }}
      />
    </div>
  );
}

function Line() {
  const q = new URLSearchParams(location.search);
  const key = q.get("line") || "1";
  const idxs = LINE_COMBOS[key] ?? LINE_COMBOS.mixed;
  const picked = idxs.map((i) => CASES[i]);
  const snapshots: Record<string, any> = {};
  const devices = picked.map((c, i) => {
    const id = `d${String(i + 1).padStart(2, "0")}`;
    snapshots[id] = { id, template: c.template, state: c.state, state_code: 0,
                      tags: c.tags, setpoints: c.setpoints, coils: c.coils };
    return { id, template: c.template };
  });
  // ?flow=1:掛一份模擬的產線帳(engine/line.py 的 snapshot.lines 形狀),
  // 驗收站邊緩衝方塊與「工件實際流動」標示。取排在最前的 producer / handler / 其餘。
  let line: any = undefined;
  if (q.get("flow") === "1") {
    const prod = devices.filter((d) => !["robot_arm_6axis", "conveyor", "agv_mobile_robot",
      "air_compressor", "energy_meter", "wind_turbine"].includes(d.template));
    const arm = devices.find((d) => d.template === "robot_arm_6axis");
    if (prod.length && arm) {
      const sink = prod[1] ?? devices.find((d) => d.template === "conveyor");
      line = {
        company: "preview",
        shipped: 42,
        stations: [
          { device: prod[0].id, template: prod[0].template, role: "source",
            in_buffer: null, out_buffer: 2, carrying: null, moved: null, on_belt: null },
          { device: arm.id, template: arm.template, role: "handler",
            in_buffer: null, out_buffer: null, carrying: 1, moved: 43, on_belt: null },
          ...(sink ? [{ device: sink.id, template: sink.template,
            role: sink.template === "conveyor" ? "terminal" : "sink",
            in_buffer: sink.template === "conveyor" ? null : 3,
            out_buffer: null, carrying: null, moved: null,
            on_belt: sink.template === "conveyor" ? 3 : null }] : []),
        ],
      };
    }
  }
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <FactoryLine3D devices={devices} snapshots={snapshots} multiplier={MULTIPLIER} line={line}
                     onMeasured={q.get("probe") === "1"
                       ? (rows: any) => { (window as any).__measured = rows; } : undefined} />
    </div>
  );
}

function App() {
  const q = new URLSearchParams(location.search);
  if (q.get("line") === "measure") return <Measure />;
  if (q.get("line")) return <Line />;
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
