/**
 * AOI 光學檢測站 3D(綁定表見 docs/animation_binding.md §4.14)。
 *
 * 相機龍門位置直接吃引擎的 camera_pos_x / camera_pos_y(mm,L1,÷50 = 模型單位)。
 * 引擎的蛇形掃描節拍(INSPECT_S=15 s)在 sim ×120 下低於可視極限 —— 與沖壓機同款
 * 處理:倍率 ≈1 時直接用遙測座標(L1 鎖定),否則本地跑**同一條蛇形參數式**慢放
 * 並標示倍率(L3)。參數式與 engine/templates/aoi_inspection.py::_scan_xy 逐行對應。
 *
 * 三條退化線:
 *   · stage_bearing → vibration_rms → 整機抖動 + 掃描節拍變長
 *   · lens_contamination → focus_score 下滑 → 鏡頭霧化(半透明鏡片變濁)
 *   · led_aging → light_intensity → 環形光源亮度(L1 直接映射)
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, Shake, StatusBeacon, StatusText, WORKPIECE, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approach, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const MM = 1 / 50;                 // mm → 模型單位(與 CNC 同款換算)
const SCAN_X = 150, SCAN_Y = 100;  // 引擎掃描範圍(±mm)
const SCAN_ROWS = 5;
const INSPECT_S = 15.0;            // 引擎額定掃描節拍(sim 秒)
const GANTRY_Y = 4.2;              // 相機龍門高度(模型單位)

/** 與引擎 _scan_xy() 逐行對應:相位 → 蛇形掃描座標(mm)。 */
function scanXY(ph: number): [number, number] {
  const p = ph * SCAN_ROWS;
  const row = Math.min(SCAN_ROWS - 1, Math.floor(p));
  const u = p - row;
  const x = row % 2 === 0 ? -SCAN_X + 2 * SCAN_X * u : SCAN_X - 2 * SCAN_X * u;
  const y = -SCAN_Y + row * ((2 * SCAN_Y) / (SCAN_ROWS - 1));
  return [x, y];
}

export const AoiInspectionModel = ({ motion }: MachineProps) => {
  const headRef = useRef<THREE.Group>(null);
  const bridgeRef = useRef<THREE.Group>(null);
  const ringRef = useRef<THREE.MeshStandardMaterial>(null);
  const lensRef = useRef<THREE.MeshStandardMaterial>(null);
  const spotRef = useRef<THREE.MeshStandardMaterial>(null);
  const phase = useRef(0);
  const pos = useRef<[number, number]>([-SCAN_X, -SCAN_Y]);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.inspect_time || INSPECT_S, motion.timeScale);
    const locked = Math.abs(per.factor - 1) < 0.05 &&
      typeof t.camera_pos_x === "number" && typeof t.camera_pos_y === "number";

    let mx: number, my: number;
    if (!motion.running) {
      [mx, my] = [-SCAN_X, -SCAN_Y];                       // 待機停回列首(引擎同款)
      phase.current = 0;
    } else if (locked) {
      mx = t.camera_pos_x; my = t.camera_pos_y;            // L1:直接用引擎值
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      [mx, my] = scanXY(phase.current);                    // L3:同一條蛇形參數式慢放
    }
    // delta-based 補間 + 貼齊(契約 §3)
    pos.current = [
      approach(pos.current[0], mx, 0.1, delta, 0.25),
      approach(pos.current[1], my, 0.1, delta, 0.25),
    ];
    if (headRef.current) headRef.current.position.x = pos.current[0] * MM;
    if (bridgeRef.current) bridgeRef.current.position.z = pos.current[1] * MM;

    // 環形光源亮度 = light_intensity(L1 → emissive)
    if (ringRef.current) {
      const li = clamp01((t.light_intensity ?? 0) / 100);
      ringRef.current.emissiveIntensity = motion.running ? 0.3 + 2.2 * li : 0.1;
    }
    // 鏡頭霧化 = focus_score 反向(lens_contamination 的視覺,L2)
    if (lensRef.current) {
      const fog = motion.running ? clamp01(1 - (t.focus_score ?? 100) / 100) : 0;
      lensRef.current.opacity = 0.25 + 0.6 * fog;
      lensRef.current.color.setRGB(0.7 - 0.3 * fog, 0.85 - 0.45 * fog, 0.95 - 0.55 * fog);
    }
    // 檢測光斑:跟著相機走(工件被照亮的位置)
    if (spotRef.current) {
      const li = clamp01((t.light_intensity ?? 0) / 100);
      spotRef.current.emissiveIntensity = motion.running ? 1.6 * li : 0;
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={0.8}>
      <group>
        {/* 檢測平台(玻璃檯面 + 待檢工件) */}
        <Box args={[8, 1.0, 5.6]} position={[0, 0.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.55} />
        </Box>
        <Box args={[7.2, 0.12, 4.8]} position={[0, 1.06, 0]} receiveShadow>
          <meshStandardMaterial color="#26343c" roughness={0.25} metalness={0.5} />
        </Box>
        {[-2.1, -0.7, 0.7, 2.1].map((x) =>
          [-1.2, 0, 1.2].map((z) => (
            <Box key={`${x}:${z}`} args={[0.9, 0.06, 0.7]} position={[x, 1.16, z]} castShadow>
              <meshStandardMaterial color={WORKPIECE} roughness={0.6} />
            </Box>
          )))}

        {/* 龍門:兩側 Z 向軌道(橋沿 camera_pos_y 走)、相機頭沿 X(camera_pos_x)走 */}
        {[-3.7, 3.7].map((x) => (
          <group key={x}>
            <Box args={[0.45, 0.35, 5.6]} position={[x, GANTRY_Y, 0]} castShadow receiveShadow>
              <meshStandardMaterial color="#5a6a72" metalness={0.6} />
            </Box>
            {[-2.4, 2.4].map((z) => (
              <Box key={z} args={[0.35, 3.2, 0.35]} position={[x, 2.55, z]} castShadow receiveShadow>
                <meshStandardMaterial color="#5a6a72" metalness={0.6} />
              </Box>
            ))}
          </group>
        ))}
        <group ref={bridgeRef}>
          <Box args={[8, 0.45, 0.7]} position={[0, GANTRY_Y, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#7a8890" metalness={0.7} />
          </Box>
          <group ref={headRef}>
            {/* 相機本體 + 鏡頭 + 環形光源 */}
            <Box args={[0.7, 1.1, 0.7]} position={[0, GANTRY_Y - 0.75, 0]} castShadow>
              <meshStandardMaterial color="#2e3a40" metalness={0.6} />
            </Box>
            <Cylinder args={[0.24, 0.24, 0.5, 20]} position={[0, GANTRY_Y - 1.5, 0]} castShadow>
              <meshStandardMaterial ref={lensRef} color="#a8d8f0" transparent opacity={0.3} />
            </Cylinder>
            <mesh position={[0, GANTRY_Y - 1.78, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <ringGeometry args={[0.3, 0.52, 24]} />
              <meshStandardMaterial ref={ringRef} color="#eaf6ff" emissive="#dff2ff"
                                    emissiveIntensity={0.3} toneMapped={false} side={THREE.DoubleSide} />
            </mesh>
            {/* 檢測光斑(桌面上被照亮的位置,跟著相機) */}
            <mesh position={[0, 1.2, 0]} rotation={[-Math.PI / 2, 0, 0]}>
              <circleGeometry args={[0.5, 20]} />
              <meshStandardMaterial ref={spotRef} color="#eaf6ff" emissive="#dff2ff"
                                    emissiveIntensity={0} transparent opacity={0.5} toneMapped={false} />
            </mesh>
            {/* 驗證探針:相機頭世界座標 ↔ camera_pos_x / camera_pos_y */}
            <object3D name="probe:aoi_camera" position={[0, GANTRY_Y - 1.5, 0]} />
          </group>
        </group>

        <StatusBeacon motion={motion} position={[3.7, 4.6, -2.5]} scale={1.2} />
        <FaultSmoke motion={motion} position={[0, 5, 0]} />
        <StatusText motion={motion} position={[0, 1.9, 2.85]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function AoiInspection3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(motion.tags.inspect_time || INSPECT_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 7, 11]} fov={42} target={[0, 2.2, 0]} shadowScale={24} note={scaleNote(per)}
                  overlay={<AoiReadout motion={motion} />}>
      <AoiInspectionModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function AoiReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["CAM X", `${(t.camera_pos_x ?? 0).toFixed(0)} mm`],
    ["CAM Y", `${(t.camera_pos_y ?? 0).toFixed(0)} mm`],
    ["LIGHT", `${(t.light_intensity ?? 0).toFixed(0)} %`, (t.light_intensity ?? 100) < 82],
    ["FOCUS", `${(t.focus_score ?? 0).toFixed(1)}`, (t.focus_score ?? 100) < 80],
    ["FALSE CALL", `${(t.false_call_rate ?? 0).toFixed(2)} %`, (t.false_call_rate ?? 0) > 3],
    ["TAKT", `${(t.inspect_time ?? 0).toFixed(1)} s`, (t.inspect_time ?? 15) > 17],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["INSPECTED", `${Math.round(t.inspected_count ?? 0)}`],
  ];
  const hint = (t.focus_score ?? 100) < 80 ? "⚠ focus 下滑但 light 正常 → lens_contamination(鏡頭清潔 + 校正)"
    : (t.light_intensity ?? 100) < 82 ? "⚠ 光源衰減 → led_aging(誤判率跟著升)"
    : clamp01(motion.severity) > 0.5 ? "⚠ 振動升 + 節拍變長 → stage_bearing" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
