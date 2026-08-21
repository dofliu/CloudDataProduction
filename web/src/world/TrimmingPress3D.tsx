/**
 * 毛胚整修機 3D(綁定表見 docs/animation_binding.md §4.22)。
 *
 * 滑塊位置直接吃引擎的 slide_position(mm,0 上死點 → -90 下死點,L1);
 * 倍率 ≈1 時 L1 鎖定,否則本地跑同一條 cos 參數式慢放並標倍率(L3)。
 *
 * 這台的教學重點是**兩個指標的先後順序**:刀口鈍化時 trim_force 先升、burr_height 後升。
 * 畫面把兩者分開表達 —— 切斷瞬間的力用刀座輝光(先動),殘毛刺用出料工件的邊緣毛邊
 * (後動),學生看得出「力已經在升、毛刺還沒超規」的那段時間差。
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, Shake, StatusBeacon, StatusText, WORKPIECE, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approach, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const MM = 1 / 50;
const STROKE_MM = 90;
const CYCLE_S = 9.0;
const BURR_SPEC_MM = 0.15;

/** 與引擎 _slide_mm() 同一條式子:相位 → 滑塊位置(mm)。 */
const slideOf = (ph: number) => -STROKE_MM * 0.5 * (1 - Math.cos(ph * 2 * Math.PI));

export const TrimmingPressModel = ({ motion }: MachineProps) => {
  const slideRef = useRef<THREE.Group>(null);
  const knifeMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const partRef = useRef<THREE.Mesh>(null);
  const burrRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const ejectorRef = useRef<THREE.Mesh>(null);
  const flashRef = useRef<THREE.Mesh>(null);
  const phase = useRef(0);
  const pos = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.cycle_time || CYCLE_S, motion.timeScale);
    const locked = Math.abs(per.factor - 1) < 0.05 && typeof t.slide_position === "number";

    let mm: number;
    if (!motion.running) {
      mm = 0; phase.current = 0;
    } else if (locked) {
      mm = t.slide_position;                                  // L1
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      mm = slideOf(phase.current);                            // L3
    }
    pos.current = approach(pos.current, mm, 0.25, delta, 0.14);
    if (slideRef.current) slideRef.current.position.y = 3.6 + pos.current * MM;

    const depth = clamp01(-pos.current / STROKE_MM);
    // 切斷力(**先動**的指標)→ 刀座在下死點附近發亮,力越大越亮
    if (knifeMatRef.current) {
      const f = clamp01((t.trim_force ?? 0) / 320);
      knifeMatRef.current.emissiveIntensity = motion.running ? 0.05 + 2.6 * f * depth : 0.02;
    }
    // 殘毛刺(**後動**的指標)→ 出料工件邊緣長出可見毛邊
    const burr = clamp01((t.burr_height ?? 0) / (BURR_SPEC_MM * 3));
    burrRefs.forEach((r, i) => {
      if (!r.current) return;
      r.current.visible = motion.running && burr > 0.12;
      const h = 0.04 + 0.5 * burr;
      r.current.scale.set(1, h / 0.04, 1);
      r.current.position.y = 1.62 + (h - 0.04) / 2;
    });
    if (partRef.current) partRef.current.visible = motion.running;
    // 飛邊(被切下來的環)在切斷後掉落
    if (flashRef.current) {
      flashRef.current.visible = motion.running && depth > 0.75;
      flashRef.current.position.y = 1.5 - 0.6 * clamp01((depth - 0.75) / 0.25);
    }
    // 頂出行程 = ejector_stroke(mm,L1 → 頂桿伸出量;磨耗 → 頂不到位)
    if (ejectorRef.current) {
      const ej = (t.ejector_stroke ?? 0) / 25;
      ejectorRef.current.position.y = 1.05 + 0.5 * clamp01(ej) * (depth < 0.3 ? 1 : 0);
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={1.0}>
      <group>
        {/* 機座 + C 型機架 */}
        <Box args={[5.2, 1.4, 3.6]} position={[0, 0.7, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.55} />
        </Box>
        <Box args={[1.2, 5.4, 3.0]} position={[-2.6, 3.4, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#5a6a72" metalness={0.6} />
        </Box>
        <Box args={[4.6, 1.0, 2.6]} position={[-0.4, 5.8, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#4a565c" metalness={0.55} />
        </Box>

        {/* 滑塊 + 切邊刀(slide_position L1) */}
        <group ref={slideRef} position={[0, 3.6, 0]}>
          <Box args={[2.6, 1.1, 2.2]} castShadow receiveShadow>
            <meshStandardMaterial color="#7a8890" metalness={0.7} />
          </Box>
          <Box args={[2.0, 0.5, 1.8]} position={[0, -0.8, 0]} castShadow>
            <meshStandardMaterial ref={knifeMatRef} color="#9aa7ad" metalness={0.85}
                                  emissive="#ffb347" emissiveIntensity={0.05} toneMapped={false} />
          </Box>
          {/* 驗證探針:刀口世界高度 ↔ slide_position */}
          <object3D name="probe:slide" position={[0, -1.05, 0]} />
        </group>

        {/* 下模 + 工件 + 毛刺 */}
        <Box args={[2.4, 0.9, 2.0]} position={[0, 1.15, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#5f6b72" metalness={0.6} />
        </Box>
        <mesh ref={partRef} position={[0, 1.68, 0]} castShadow>
          <boxGeometry args={[1.3, 0.22, 0.7]} />
          <meshStandardMaterial color={WORKPIECE} roughness={0.55} metalness={0.35} />
        </mesh>
        {[-0.55, 0, 0.55].map((x, i) => (
          <mesh key={x} ref={burrRefs[i]} position={[x, 1.62, 0.36]}>
            <boxGeometry args={[0.18, 0.04, 0.04]} />
            <meshStandardMaterial color="#8f7f6a" roughness={0.9} />
          </mesh>
        ))}
        {/* 被切下的飛邊 */}
        <mesh ref={flashRef} position={[0, 1.5, -0.62]}>
          <boxGeometry args={[1.5, 0.05, 0.12]} />
          <meshStandardMaterial color="#7d7166" roughness={0.9} />
        </mesh>
        {/* 頂桿(ejector_stroke) */}
        <mesh ref={ejectorRef} position={[0, 1.05, 0]}>
          <cylinderGeometry args={[0.09, 0.09, 0.7, 10]} />
          <meshStandardMaterial color="#9aa7ad" metalness={0.8} />
        </mesh>

        <StatusBeacon motion={motion} position={[2.3, 2.0, -1.6]} scale={1.2} />
        <FaultSmoke motion={motion} position={[0, 6.4, 0]} />
        <StatusText motion={motion} position={[0, 1.9, 1.9]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function TrimmingPress3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(motion.tags.cycle_time || CYCLE_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 5.5, 11]} fov={42} target={[0, 3.0, 0]} shadowScale={24}
                  note={scaleNote(per)} overlay={<TrimReadout motion={motion} />}>
      <TrimmingPressModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function TrimReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["SLIDE", `${(t.slide_position ?? 0).toFixed(0)} mm`],
    ["TRIM FORCE", `${(t.trim_force ?? 0).toFixed(0)} ton`, (t.trim_force ?? 0) > 300],
    ["BURR", `${(t.burr_height ?? 0).toFixed(3)} mm`, (t.burr_height ?? 0) > BURR_SPEC_MM],
    ["EJECTOR", `${(t.ejector_stroke ?? 0).toFixed(1)} mm`, (t.ejector_stroke ?? 25) < 20],
    ["CURRENT", `${(t.motor_current ?? 0).toFixed(1)} A`],
    ["CYCLE", `${(t.cycle_time ?? 0).toFixed(1)} s`, (t.cycle_time ?? CYCLE_S) > 11],
    ["DEFORM", `${(t.deform_rate ?? 0).toFixed(2)} %`, (t.deform_rate ?? 0) > 3],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["TRIMMED", `${Math.round(t.trim_count ?? 0)}`],
  ];
  const hint = (t.burr_height ?? 0) > BURR_SPEC_MM
    ? "⚠ 殘毛刺超規(切斷力先前就在升了)→ trim_die_edge(換切邊刀口)"
    : (t.trim_force ?? 0) > 300 ? "⚠ 切斷力升但毛刺還在規格內 → 刀口開始鈍,提早排換刀"
    : (t.ejector_stroke ?? 25) < 20 ? "⚠ 頂出行程不足 + 變形不良 → ejector_wear"
    : clamp01(motion.severity) > 0.5 ? "⚠ 振動升 + 節拍拉長 → slide_bearing_wear" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
