/**
 * 零件組裝機 3D(綁定表見 docs/animation_binding.md §4.26)。
 *
 * 壓頭位置直接吃引擎的 press_depth(mm,0 → 24,L1);倍率 ≈1 時 L1 鎖定,
 * 否則本地跑同一條 smoothstep 參數式慢放並標倍率(L3)。
 *
 * 本站的教學重點是**兩支訊號要合著看**:press_force × press_depth。
 * 畫面右側畫一條即時的「力 – 位移曲線」—— 同樣壓到 24 mm,曲線形狀不一樣就代表
 * 壓錯了(零件歪、少墊片)。只看最終深度永遠看不出來,這是多變量勝過單變量的
 * 最直觀例子,也是為什麼 Readout 把兩支並排。
 *
 * 給料機構(振動盤)另外一條線:feed_success 掉 → 料軌上的零件變稀疏 → 缺件。
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, Shake, StatusBeacon, StatusText, WORKPIECE, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approach, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const MM = 1 / 50;
const CYCLE_S = 14.0;
const DEPTH_MM = 24.0;
const NOM_FORCE_KN = 18.5;
const SCREW_SPEC_MIN_NM = 7.2;
const N_FEED = 6;

/** 與引擎 _depth_mm() 同一條 smoothstep 參數式:相位 → 壓入深度(mm)。 */
function depthOf(ph: number): number {
  const ss = (x: number) => x * x * (3 - 2 * x);
  if (ph < 0.45) return DEPTH_MM * ss(ph / 0.45);
  if (ph < 0.60) return DEPTH_MM;
  if (ph < 0.75) return DEPTH_MM * (1 - ss((ph - 0.60) / 0.15));
  return 0;
}

export const AssemblyStationModel = ({ motion }: MachineProps) => {
  const ramRef = useRef<THREE.Group>(null);
  const bodyPartRef = useRef<THREE.Mesh>(null);
  const capRef = useRef<THREE.Mesh>(null);
  const driverRef = useRef<THREE.Group>(null);
  const feedRefs = Array.from({ length: N_FEED }, () => useRef<THREE.Mesh>(null));
  const bowlRef = useRef<THREE.Group>(null);
  const levelRef = useRef<THREE.Mesh>(null);
  const phase = useRef(0);
  const pos = useRef(0);
  const screwSpin = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.cycle_time || CYCLE_S, motion.timeScale);
    const locked = Math.abs(per.factor - 1) < 0.05 && typeof t.press_depth === "number";

    let mm: number;
    if (!motion.running) {
      mm = 0; phase.current = 0;
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      mm = locked ? t.press_depth : depthOf(phase.current);   // L1 / L3
    }
    pos.current = approach(pos.current, mm, 0.2, delta, 0.05);
    if (ramRef.current) ramRef.current.position.y = 4.2 - pos.current * MM;

    // 壓入中的本體:被壓下去(位移守恆 —— 壓頭走多少工件就沉多少)
    if (bodyPartRef.current) {
      bodyPartRef.current.visible = motion.running;
      bodyPartRef.current.position.y = 1.62 - pos.current * MM * 0.35;
    }
    // 鎖付段:電動起子下來轉(screw_torque 有值的那段相位)
    const screwing = motion.running && (t.screw_torque ?? 0) > 0.3;
    if (driverRef.current) {
      driverRef.current.visible = screwing;
      driverRef.current.position.y = 3.4 - (screwing ? 0.75 : 0);
      if (screwing) screwSpin.current += delta * 7.0;
      driverRef.current.rotation.y = screwSpin.current;
    }
    // 背蓋:鎖付扭力不足 → 微微翹起(screw_under_torque 的可見徵候)
    if (capRef.current) {
      capRef.current.visible = motion.running;
      const nm = t.screw_torque ?? 0;
      const loose = nm > 0.3 ? clamp01((SCREW_SPEC_MIN_NM - nm) / 2.2) : 0;
      capRef.current.position.y = 1.86 + 0.10 * loose;
      capRef.current.rotation.z = 0.05 * loose;
    }
    // 振動盤 + 料軌:feed_success 掉 → 軌上零件變稀疏(缺件的直接前因)
    const fs = clamp01((t.feed_success ?? 0) / 100);
    if (bowlRef.current && motion.running) {
      bowlRef.current.rotation.y += delta * 1.4;
      bowlRef.current.position.y = 2.3 + 0.02 * Math.sin(performance.now() / 40);
    }
    feedRefs.forEach((r, i) => {
      if (!r.current) return;
      // 成功率越低,越多格子是空的(用確定性的門檻,不用亂數 —— 畫面才不會亂閃)
      r.current.visible = motion.running && (i + 0.5) / N_FEED <= fs;
      const u = ((performance.now() / 1400 + i / N_FEED) % 1);
      r.current.position.set(-3.4 + u * 2.2, 2.05, 1.5);
    });
    // 料倉存量(feeder_level L1 → 料位高度)
    if (levelRef.current) {
      const lv = clamp01((t.feeder_level ?? 0) / 100);
      levelRef.current.scale.y = Math.max(0.05, lv);
      levelRef.current.position.y = 2.42 + (lv - 1) * 0.3;
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={0.9}>
      <group>
        {/* 機座 + 門型架 */}
        <Box args={[5.6, 1.2, 3.4]} position={[0, 0.6, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.55} />
        </Box>
        {[-1.9, 1.9].map((x) => (
          <Box key={x} args={[0.5, 4.4, 0.7]} position={[x, 3.4, -0.6]} castShadow receiveShadow>
            <meshStandardMaterial color="#5a6a72" metalness={0.6} />
          </Box>
        ))}
        <Box args={[4.6, 0.7, 1.0]} position={[0, 5.7, -0.6]} castShadow receiveShadow>
          <meshStandardMaterial color="#4a565c" metalness={0.55} />
        </Box>

        {/* 壓頭(press_depth L1) */}
        <group ref={ramRef} position={[0, 4.2, 0]}>
          <Box args={[1.5, 1.0, 1.2]} castShadow receiveShadow>
            <meshStandardMaterial color="#7a8890" metalness={0.72} />
          </Box>
          <Cylinder args={[0.24, 0.24, 1.3, 12]} position={[0, -1.1, 0]} castShadow>
            <meshStandardMaterial color="#9aa7ad" metalness={0.85} />
          </Cylinder>
          {/* 驗證探針:壓頭端面世界高度 ↔ press_depth */}
          <object3D name="probe:press_head" position={[0, -1.75, 0]} />
        </group>

        {/* 治具 + 工件本體 + 背蓋 */}
        <Box args={[2.2, 0.8, 1.8]} position={[0, 1.2, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#5f6b72" metalness={0.6} />
        </Box>
        <mesh ref={bodyPartRef} position={[0, 1.62, 0]} castShadow>
          <boxGeometry args={[1.25, 0.42, 0.55]} />
          <meshStandardMaterial color={WORKPIECE} roughness={0.4} metalness={0.6} />
        </mesh>
        <mesh ref={capRef} position={[0, 1.86, 0]} castShadow>
          <cylinderGeometry args={[0.3, 0.3, 0.12, 14]} />
          <meshStandardMaterial color="#b9c2c8" metalness={0.8} roughness={0.25} />
        </mesh>

        {/* 電動起子(鎖付段才下來轉) */}
        <group ref={driverRef} position={[0.95, 3.4, 0]}>
          <Cylinder args={[0.2, 0.2, 1.1, 12]} castShadow>
            <meshStandardMaterial color="#39474f" metalness={0.6} />
          </Cylinder>
          <Cylinder args={[0.07, 0.07, 0.7, 8]} position={[0, -0.85, 0]}>
            <meshStandardMaterial color="#c3ccd2" metalness={0.9} />
          </Cylinder>
        </group>

        {/* 振動盤 + 料位 + 料軌 */}
        <group ref={bowlRef} position={[-3.4, 2.3, 1.5]}>
          <Cylinder args={[1.0, 0.72, 0.8, 18]} castShadow receiveShadow>
            <meshStandardMaterial color="#69757c" metalness={0.65} />
          </Cylinder>
          <mesh ref={levelRef} position={[0, 2.42 - 2.3, 0]}>
            <cylinderGeometry args={[0.82, 0.6, 0.6, 16]} />
            <meshStandardMaterial color="#b58f5a" roughness={0.85} />
          </mesh>
        </group>
        <Box args={[2.4, 0.1, 0.34]} position={[-2.3, 1.95, 1.5]} castShadow>
          <meshStandardMaterial color="#4e5a61" metalness={0.6} />
        </Box>
        {feedRefs.map((r, i) => (
          <mesh key={i} ref={r} position={[-3.4, 2.05, 1.5]} castShadow>
            <cylinderGeometry args={[0.12, 0.12, 0.1, 10]} />
            <meshStandardMaterial color="#cbb98f" metalness={0.5} roughness={0.6} />
          </mesh>
        ))}

        <StatusBeacon motion={motion} position={[2.5, 2.0, -1.5]} scale={1.2} />
        <FaultSmoke motion={motion} position={[0, 6.2, -0.6]} />
        <StatusText motion={motion} position={[0, 0.9, 1.9]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function AssemblyStation3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(motion.tags.cycle_time || CYCLE_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 5.2, 11.5]} fov={42} target={[0, 2.8, 0]} shadowScale={24}
                  note={scaleNote(per)} overlay={<AsmReadout motion={motion} />}>
      <AssemblyStationModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function AsmReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["DEPTH", `${(t.press_depth ?? 0).toFixed(1)} mm`],
    ["FORCE", `${(t.press_force ?? 0).toFixed(1)} kN`, (t.press_force ?? 0) > NOM_FORCE_KN * 1.2],
    ["SCREW", `${(t.screw_torque ?? 0).toFixed(2)} N·m`,
      (t.screw_torque ?? 0) > 0.3 && (t.screw_torque ?? 0) < SCREW_SPEC_MIN_NM],
    ["FEED OK", `${(t.feed_success ?? 0).toFixed(1)} %`, (t.feed_success ?? 100) < 88],
    ["HOPPER", `${(t.feeder_level ?? 0).toFixed(0)} %`, (t.feeder_level ?? 100) < 15],
    ["MISSING", `${(t.missing_rate ?? 0).toFixed(2)} %`, (t.missing_rate ?? 0) > 2.0],
    ["ACT I", `${(t.actuator_current ?? 0).toFixed(1)} A`],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.0],
    ["CYCLE", `${(t.cycle_time ?? 0).toFixed(1)} s`, (t.cycle_time ?? CYCLE_S) > 17],
    ["ASSEMBLED", `${Math.round(t.assembled_count ?? 0)}`],
  ];
  const nm = t.screw_torque ?? 0;
  const hint = (t.missing_rate ?? 0) > 2.0
    ? "⚠ 缺件率升 + 給料成功率掉 → feeder_jam(清振動盤卡料,不是換伺服)"
    : nm > 0.3 && nm < SCREW_SPEC_MIN_NM
      ? "⚠ 鎖付扭力低於下限 → screwdriver_torque_drift(校 / 換電動起子)"
    : (t.vibration_rms ?? 0) > 4.0
      ? "⚠ 振動升 + 壓入力升、節拍拉長 → press_actuator_wear(這條會走到 fault)"
    : "壓入力 × 位移要**合著看** —— 同樣壓到 24 mm,力的曲線不同就代表壓錯了";
  return <Readout rows={rows} hint={hint} />;
}
