/**
 * 研磨拋光機 3D(綁定表見 docs/animation_binding.md §4.23)。
 *
 * 這台的畫面要同時說清楚**三條互不相同的病**,學生才分得開:
 *   · abrasive_wear      → 砂輪**直徑真的變小**(wheel_diameter L1)+ 研磨壓力上升
 *   · dust_extraction_clog → 集塵管的氣流粒子變稀疏(extraction_flow L2)+ 磨屑飛散
 *   · spindle_bearing_wear → 抖動 + 主軸過熱輝光(只有這條會走到 fault)
 *
 * 砂輪轉速用 visualSpin 夾住(2850 rpm 直接畫會變成閃爍的實心盤),並標倍率。
 * 工件進退刀是 L1:接觸與否直接由引擎相位決定,前端不自己排時序。
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, HeatGlow, Shake, StatusBeacon, StatusText, WORKPIECE, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approach, clamp01, scaleNote, visualPeriod, visualSpin } from "./deviceMotion";

const CYCLE_S = 18.0;
const RA_SPEC_UM = 0.80;
const NOM_RPM = 2850;
const WHEEL_MAX_MM = 350;   // 新砂輪直徑
const WHEEL_MIN_MM = 260;   // 該換的直徑
const MM = 1 / 50;

/** 與引擎同一條相位判定:一個循環的前 62% 砂輪貼著工件。 */
const contactOf = (ph: number) => (ph < 0.62 ? 1 : 0);

export const GrindingPolisherModel = ({ motion }: MachineProps) => {
  const wheelRef = useRef<THREE.Group>(null);
  const wheelMeshRef = useRef<THREE.Mesh>(null);
  const partRef = useRef<THREE.Mesh>(null);
  const partMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const sparkRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const dustRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null),
                    useRef<THREE.Mesh>(null)];
  const spindleMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const phase = useRef(0);
  const spin = useRef(0);
  const feed = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.cycle_time || CYCLE_S, motion.timeScale);
    const rot = visualSpin(t.spindle_rpm ?? NOM_RPM, motion.timeScale);

    if (!motion.running) {
      phase.current = 0;
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      spin.current += delta * rot.value * 2 * Math.PI;   // rev/s → rad
    }
    const contact = motion.running ? contactOf(phase.current) : 0;

    // 砂輪直徑 = wheel_diameter(mm,L1)。消耗品餘命直接畫在幾何上。
    if (wheelMeshRef.current) {
      const dia = t.wheel_diameter ?? WHEEL_MAX_MM;
      const s = clamp01((dia - WHEEL_MIN_MM) / (WHEEL_MAX_MM - WHEEL_MIN_MM));
      const r = (WHEEL_MIN_MM + s * (WHEEL_MAX_MM - WHEEL_MIN_MM)) * 0.5 * MM;
      wheelMeshRef.current.scale.set(r / (WHEEL_MAX_MM * 0.5 * MM), 1, r / (WHEEL_MAX_MM * 0.5 * MM));
    }
    if (wheelRef.current) wheelRef.current.rotation.x = spin.current;

    // 工件進退刀:接觸時推到砂輪下(L1 —— 由引擎相位決定,不是前端自己排的時序)
    feed.current = approach(feed.current, contact ? 1 : 0, 0.18, delta, 0.02);
    if (partRef.current) {
      partRef.current.position.x = -2.6 + 2.6 * feed.current;
      partRef.current.visible = motion.running;
    }
    // 工件表面:粗糙度越差顏色越暗沉(surface_ra L2)
    if (partMatRef.current) {
      const ra = clamp01((t.surface_ra ?? 0) / (RA_SPEC_UM * 2));
      partMatRef.current.roughness = 0.15 + 0.75 * ra;
      partMatRef.current.metalness = 0.9 - 0.45 * ra;
    }
    // 火花:研磨壓力越大越多(grind_force L2),只在接觸時
    const force = clamp01((t.grind_force ?? 0) / 170);
    sparkRefs.forEach((r, i) => {
      if (!r.current) return;
      r.current.visible = contact > 0 && force > 0.1;
      const k = (performance.now() / 90 + i * 2.1) % 3;
      r.current.position.set(0.5 + k * 0.5, 2.4 - k * k * 0.22, (i - 1) * 0.22);
      r.current.scale.setScalar(0.05 + 0.11 * force);
    });
    // 集塵氣流粒子:抽風量越低越稀疏(extraction_flow L2)——「通道被堵住」的可見證據
    const flow = clamp01((t.extraction_flow ?? 0) / 2400);
    dustRefs.forEach((r, i) => {
      if (!r.current) return;
      r.current.visible = motion.running && flow > 0.05;
      const k = ((performance.now() / 620 + i * 0.25) % 1);
      r.current.position.set(1.5, 2.6 + k * 3.0, 0.1 * Math.sin(k * 8 + i));
      // 風量足 → 粒子被吸得又快又集中;風量掉 → 稀疏、飄散
      r.current.scale.setScalar(0.10 + 0.16 * flow);
      (r.current.material as THREE.MeshStandardMaterial).opacity = 0.12 + 0.5 * flow;
    });
    // 主軸過熱輝光(spindle_temp L2)—— 軸承那條病的專屬徵候
    if (spindleMatRef.current) {
      const h = clamp01(((t.spindle_temp ?? 0) - 62) / 55);
      spindleMatRef.current.emissive.setRGB(0.7 * h, 0.16 * h, 0.02 * h);
      spindleMatRef.current.emissiveIntensity = 0.05 + 2.0 * h;
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={1.1}>
      <group>
        {/* 機座 */}
        <Box args={[6.0, 1.3, 3.6]} position={[0, 0.65, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.55} />
        </Box>
        {/* 主軸箱(過熱輝光) */}
        <Box args={[2.2, 1.8, 2.0]} position={[1.5, 3.3, 0]} castShadow receiveShadow>
          <meshStandardMaterial ref={spindleMatRef} color="#5a6a72" metalness={0.7}
                                emissive="#ff7a20" emissiveIntensity={0.05} />
        </Box>
        <Box args={[1.0, 3.2, 1.6]} position={[2.6, 2.6, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#4a565c" metalness={0.6} />
        </Box>

        {/* 砂輪(wheel_diameter L1 → 半徑;spindle_rpm 夾住後的轉速) */}
        <group ref={wheelRef} position={[0.5, 3.3, 0]}>
          <Cylinder ref={wheelMeshRef as never} args={[3.5, 3.5, 0.55, 28]}
                    rotation={[0, 0, Math.PI / 2]} castShadow>
            <meshStandardMaterial color="#9c8878" roughness={0.85} metalness={0.15} />
          </Cylinder>
          {/* 輪面刻痕:轉起來看得出來真的在轉 */}
          {[0, 1, 2, 3].map((i) => (
            <Box key={i} args={[0.08, 0.62, 0.5]}
                 position={[Math.cos((i * Math.PI) / 2) * 2.6, Math.sin((i * Math.PI) / 2) * 2.6, 0]}>
              <meshStandardMaterial color="#6f5f52" roughness={0.9} />
            </Box>
          ))}
          {/* 驗證探針:砂輪外緣世界高度 ↔ wheel_diameter */}
          <object3D name="probe:wheel_rim" position={[0, -3.5, 0]} />
        </group>

        {/* 工件檯 + 工件(surface_ra → 表面質感) */}
        <Box args={[2.6, 0.5, 1.8]} position={[-1.4, 1.55, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#5f6b72" metalness={0.6} />
        </Box>
        <mesh ref={partRef} position={[-2.6, 2.0, 0]} castShadow>
          <boxGeometry args={[1.5, 0.36, 0.62]} />
          <meshStandardMaterial ref={partMatRef} color={WORKPIECE} roughness={0.2} metalness={0.85} />
        </mesh>

        {/* 火花 */}
        {sparkRefs.map((r, i) => (
          <mesh key={i} ref={r} position={[0.6, 2.4, 0]}>
            <sphereGeometry args={[0.09, 6, 5]} />
            <meshStandardMaterial color="#ffd27a" emissive="#ffae2e" emissiveIntensity={3.2}
                                  toneMapped={false} />
          </mesh>
        ))}

        {/* 集塵罩 + 管路 + 氣流粒子 */}
        <Box args={[1.4, 0.9, 1.6]} position={[1.5, 5.0, 0]} castShadow>
          <meshStandardMaterial color="#4e5a61" metalness={0.5} />
        </Box>
        <Cylinder args={[0.42, 0.42, 3.4, 14]} position={[1.5, 6.9, 0]} castShadow>
          <meshStandardMaterial color="#57646b" metalness={0.55} />
        </Cylinder>
        {dustRefs.map((r, i) => (
          <mesh key={i} ref={r} position={[1.5, 2.8, 0]}>
            <sphereGeometry args={[0.5, 7, 6]} />
            <meshStandardMaterial color="#b9b2a4" transparent opacity={0.35} />
          </mesh>
        ))}

        <HeatGlow motion={motion} position={[1.5, 3.3, 0]} radius={1.5} />
        <StatusBeacon motion={motion} position={[-2.6, 2.2, -1.6]} scale={1.2} />
        <FaultSmoke motion={motion} position={[1.5, 6.2, 0]} />
        <StatusText motion={motion} position={[0, 1.7, 2.0]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function GrindingPolisher3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(motion.tags.cycle_time || CYCLE_S, motion.timeScale);
  const rot = visualSpin(motion.tags.spindle_rpm ?? NOM_RPM, motion.timeScale);
  return (
    <MachineScene camera={[0, 5.5, 12]} fov={42} target={[0, 3.0, 0]} shadowScale={26}
                  note={scaleNote(per, rot)} overlay={<GrindReadout motion={motion} />}>
      <GrindingPolisherModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function GrindReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["SPINDLE", `${(t.spindle_rpm ?? 0).toFixed(0)} rpm`],
    ["GRIND F", `${(t.grind_force ?? 0).toFixed(0)} N`, (t.grind_force ?? 0) > 130],
    ["Ra", `${(t.surface_ra ?? 0).toFixed(2)} µm`, (t.surface_ra ?? 0) > RA_SPEC_UM],
    ["WHEEL Ø", `${(t.wheel_diameter ?? 0).toFixed(0)} mm`, (t.wheel_diameter ?? 350) < 280],
    ["DUST ΔP", `${(t.extraction_dp ?? 0).toFixed(2)} kPa`, (t.extraction_dp ?? 0) > 3.0],
    ["DUST FLOW", `${(t.extraction_flow ?? 0).toFixed(0)} m³/h`, (t.extraction_flow ?? 2400) < 1700],
    ["SPDL TEMP", `${(t.spindle_temp ?? 0).toFixed(0)} °C`, (t.spindle_temp ?? 0) > 85],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["CYCLE", `${(t.cycle_time ?? 0).toFixed(1)} s`, (t.cycle_time ?? CYCLE_S) > 22],
    ["GROUND", `${Math.round(t.ground_count ?? 0)}`],
  ];
  const ra = t.surface_ra ?? 0;
  const dp = t.extraction_dp ?? 0;
  const hint = ra > RA_SPEC_UM && dp > 3.0
    ? "⚠ 粗糙度超規 + 抽風壓差升、風量掉 → dust_extraction_clog(清集塵管路,不是換砂輪)"
    : ra > RA_SPEC_UM ? "⚠ 粗糙度超規 + 研磨力升、砂輪變小 → abrasive_wear(換砂輪)"
    : (t.spindle_temp ?? 0) > 85 ? "⚠ 主軸溫度 + 振動同時升 → spindle_bearing_wear(這條會走到 fault)"
    : (t.wheel_diameter ?? 350) < 280 ? "⚠ 砂輪快磨到下限,排程換輪" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
