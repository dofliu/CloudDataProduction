/**
 * 電鍍線 3D(綁定表見 docs/animation_binding.md §4.25)。
 *
 * 連續掛鍍線:天車(hoist)沿槽列前進,**同時有多掛在不同槽裡**。所以電氣訊號
 * (電流密度 / 槽電壓 / 紋波)只看 running,不隨天車相位閃動 —— 與引擎一致。
 *
 * 天車位置是 L3(依 cycle_time 慢放並標倍率),因為它是「多久出一件」的節拍;
 * 而**鍍層厚度是 dwell_time 的函數,不是 cycle_time** —— 畫面把兩個時間都印在
 * Readout 上,學生才不會拿錯數字去套法拉第定律(這是本站刻意留的坑)。
 *
 * 三條退化線各有專屬的視覺:
 *   · anode_consumption → 陽極板**真的變薄**(anode_mass L1)+ 鍍層變薄
 *   · bath_aging        → 鍍液變濁 + 工件表面孔隙(porosity L2)
 *   · rectifier_aging   → 整流器機櫃過熱輝光 + 電流指示抖動(ripple L2)
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FaultSmoke, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const CYCLE_S = 12.0;
const THICK_SPEC_MIN_UM = 8.0;
const POROSITY_SPEC = 3.5;
const N_TANKS = 4;
const TANK_PITCH = 3.2;
const RAIL_LEN = TANK_PITCH * N_TANKS;
const ANODE_MAX_KG = 120, ANODE_MIN_KG = 35;

export const PlatingLineModel = ({ motion }: MachineProps) => {
  const hoistRef = useRef<THREE.Group>(null);
  const rackRefs = Array.from({ length: N_TANKS }, () => useRef<THREE.Group>(null));
  const rackMats = Array.from({ length: N_TANKS }, () => useRef<THREE.MeshStandardMaterial>(null));
  const anodeRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const bathMats = Array.from({ length: N_TANKS }, () => useRef<THREE.MeshStandardMaterial>(null));
  const rectMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const bubbleRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const phase = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.cycle_time || CYCLE_S, motion.timeScale);
    if (motion.running) phase.current = (phase.current + delta / per.value) % 1;

    // 天車:沿導軌連續前進(L3,節拍換算,倍率標在角落)
    if (hoistRef.current) {
      hoistRef.current.position.x = -RAIL_LEN / 2 + phase.current * RAIL_LEN;
      hoistRef.current.visible = motion.running;
    }

    const cd = clamp01((t.current_density ?? 0) / 4.4);
    const poro = clamp01((t.porosity_count ?? 0) / (POROSITY_SPEC * 2));
    const thick = clamp01((t.coating_thickness ?? 0) / (THICK_SPEC_MIN_UM * 1.4));

    // 各槽的掛具:鍍層越厚越亮(金屬光澤),孔隙越多越霧
    rackRefs.forEach((r, i) => {
      if (!r.current) return;
      r.current.visible = motion.running;
      // 掛具在槽內微幅擺動(搖擺鍍 —— 真的有這個動作,幫助氣泡脫離)
      r.current.position.y = 2.05 + 0.06 * Math.sin(performance.now() / 520 + i);
      const m = rackMats[i].current;
      if (m) {
        m.metalness = 0.35 + 0.6 * thick * (1 - 0.5 * poro);
        m.roughness = 0.12 + 0.7 * poro;
        const s = 0.55 + 0.4 * thick;
        m.color.setRGB(s * 0.86, s * 0.89, s * 0.94);   // 鎳白
      }
    });
    // 鍍液:pH 漂移 / 老化 → 變濁偏黃綠(bath_aging L2)
    const age = clamp01(((t.bath_ph ?? 4.4) - 4.4) / 1.35);
    bathMats.forEach((mr) => {
      const m = mr.current;
      if (!m) return;
      m.color.setRGB(0.16 + 0.30 * age, 0.40 - 0.06 * age, 0.34 - 0.20 * age);
      m.opacity = 0.5 + 0.3 * age;
    });
    // 陽極板:剩餘質量 → 厚度(anode_mass L1,消耗品餘命直接看得見)
    const am = clamp01(((t.anode_mass ?? ANODE_MAX_KG) - ANODE_MIN_KG) / (ANODE_MAX_KG - ANODE_MIN_KG));
    anodeRefs.forEach((r) => {
      if (!r.current) return;
      r.current.scale.z = 0.25 + 0.75 * am;
    });
    // 析氫氣泡:電流密度越高越多
    bubbleRefs.forEach((r, i) => {
      if (!r.current) return;
      r.current.visible = motion.running && cd > 0.15;
      const k = ((performance.now() / 700 + i * 0.31) % 1);
      r.current.position.set(-TANK_PITCH * 1.5 + i * TANK_PITCH, 1.5 + k * 1.1, 0.35);
      r.current.scale.setScalar(0.07 + 0.10 * cd);
      (r.current.material as THREE.MeshStandardMaterial).opacity = (1 - k) * 0.5;
    });
    // 整流器機櫃:紋波 + 自身發熱(rectifier_aging L2)
    if (rectMatRef.current) {
      const rip = clamp01((t.rectifier_ripple ?? 0) / 14);
      const ht = clamp01(((t.rectifier_temp ?? 0) - 50) / 46);
      const flick = rip > 0.2 ? 0.5 + 0.5 * Math.sin(performance.now() / 55) : 1;
      rectMatRef.current.emissive.setRGB(0.9 * ht, 0.2 * ht, 0.03 * ht);
      rectMatRef.current.emissiveIntensity = motion.running ? (0.08 + 2.2 * ht) * flick : 0.02;
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={0.6}>
      <group>
        {/* 地面機座 */}
        <Box args={[RAIL_LEN + 3.0, 0.7, 4.0]} position={[0, 0.35, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.5} />
        </Box>

        {/* 槽列 + 鍍液 + 掛具 */}
        {Array.from({ length: N_TANKS }, (_, i) => {
          const x = -RAIL_LEN / 2 + TANK_PITCH * (i + 0.5);
          return (
            <group key={i} position={[x, 0, 0]}>
              <Box args={[2.7, 2.0, 3.0]} position={[0, 1.7, 0]} castShadow receiveShadow>
                <meshStandardMaterial color="#4c5a62" metalness={0.5}
                                      transparent opacity={0.34} />
              </Box>
              <Box args={[2.4, 1.5, 2.7]} position={[0, 1.6, 0]}>
                <meshStandardMaterial ref={bathMats[i]} color="#2a6656" transparent opacity={0.55}
                                      roughness={0.3} />
              </Box>
              {/* 掛具(鍍層厚度 → 光澤;孔隙 → 霧面) */}
              <group ref={rackRefs[i]} position={[0, 2.05, 0]}>
                <Box args={[0.1, 1.5, 1.9]} position={[0, 0.5, 0]}>
                  <meshStandardMaterial color="#6d777f" metalness={0.7} />
                </Box>
                {[-0.55, 0, 0.55].map((z) => (
                  <Box key={z} args={[0.4, 0.9, 0.16]} position={[0, -0.25, z]} castShadow>
                    <meshStandardMaterial ref={rackMats[i]} color="#c8cdd4"
                                          metalness={0.7} roughness={0.2} />
                  </Box>
                ))}
              </group>
            </group>
          );
        })}

        {/* 陽極板(質量 → 厚度) */}
        {[-1, 1].map((sgn, i) => (
          <mesh key={sgn} ref={anodeRefs[i]}
                position={[-RAIL_LEN / 2 + TANK_PITCH * 0.5, 1.9, sgn * 1.15]} castShadow>
            <boxGeometry args={[2.0, 1.2, 0.3]} />
            <meshStandardMaterial color="#8d8f93" metalness={0.85} roughness={0.35} />
          </mesh>
        ))}
        {bubbleRefs.map((r, i) => (
          <mesh key={i} ref={r} position={[0, 1.6, 0.35]}>
            <sphereGeometry args={[0.5, 7, 6]} />
            <meshStandardMaterial color="#dff2ff" transparent opacity={0.4} />
          </mesh>
        ))}

        {/* 天車導軌 + 天車(節拍 L3) */}
        <Box args={[RAIL_LEN + 2.4, 0.22, 0.3]} position={[0, 5.4, 0]} castShadow>
          <meshStandardMaterial color="#59656c" metalness={0.7} />
        </Box>
        <group ref={hoistRef} position={[0, 5.4, 0]}>
          <Box args={[1.1, 0.7, 1.1]} position={[0, -0.5, 0]} castShadow>
            <meshStandardMaterial color="#7c8891" metalness={0.75} />
          </Box>
          <Cylinder args={[0.05, 0.05, 1.9, 8]} position={[0, -1.8, 0]}>
            <meshStandardMaterial color="#9aa7ad" metalness={0.85} />
          </Cylinder>
          {/* 驗證探針:天車世界 X ↔ 節拍相位 */}
          <object3D name="probe:hoist" position={[0, -0.5, 0]} />
        </group>

        {/* 整流器機櫃(紋波閃爍 + 過熱輝光) */}
        <Box args={[1.8, 3.0, 1.6]} position={[RAIL_LEN / 2 + 1.0, 1.9, -1.0]} castShadow receiveShadow>
          <meshStandardMaterial ref={rectMatRef} color="#4f5b62" metalness={0.6}
                                emissive="#ff7a1e" emissiveIntensity={0.08} />
        </Box>

        <StatusBeacon motion={motion} position={[-RAIL_LEN / 2 - 1.1, 2.4, -1.9]} scale={1.2} />
        <FaultSmoke motion={motion} position={[RAIL_LEN / 2 + 1.0, 3.8, -1.0]} />
        <StatusText motion={motion} position={[0, 0.9, 2.4]} size={0.32} />
      </group>
    </Shake>
  );
};

export default function PlatingLine3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(motion.tags.cycle_time || CYCLE_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 6.5, 16]} fov={44} target={[0, 2.6, 0]} shadowScale={32}
                  note={scaleNote(per)} overlay={<PlateReadout motion={motion} />}>
      <PlatingLineModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function PlateReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const thin = (t.coating_thickness ?? 99) < THICK_SPEC_MIN_UM;
  const porous = (t.porosity_count ?? 0) > POROSITY_SPEC;
  const rows: Row[] = [
    ["CURR DENS", `${(t.current_density ?? 0).toFixed(2)} A/dm²`, (t.current_density ?? 4) < 3.2],
    ["CELL V", `${(t.cell_voltage ?? 0).toFixed(2)} V`, (t.cell_voltage ?? 0) > 7.2],
    ["RIPPLE", `${(t.rectifier_ripple ?? 0).toFixed(1)} %`, (t.rectifier_ripple ?? 0) > 6],
    ["BATH T", `${(t.bath_temp ?? 0).toFixed(0)} °C`],
    ["pH", `${(t.bath_ph ?? 0).toFixed(2)}`, (t.bath_ph ?? 4.4) > 5.1],
    ["THICKNESS", `${(t.coating_thickness ?? 0).toFixed(2)} µm`, thin],
    ["POROSITY", `${(t.porosity_count ?? 0).toFixed(2)} /cm²`, porous],
    ["ANODE", `${(t.anode_mass ?? 0).toFixed(0)} kg`, (t.anode_mass ?? 120) < 55],
    ["RECT T", `${(t.rectifier_temp ?? 0).toFixed(0)} °C`, (t.rectifier_temp ?? 0) > 78],
    ["CYCLE", `${(t.cycle_time ?? 0).toFixed(1)} s`],
    ["DWELL", `${(t.dwell_time ?? 0).toFixed(0)} s`],
    ["PLATED", `${Math.round(t.plated_count ?? 0)}`],
  ];
  const hint = porous && !thin
    ? "⚠ 厚度還在規格內**但**孔隙率超標 → bath_aging(只看厚度會漏掉這一整類不良;調 / 換鍍液)"
    : thin ? "⚠ 鍍層過薄 + 陽極質量掉、槽電壓升 → anode_consumption(補掛陽極,不是換鍍液)"
    : (t.rectifier_ripple ?? 0) > 6 ? "⚠ 紋波升 + 整流器過熱 → rectifier_aging(這條會走到 fault)"
    : "厚度 = 電流密度 × **dwell_time**(不是 cycle_time)—— 拿錯時間會算出錯的答案";
  return <Readout rows={rows} hint={hint} />;
}
