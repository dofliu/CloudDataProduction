/**
 * 焊接機器人工作站 3D(綁定表見 docs/animation_binding.md §4.15)。
 *
 * 焊槍位置直接吃引擎的 torch_pos_x / torch_pos_y(mm,L1,÷50)。節拍(SEAM_S=16 s)
 * 在 sim ×120 下低於可視極限 —— 倍率 ≈1 時 L1 鎖定,否則本地跑**同一條焊道參數式**
 * 慢放並標倍率(L3)。參數式與 engine/templates/welding_cell.py 的 drv_torch_* 對應。
 *
 * 電弧開關**由 tag 判定**(arc_current > 100 A = 弧開),不是自己猜相位:
 *   · 弧開 → 弧光球 + 飛濺粒子;飛濺密度 ∝ spatter_rate(L2,nozzle_clog 的視覺)
 *   · wire_feeder_wear → vibration_rms → 整機抖動;送絲率讀值下滑
 */
import React, { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FaultSmoke, HeatGlow, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approach, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const MM = 1 / 50;
const SEAM_X = 200, SEAM_Y = 60;   // 引擎焊道幾何(±mm)
const SEAM_S = 16.0, WELD_FRAC = 0.72;
const TORCH_TIP_Y = 1.7;           // 焊槍尖離地高(模型單位)

/** 與引擎 drv_torch_x/y 對應:相位 + 道別 → 焊槍座標(mm)。 */
function torchXY(ph: number, parity: number): [number, number] {
  const u = ph < WELD_FRAC ? ph / WELD_FRAC : 1 - (ph - WELD_FRAC) / (1 - WELD_FRAC);
  return [-SEAM_X + 2 * SEAM_X * u, parity ? SEAM_Y : -SEAM_Y];
}

const SpatterSparks = ({ active, tip, density }: { active: boolean; tip: THREE.Vector3; density: number }) => {
  const COUNT = 40;
  const particles = useMemo(() => new Float32Array(COUNT * 3).fill(-100), []);
  const vel = useMemo(() => Array.from({ length: COUNT }, () => new THREE.Vector3()), []);
  const ref = useRef<THREE.Points>(null);
  useFrame((_, delta) => {
    if (!ref.current) return;
    const p = ref.current.geometry.attributes.position.array as Float32Array;
    const spawnP = 0.10 + 0.5 * clamp01(density);          // 飛濺率越高粒子越密
    for (let i = 0; i < COUNT; i++) {
      if (!active) { p[i * 3 + 1] = -100; continue; }
      if (p[i * 3 + 1] < 0.05 || (Math.random() < spawnP && p[i * 3 + 1] === -100)) {
        p[i * 3] = tip.x; p[i * 3 + 1] = tip.y; p[i * 3 + 2] = tip.z;
        vel[i].set((Math.random() - 0.5) * 8, Math.random() * 4 + 1.5, (Math.random() - 0.5) * 8);
      } else {
        vel[i].y -= 18 * delta;
        p[i * 3] += vel[i].x * delta; p[i * 3 + 1] += vel[i].y * delta; p[i * 3 + 2] += vel[i].z * delta;
      }
    }
    ref.current.geometry.attributes.position.needsUpdate = true;
  });
  return (
    <points frustumCulled={false} ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={COUNT} array={particles} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.12} color="#ffc24d" transparent opacity={0.9}
                      blending={THREE.AdditiveBlending} depthWrite={false} />
    </points>
  );
};

export const WeldingCellModel = ({ motion }: MachineProps) => {
  const carriageRef = useRef<THREE.Group>(null);
  const boomRef = useRef<THREE.Group>(null);
  const arcRef = useRef<THREE.MeshStandardMaterial>(null);
  const seamRefs = [useRef<THREE.MeshStandardMaterial>(null), useRef<THREE.MeshStandardMaterial>(null)];
  const phase = useRef(0);
  const pos = useRef<[number, number]>([-SEAM_X, -SEAM_Y]);
  const tip = useMemo(() => new THREE.Vector3(0, TORCH_TIP_Y, 0), []);

  useFrame((state, delta) => {
    const t = motion.tags;
    const per = visualPeriod(SEAM_S, motion.timeScale);
    const locked = Math.abs(per.factor - 1) < 0.05 &&
      typeof t.torch_pos_x === "number" && typeof t.torch_pos_y === "number";

    let mx: number, my: number;
    if (!motion.running) {
      [mx, my] = [-SEAM_X, -SEAM_Y];
      phase.current = 0;
    } else if (locked) {
      mx = t.torch_pos_x; my = t.torch_pos_y;              // L1
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      const parity = Math.floor(state.clock.elapsedTime / per.value) % 2;
      [mx, my] = torchXY(phase.current, parity);           // L3:同一條焊道參數式
    }
    pos.current = [
      approach(pos.current[0], mx, 0.1, delta, 0.25),
      approach(pos.current[1], my, 0.12, delta, 0.25),
    ];
    if (carriageRef.current) carriageRef.current.position.x = pos.current[0] * MM;
    if (boomRef.current) boomRef.current.position.z = pos.current[1] * MM;

    // 電弧由 arc_current 判定(>100 A = 弧開)—— 遙測說有弧才畫弧
    const arcOn = motion.running && (t.arc_current ?? 0) > 100;
    if (arcRef.current) {
      arcRef.current.emissiveIntensity = arcOn ? 2.6 + 1.2 * Math.sin(state.clock.elapsedTime * 37) : 0;
      arcRef.current.opacity = arcOn ? 0.95 : 0;
    }
    tip.set(pos.current[0] * MM, TORCH_TIP_Y, pos.current[1] * MM);
    // 已焊焊道發亮:弧在哪道,哪道亮(冷卻線用 emissive 淡出近似,純視覺)
    for (let i = 0; i < 2; i++) {
      const m = seamRefs[i].current;
      if (!m) continue;
      const active = arcOn && (i === 1 ? pos.current[1] > 0 : pos.current[1] <= 0);
      m.emissiveIntensity = Math.max(0, (m.emissiveIntensity ?? 0) - delta * 0.4) + (active ? delta * 2.5 : 0);
    }
  });

  const body = bodyColor(motion);
  const arcOnNow = motion.running && (motion.tags.arc_current ?? 0) > 100;
  return (
    <Shake motion={motion}>
      <group>
        {/* 焊接工作檯 + 兩道工件焊道(±60 mm) */}
        <Box args={[9.6, 1.0, 4.4]} position={[0, 0.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#3d4a50" metalness={0.65} />
        </Box>
        {[-SEAM_Y, SEAM_Y].map((y, i) => (
          <group key={y}>
            <Box args={[8.6, 0.28, 0.9]} position={[0, 1.14, y * MM]} castShadow>
              <meshStandardMaterial color="#8d9aa4" metalness={0.75} roughness={0.35} />
            </Box>
            <Box args={[8.2, 0.05, 0.12]} position={[0, 1.31, y * MM]}>
              <meshStandardMaterial ref={seamRefs[i]} color="#c97b2d" emissive="#ff8c2a"
                                    emissiveIntensity={0} toneMapped={false} />
            </Box>
          </group>
        ))}

        {/* 行走軸(X)+ 橫移臂(Z)+ 焊槍 */}
        <Box args={[10.4, 0.4, 0.6]} position={[0, 4.4, -2.6]} castShadow receiveShadow>
          <meshStandardMaterial color="#5a6a72" metalness={0.6} />
        </Box>
        {[-4.9, 4.9].map((x) => (
          <Box key={x} args={[0.5, 4.0, 0.6]} position={[x, 2.4, -2.6]} castShadow receiveShadow>
            <meshStandardMaterial color="#5a6a72" metalness={0.6} />
          </Box>
        ))}
        <group ref={carriageRef}>
          <group ref={boomRef}>
            <Box args={[0.45, 0.45, 5.8]} position={[0, 4.2, -0.3]} castShadow>
              <meshStandardMaterial color="#7a8890" metalness={0.7} />
            </Box>
            {/* 焊槍(斜插)+ 弧光 + 探針 */}
            <Cylinder args={[0.09, 0.13, 2.2, 12]} position={[0, 2.9, 0]} rotation={[0, 0, 0.28]} castShadow>
              <meshStandardMaterial color={body} metalness={0.5} />
            </Cylinder>
            <mesh position={[0, TORCH_TIP_Y, 0]}>
              <sphereGeometry args={[0.22, 14, 14]} />
              <meshStandardMaterial ref={arcRef} color="#dff2ff" emissive="#bfe6ff"
                                    emissiveIntensity={0} transparent opacity={0} toneMapped={false} />
            </mesh>
            <object3D name="probe:torch" position={[0, TORCH_TIP_Y, 0]} />
          </group>
        </group>

        <SpatterSparks active={arcOnNow} tip={tip} density={clamp01(motion.wear)} />
        <HeatGlow motion={motion} position={[0, 1.4, 0]} radius={1.8} />

        {/* 送絲機 + 氣瓶(nozzle_clog / wire_feeder_wear 的實體來源) */}
        <Box args={[1.4, 1.2, 1.0]} position={[-5.4, 1.6, -2.6]} castShadow receiveShadow>
          <meshStandardMaterial color="#456070" metalness={0.5} />
        </Box>
        <Cylinder args={[0.42, 0.42, 2.6, 16]} position={[5.6, 1.3, -2.4]} castShadow receiveShadow>
          <meshStandardMaterial color="#3f6e5a" metalness={0.55} />
        </Cylinder>

        <StatusBeacon motion={motion} position={[4.9, 4.6, -2.2]} scale={1.3} />
        <FaultSmoke motion={motion} position={[0, 5, 0]} />
        <StatusText motion={motion} position={[0, 2.0, 2.35]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function WeldingCell3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(SEAM_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 7, 12]} fov={42} target={[0, 2.4, 0]} shadowScale={26} note={scaleNote(per)}
                  overlay={<WeldReadout motion={motion} />}>
      <WeldingCellModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function WeldReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["TORCH X", `${(t.torch_pos_x ?? 0).toFixed(0)} mm`],
    ["ARC", `${(t.arc_current ?? 0).toFixed(0)} A / ${(t.arc_voltage ?? 0).toFixed(1)} V`, (t.arc_voltage ?? 24) > 27],
    ["WIRE FEED", `${(t.wire_feed_rate ?? 0).toFixed(2)} m/min`, (t.arc_current ?? 0) > 100 && (t.wire_feed_rate ?? 8) < 6.5],
    ["GAS", `${(t.gas_flow ?? 0).toFixed(1)} L/min`, (t.arc_current ?? 0) > 100 && (t.gas_flow ?? 15) < 12],
    ["SPATTER", `${(t.spatter_rate ?? 0).toFixed(2)} %`, (t.spatter_rate ?? 0) > 4],
    ["TORCH TEMP", `${(t.torch_temp ?? 0).toFixed(0)} °C`, (t.torch_temp ?? 0) > 300],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["WELDS", `${Math.round(t.weld_count ?? 0)}`],
  ];
  const hint = (t.arc_current ?? 0) > 100 && (t.gas_flow ?? 15) < 12
    ? "⚠ 保護氣流量掉 + 飛濺升 → nozzle_clog(清潔噴嘴,不是換送絲輪)"
    : clamp01(motion.severity) > 0.5 ? "⚠ 送絲下滑 + 電流波動 + 振動 → wire_feeder_wear"
    : (t.arc_voltage ?? 24) > 27 ? "⚠ 電弧電壓緩升、機構正常 → torch_cable_aging" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
