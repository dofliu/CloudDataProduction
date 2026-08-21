/**
 * 鍛造壓機 3D(綁定表見 docs/animation_binding.md §4.21)。
 *
 * 滑塊位置直接吃引擎的 ram_position(mm,0 上死點 → -180 下死點,L1)——
 * 與沖壓機 ram_position 同款處理:倍率 ≈1 時 L1 鎖定,否則本地跑同一條 cos 參數式
 * 慢放並標倍率(L3)。噸位尖峰與下死點同相(引擎保證),畫面因此不必自己算力。
 *
 * 三條退化線:
 *   · ram_guide_wear → ram_deviation ↑ → 滑塊左右偏擺(繞 Z 微傾)+ 整機抖動
 *   · die_wear       → underfill_rate ↑ → 鍛件欠肉(出模工件變小)
 *   · descaler_clog  → descale_pressure ↓ → 除鱗噴霧變弱(壓入氧化皮的視覺前因)
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, HeatGlow, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approach, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const MM = 1 / 50;
const STROKE_MM = 180;
const STROKE_S = 12.0;
const NOM_TON = 1600;

/** 與引擎 _ram_mm() 同一條式子:相位 → 滑塊位置(mm)。 */
const ramOf = (ph: number) => -STROKE_MM * 0.5 * (1 - Math.cos(ph * 2 * Math.PI));

export const ForgingPressModel = ({ motion }: MachineProps) => {
  const ramRef = useRef<THREE.Group>(null);
  const billetRef = useRef<THREE.Mesh>(null);
  const billetMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const dieMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const sprayRef = useRef<THREE.Mesh>(null);
  const sprayMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const phase = useRef(0);
  const pos = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(STROKE_S, motion.timeScale);
    const locked = Math.abs(per.factor - 1) < 0.05 && typeof t.ram_position === "number";

    let mm: number;
    if (!motion.running) {
      mm = 0; phase.current = 0;                       // 停機 → 上死點(安全位置)
    } else if (locked) {
      mm = t.ram_position;                             // L1:直接用引擎值
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      mm = ramOf(phase.current);                       // L3:同一條參數式慢放
    }
    pos.current = approach(pos.current, mm, 0.4, delta, 0.16);
    if (ramRef.current) {
      ramRef.current.position.y = 5.2 + pos.current * MM;
      // 導軌磨耗 → 滑塊偏擺(ram_deviation mm → 傾角,L2:位移換成可見的角度)
      const dev = clamp01((t.ram_deviation ?? 0) / 1.6);
      ramRef.current.rotation.z = dev * 0.035 * Math.sin(performance.now() / 90);
    }

    // 鍛件:熱棒料(billet_temp_in)+ 欠肉時體積變小(underfill_rate)
    if (billetRef.current && billetMatRef.current) {
      const depth = clamp01(-pos.current / STROKE_MM);
      const uf = clamp01((t.underfill_rate ?? 0) / 9);
      billetRef.current.scale.set(1 - 0.12 * uf, Math.max(0.35, 1 - 0.6 * depth), 1 - 0.12 * uf);
      billetRef.current.visible = motion.running;
      const hot = clamp01(((t.billet_temp_in ?? 0) - 600) / 620);
      billetMatRef.current.emissive.setRGB(hot, 0.34 * hot * hot, 0.05 * hot);
      billetMatRef.current.emissiveIntensity = motion.running ? 0.3 + 3.0 * hot : 0;
    }
    if (dieMatRef.current) {
      const h = motion.running ? clamp01(((t.die_temp ?? 0) - 240) / 140) : 0;
      dieMatRef.current.emissive.setRGB(0.55 * h, 0.13 * h, 0.02 * h);
      dieMatRef.current.emissiveIntensity = 0.15 + 1.4 * h;
    }
    // 除鱗噴霧:descale_pressure(bar,L2 → 噴霧大小與亮度)
    if (sprayRef.current && sprayMatRef.current) {
      const p = clamp01((t.descale_pressure ?? 0) / 180);
      sprayRef.current.visible = motion.running && p > 0.08;
      sprayRef.current.scale.setScalar(0.5 + 1.1 * p);
      sprayMatRef.current.opacity = 0.15 + 0.45 * p;
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={1.4}>
      <group>
        {/* 機座 + 立柱 */}
        <Box args={[6.6, 1.6, 4.4]} position={[0, 0.8, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.55} />
        </Box>
        {[-2.4, 2.4].map((x) => (
          <Box key={x} args={[0.9, 7.0, 1.2]} position={[x, 4.6, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#5a6a72" metalness={0.6} />
          </Box>
        ))}
        {/* 頂樑 + 飛輪 */}
        <Box args={[6.2, 1.2, 2.4]} position={[0, 8.4, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#4a565c" metalness={0.55} />
        </Box>
        <Cylinder args={[1.5, 1.5, 0.5, 20]} rotation={[0, 0, Math.PI / 2]}
                  position={[3.3, 8.4, 0]} castShadow>
          <meshStandardMaterial color="#6b757c" metalness={0.7} />
        </Cylinder>

        {/* 滑塊 + 上模(ram_position L1) */}
        <group ref={ramRef} position={[0, 5.2, 0]}>
          <Box args={[3.4, 1.5, 2.6]} castShadow receiveShadow>
            <meshStandardMaterial color="#7a8890" metalness={0.7} />
          </Box>
          <Box args={[2.4, 0.7, 2.0]} position={[0, -1.05, 0]} castShadow>
            <meshStandardMaterial color="#8a5a3a" metalness={0.45} />
          </Box>
          {/* 驗證探針:上模面世界高度 ↔ ram_position */}
          <object3D name="probe:ram" position={[0, -1.4, 0]} />
        </group>

        {/* 下模(die_temp 輝光) */}
        <Box args={[2.8, 1.0, 2.2]} position={[0, 2.1, 0]} castShadow receiveShadow>
          <meshStandardMaterial ref={dieMatRef} color="#8a5a3a" metalness={0.45}
                                emissive="#ff6a20" emissiveIntensity={0.15} />
        </Box>
        {/* 鍛件(熱棒料 → 被壓扁) */}
        <mesh ref={billetRef} position={[0, 2.9, 0]} castShadow>
          <cylinderGeometry args={[0.5, 0.5, 0.9, 16]} />
          <meshStandardMaterial ref={billetMatRef} color="#8a6a55" emissive="#ff5a10"
                                emissiveIntensity={2.2} toneMapped={false} />
        </mesh>
        <HeatGlow motion={motion} position={[0, 2.9, 0]} radius={1.5} />

        {/* 除鱗噴嘴 + 噴霧 */}
        <Cylinder args={[0.12, 0.12, 1.2, 10]} rotation={[0, 0, Math.PI / 2.6]}
                  position={[-1.9, 3.4, 0.9]} castShadow>
          <meshStandardMaterial color="#5a6a72" metalness={0.7} />
        </Cylinder>
        <mesh ref={sprayRef} position={[-1.1, 3.0, 0.6]}>
          <sphereGeometry args={[0.5, 12, 10]} />
          <meshStandardMaterial ref={sprayMatRef} color="#cfe6f5" transparent opacity={0.4} />
        </mesh>

        <StatusBeacon motion={motion} position={[2.9, 2.6, -1.9]} scale={1.3} />
        <FaultSmoke motion={motion} position={[0, 9.2, 0]} />
        <StatusText motion={motion} position={[0, 2.0, 2.4]} size={0.32} />
      </group>
    </Shake>
  );
};

export default function ForgingPress3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(STROKE_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 7.5, 14]} fov={42} target={[0, 4.2, 0]} shadowScale={28}
                  note={scaleNote(per)} overlay={<ForgeReadout motion={motion} />}>
      <ForgingPressModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function ForgeReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["RAM", `${(t.ram_position ?? 0).toFixed(0)} mm`],
    ["TONNAGE", `${(t.forging_tonnage ?? 0).toFixed(0)} / ${NOM_TON} ton`],
    ["DIE TEMP", `${(t.die_temp ?? 0).toFixed(0)} °C`],
    ["BILLET IN", `${(t.billet_temp_in ?? 0).toFixed(0)} °C`, (t.billet_temp_in ?? 1175) < 1120],
    ["DESCALE", `${(t.descale_pressure ?? 0).toFixed(0)} bar`],
    ["RAM DEV", `${(t.ram_deviation ?? 0).toFixed(2)} mm`, (t.ram_deviation ?? 0) > 0.6],
    ["UNDERFILL", `${(t.underfill_rate ?? 0).toFixed(2)} %`, (t.underfill_rate ?? 0) > 3],
    ["SCALE DEF", `${(t.scale_defect_rate ?? 0).toFixed(2)} %`, (t.scale_defect_rate ?? 0) > 3],
    ["FORGED", `${Math.round(t.forge_count ?? 0)}`],
  ];
  const hint = (t.ram_deviation ?? 0) > 0.6
    ? "⚠ 滑塊偏擺 + 振動升 → ram_guide_wear(這條會走到 fault)"
    : (t.underfill_rate ?? 0) > 3 ? "⚠ 欠肉率升但除鱗壓力正常 → die_wear(換 / 修鍛模)"
    : (t.scale_defect_rate ?? 0) > 3 ? "⚠ 除鱗壓力掉 + 壓入氧化皮 → descaler_clog(清噴嘴)" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
