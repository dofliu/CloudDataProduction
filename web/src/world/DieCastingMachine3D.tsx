/**
 * 壓鑄機 3D(綁定表見 docs/animation_binding.md §4.19)。
 *
 * 會動的部位:
 *   · 移動模板開合 —— 由 clamping_force(ton)推出開合程度(L2:力滿 = 完全鎖模)。
 *   · 射出衝頭 —— shot_speed > 0 的那一瞬間才前進(L1 的門檻:速度是引擎給的)。
 *   · 真空指示 —— vacuum_level(mbar)越低越綠、抽不下去轉紅(L2)。
 * 節拍 65 s 在 ×120 下低於可視極限 → 倍率 ≈1 時 L1 鎖定,否則同一條相位式慢放(L3)。
 *
 * 兩條品質線的視覺分工(學生要分得出該修哪個):
 *   · die_thermal_fatigue → 兩側模溫拉開 → 移動模側轉紅、固定模側偏冷
 *   · vacuum_seal_wear    → vacuum_level 升 → 真空燈由綠轉紅 + 模穴殘氣霧
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approach, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const CYCLE_S = 65.0;
const OPEN_MM = 420;          // 移動模板最大開度(mm,÷50 = 模型單位)
const MM = 1 / 50;
const RATED_TON = 350;

/** 與引擎相位對應:相位 0.15~0.75 為鎖模段 → 開度 0。 */
function openFrac(ph: number): number {
  if (ph >= 0.15 && ph < 0.75) return 0;
  return ph < 0.15 ? 1 - ph / 0.15 : (ph - 0.75) / 0.25;
}

export const DieCastingMachineModel = ({ motion }: MachineProps) => {
  const movingRef = useRef<THREE.Group>(null);
  const plungerRef = useRef<THREE.Mesh>(null);
  const movingMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const fixedMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const vacLampRef = useRef<THREE.MeshStandardMaterial>(null);
  const phase = useRef(0);
  const open = useRef(1);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.cycle_time || CYCLE_S, motion.timeScale);
    const locked = Math.abs(per.factor - 1) < 0.05 && typeof t.clamping_force === "number";

    let frac: number;
    if (!motion.running) {
      frac = 1; phase.current = 0;                       // 停機 → 開模(安全位置)
    } else if (locked) {
      // L1:鎖模力滿 = 完全閉合。力是引擎算的,畫面不自己推物理。
      frac = 1 - clamp01((t.clamping_force ?? 0) / (RATED_TON * 0.9));
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      frac = openFrac(phase.current);                    // L3:同一條相位式慢放
    }
    open.current = approach(open.current, frac, 0.01, delta, 0.18);
    if (movingRef.current) movingRef.current.position.x = -1.6 - open.current * OPEN_MM * MM;

    // 射出衝頭:shot_speed > 0 才前進(壓鑄的射出是很短的一瞬)
    if (plungerRef.current) {
      const shooting = (t.shot_speed ?? 0) > 0.3 || (!locked && phase.current >= 0.28 && phase.current < 0.36);
      plungerRef.current.position.x = 3.4 - (motion.running && shooting ? 1.5 : 0);
    }

    // 兩側模溫(die_thermal_fatigue → 溫差拉開)
    const heat = (v: number) => clamp01((v - 190) / 90);
    if (movingMatRef.current) {
      const h = motion.running ? heat(t.die_temp_moving ?? 0) : 0;
      movingMatRef.current.emissive.setRGB(0.65 * h, 0.16 * h, 0.03 * h);
      movingMatRef.current.emissiveIntensity = 0.2 + 1.8 * h;
    }
    if (fixedMatRef.current) {
      const h = motion.running ? heat(t.die_temp_fixed ?? 0) : 0;
      fixedMatRef.current.emissive.setRGB(0.65 * h, 0.16 * h, 0.03 * h);
      fixedMatRef.current.emissiveIntensity = 0.2 + 1.8 * h;
    }
    // 真空燈:vacuum_level 越低越好(60 mbar 綠 / 200+ 紅)
    if (vacLampRef.current) {
      const bad = motion.running && (t.vacuum_level ?? 0) > 150;
      vacLampRef.current.color.set(bad ? FX.warn : FX.ok);
      vacLampRef.current.emissive.set(bad ? FX.warn : FX.ok);
      vacLampRef.current.emissiveIntensity = bad ? 2.2 : 0.8;
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={0.9}>
      <group>
        {/* 機座 + 四支拉桿 */}
        <Box args={[11.0, 1.1, 4.0]} position={[0, 0.55, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.55} />
        </Box>
        {[-1.2, 1.2].map((z) => [2.4, 4.0].map((y) => (
          <Cylinder key={`${z}:${y}`} args={[0.16, 0.16, 9.0, 12]} rotation={[0, 0, Math.PI / 2]}
                    position={[-0.5, y, z]} castShadow>
            <meshStandardMaterial color="#7a8890" metalness={0.75} />
          </Cylinder>
        )))}

        {/* 固定模板(右) */}
        <Box args={[1.1, 3.6, 3.2]} position={[1.6, 3.0, 0]} castShadow receiveShadow>
          <meshStandardMaterial ref={fixedMatRef} color="#5f6b72" metalness={0.6}
                                emissive="#000000" emissiveIntensity={0.2} />
        </Box>
        {/* 移動模板(左,開合 = clamping_force) */}
        <group ref={movingRef} position={[-1.6, 0, 0]}>
          <Box args={[1.1, 3.6, 3.2]} position={[0, 3.0, 0]} castShadow receiveShadow>
            <meshStandardMaterial ref={movingMatRef} color="#5f6b72" metalness={0.6}
                                  emissive="#000000" emissiveIntensity={0.2} />
          </Box>
          {/* 驗證探針:移動模板世界座標 ↔ clamping_force */}
          <object3D name="probe:moving_platen" position={[0, 3.0, 0]} />
        </group>
        {/* 鎖模肘節(左端) */}
        <Box args={[2.4, 2.6, 2.4]} position={[-5.0, 2.9, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#4a565c" metalness={0.5} />
        </Box>

        {/* 射出料管 + 衝頭(shot_speed) */}
        <Cylinder args={[0.42, 0.42, 3.2, 16]} rotation={[0, 0, Math.PI / 2]}
                  position={[3.6, 3.0, 0]} castShadow>
          <meshStandardMaterial color="#6b6259" metalness={0.5} roughness={0.6} />
        </Cylinder>
        <mesh ref={plungerRef} position={[3.4, 3.0, 0]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.3, 0.3, 1.4, 14]} />
          <meshStandardMaterial color="#9aa7ad" metalness={0.85} />
        </mesh>
        {/* 湯口(給湯杯) */}
        <Cylinder args={[0.5, 0.4, 0.7, 14]} position={[4.6, 3.9, 0]} castShadow>
          <meshStandardMaterial color="#544c45" roughness={0.85} />
        </Cylinder>

        {/* 真空指示燈 */}
        <mesh position={[0, 5.1, 1.7]}>
          <circleGeometry args={[0.2, 18]} />
          <meshStandardMaterial ref={vacLampRef} color={FX.ok} emissive={FX.ok}
                                emissiveIntensity={0.8} toneMapped={false} />
        </mesh>

        <StatusBeacon motion={motion} position={[5.2, 2.2, -1.6]} scale={1.2} />
        <FaultSmoke motion={motion} position={[0, 5.4, 0]} />
        <StatusText motion={motion} position={[0, 1.7, 2.1]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function DieCastingMachine3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(motion.tags.cycle_time || CYCLE_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 6.5, 13]} fov={42} target={[0, 3.0, 0]} shadowScale={28}
                  note={scaleNote(per)} overlay={<DieCastReadout motion={motion} />}>
      <DieCastingMachineModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function DieCastReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const dt = Math.abs((t.die_temp_moving ?? 0) - (t.die_temp_fixed ?? 0));
  const rows: Row[] = [
    ["CLAMP", `${(t.clamping_force ?? 0).toFixed(0)} ton`],
    ["SHOT", `${(t.shot_speed ?? 0).toFixed(2)} m/s`, (t.shot_speed ?? 0) > 0 && (t.shot_speed ?? 0) < 3.0],
    ["INTENSIFY", `${(t.intensify_press ?? 0).toFixed(0)} bar`],
    ["DIE FIX/MOV", `${(t.die_temp_fixed ?? 0).toFixed(0)} / ${(t.die_temp_moving ?? 0).toFixed(0)} °C`, dt > 30],
    ["VACUUM", `${(t.vacuum_level ?? 0).toFixed(0)} mbar`, (t.vacuum_level ?? 0) > 150],
    ["SHRINK", `${(t.shrinkage_rate ?? 0).toFixed(2)} %`, (t.shrinkage_rate ?? 0) > 3],
    ["POROSITY", `${(t.porosity_rate ?? 0).toFixed(2)} %`, (t.porosity_rate ?? 0) > 3],
    ["CASTS", `${Math.round(t.cast_count ?? 0)}`],
  ];
  const hint = dt > 30 ? "⚠ 兩側模溫拉開 + 縮孔率升 → die_thermal_fatigue(修 / 換模具)"
    : (t.vacuum_level ?? 0) > 150 ? "⚠ 真空抽不下去 + 氣孔率升 → vacuum_seal_wear(修真空系統)"
    : clamp01(motion.severity) > 0.5 ? "⚠ 射出速度掉 + 循環拉長 → hydraulic_accumulator" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
