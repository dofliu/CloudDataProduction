/**
 * 包裝機 3D(綁定表見 docs/animation_binding.md §4.17)。
 *
 * 封口鉗開度直接吃引擎的 jaw_gap(mm,80 全開 → 0 閉合,L1)—— 與沖壓機 ram_position
 * 同款處理:倍率 ≈1 時 L1 鎖定,否則本地跑同一條參數式(jaw = 40·(1+cos 2π·ph))
 * 慢放並標倍率(L3)。節拍取自 cycle_time tag。
 *
 * 三條退化線:
 *   · sealer_heater_aging → seal_temp 到不了 145 °C → 封口鉗輝光變暗 + 警示
 *   · film_feed_wear → film_tension 波動 → 膜卷抖動、vibration 升
 *   · cutter_blade_wear → reject_rate → 出料包裝外觀(wear:皺摺變色)
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const JAW_MAX_MM = 80;         // 引擎 jaw_gap 全開值
const JAW_TRAVEL = 1.6;        // 模型單位行程(80 mm → 1.6 = ÷50)
const CYCLE_S = 15.0;          // 引擎額定節拍
const SEAL_SET_C = 145.0;
const JAW_MID_Y = 2.1;         // 封口口中心高度

export const PackagingMachineModel = ({ motion }: MachineProps) => {
  const upperRef = useRef<THREE.Group>(null);
  const lowerRef = useRef<THREE.Group>(null);
  const jawGlowRefs = [useRef<THREE.MeshStandardMaterial>(null), useRef<THREE.MeshStandardMaterial>(null)];
  const rollRef = useRef<THREE.Mesh>(null);
  const packRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const packMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const sealLampRef = useRef<THREE.MeshStandardMaterial>(null);
  const phase = useRef(0);
  const travel = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.cycle_time || CYCLE_S, motion.timeScale);
    const locked = Math.abs(per.factor - 1) < 0.05 && typeof t.jaw_gap === "number";

    let gapMm: number;
    if (!motion.running) {
      gapMm = JAW_MAX_MM;                                  // 停機 → 全開(安全位置,引擎同款)
      phase.current = 0;
    } else if (locked) {
      gapMm = t.jaw_gap;                                   // L1:直接用引擎值
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      // 與引擎同一條參數式:jaw = 40·(1 + cos 2π·ph)
      gapMm = (JAW_MAX_MM / 2) * (1 + Math.cos(phase.current * Math.PI * 2));
    }
    const half = (gapMm / JAW_MAX_MM) * (JAW_TRAVEL / 2);
    if (upperRef.current) upperRef.current.position.y = JAW_MID_Y + half;
    if (lowerRef.current) lowerRef.current.position.y = JAW_MID_Y - half;

    // 封口鉗輝光 = seal_temp(L2):到不了設定點就是偏暗 —— heater 老化一眼可見
    const heat = clamp01(motion.heat);
    for (const r of jawGlowRefs) if (r.current) r.current.emissiveIntensity = 0.15 + 2.0 * heat;
    if (sealLampRef.current) {
      const cold = motion.running && (t.seal_temp ?? SEAL_SET_C) < 128;
      sealLampRef.current.color.set(cold ? FX.warn : FX.ok);
      sealLampRef.current.emissive.set(cold ? FX.warn : FX.ok);
      sealLampRef.current.emissiveIntensity = cold ? 2 : 0.8;
    }

    // 膜卷轉動與出料前進:速率 = index_rate(ppm → 包/s,L3 同 visualPeriod 倍率)
    const pkgPerS = motion.running ? (t.index_rate ?? 0) / 60 : 0;
    travel.current += (pkgPerS * motion.timeScale / per.factor) * delta;
    if (rollRef.current) rollRef.current.rotation.x = travel.current * 2.2;
    packRefs.forEach((r, i) => {
      if (!r.current) return;
      const progress = ((travel.current + i / 3) % 1 + 1) % 1;
      r.current.position.x = 1.2 + progress * 3.4;
    });
    // 不良率 → 包裝外觀(L2:皺摺變色)
    if (packMatRef.current) {
      const rej = clamp01(motion.wear);
      packMatRef.current.color.setRGB(0.92 - 0.35 * rej, 0.88 - 0.45 * rej, 0.78 - 0.4 * rej);
      packMatRef.current.roughness = 0.4 + 0.5 * rej;
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={0.9}>
      <group>
        {/* 機座 + 入料輸送段 */}
        <Box args={[9.0, 1.2, 3.6]} position={[0, 0.6, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.55} />
        </Box>
        <Box args={[8.4, 0.15, 1.6]} position={[0, 1.28, 0]} receiveShadow>
          <meshStandardMaterial color="#333b40" roughness={0.85} />
        </Box>

        {/* 膜卷(上方,轉動速率 ∝ index_rate) */}
        <Cylinder ref={rollRef} args={[0.7, 0.7, 2.0, 20]} rotation={[0, 0, Math.PI / 2]}
                  position={[-2.6, 4.2, 0]} castShadow>
          <meshStandardMaterial color="#d8d2c4" roughness={0.5} />
        </Cylinder>
        {[-1.05, 1.05].map((z) => (
          <Box key={z} args={[0.3, 2.2, 0.3]} position={[-2.6, 3.0, z]} castShadow>
            <meshStandardMaterial color="#5a6a72" metalness={0.6} />
          </Box>
        ))}
        {/* 膜片(從膜卷下到封口口) */}
        <Box args={[2.2, 2.4, 0.02]} position={[-1.4, 2.8, 0]} rotation={[0, 0, -0.5]}>
          <meshStandardMaterial color="#e8e2d4" transparent opacity={0.5} side={THREE.DoubleSide} />
        </Box>

        {/* 封口鉗框架 + 上下鉗(jaw_gap L1) */}
        {[-1.0, 1.0].map((z) => (
          <Box key={z} args={[0.4, 3.6, 0.4]} position={[0, 2.4, z]} castShadow receiveShadow>
            <meshStandardMaterial color="#5a6a72" metalness={0.6} />
          </Box>
        ))}
        <group ref={upperRef} position={[0, JAW_MID_Y + JAW_TRAVEL / 2, 0]}>
          <Box args={[1.4, 0.35, 1.7]} castShadow>
            <meshStandardMaterial ref={jawGlowRefs[0]} color="#8a5a3a" emissive="#ff7a30"
                                  emissiveIntensity={0.15} metalness={0.4} />
          </Box>
          {/* 驗證探針:上鉗世界高度 ↔ jaw_gap */}
          <object3D name="probe:jaw" />
        </group>
        <group ref={lowerRef} position={[0, JAW_MID_Y - JAW_TRAVEL / 2, 0]}>
          <Box args={[1.4, 0.35, 1.7]} castShadow>
            <meshStandardMaterial ref={jawGlowRefs[1]} color="#8a5a3a" emissive="#ff7a30"
                                  emissiveIntensity={0.15} metalness={0.4} />
          </Box>
        </group>

        {/* 出料段:成品包裝(外觀吃 reject_rate) */}
        {packRefs.map((r, i) => (
          <Box key={i} ref={r} args={[0.8, 0.4, 1.1]} position={[1.2 + i * 1.1, 1.55, 0]} castShadow>
            <meshStandardMaterial ref={i === 0 ? packMatRef : undefined} color="#ebe0c8" roughness={0.4} />
          </Box>
        ))}

        {/* 封口溫度警示燈 */}
        <mesh position={[0, 4.35, 1.05]}>
          <circleGeometry args={[0.18, 18]} />
          <meshStandardMaterial ref={sealLampRef} color={FX.ok} emissive={FX.ok}
                                emissiveIntensity={0.8} toneMapped={false} />
        </mesh>

        <StatusBeacon motion={motion} position={[4.2, 1.9, -1.5]} scale={1.2} />
        <FaultSmoke motion={motion} position={[0, 4.6, 0]} />
        <StatusText motion={motion} position={[0, 2.0, 1.95]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function PackagingMachine3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(motion.tags.cycle_time || CYCLE_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 6.5, 11]} fov={42} target={[0, 2.2, 0]} shadowScale={24} note={scaleNote(per)}
                  overlay={<PackReadout motion={motion} />}>
      <PackagingMachineModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function PackReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["JAW", `${(t.jaw_gap ?? 0).toFixed(0)} mm`],
    ["SEAL TEMP", `${(t.seal_temp ?? 0).toFixed(1)} °C`, motion.running && (t.seal_temp ?? SEAL_SET_C) < 128],
    ["TENSION", `${(t.film_tension ?? 0).toFixed(1)} N`],
    ["RATE", `${(t.index_rate ?? 0).toFixed(2)} ppm`],
    ["CYCLE", `${(t.cycle_time ?? 0).toFixed(1)} s`, (t.cycle_time ?? CYCLE_S) > 17],
    ["REJECT", `${(t.reject_rate ?? 0).toFixed(2)} %`, (t.reject_rate ?? 0) > 3],
    ["CURRENT", `${(t.motor_current ?? 0).toFixed(2)} A`],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["PACKAGES", `${Math.round(t.package_count ?? 0)}`],
  ];
  const hint = motion.running && (t.seal_temp ?? SEAL_SET_C) < 128
    ? "⚠ 封口溫度到不了設定點 + 節拍變長 → sealer_heater_aging"
    : clamp01(motion.severity) > 0.4 ? "⚠ 膜張力波動 + 振動 → film_feed_wear"
    : (t.reject_rate ?? 0) > 3 ? "⚠ 不良率升但溫度/張力正常 → cutter_blade_wear" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
