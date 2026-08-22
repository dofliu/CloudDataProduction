/**
 * 扭力功能測試機 3D(綁定表見 docs/animation_binding.md §4.27)。
 *
 * 這台是**量測站**,不是加工站 —— 它不改變工件,只回答「這支合不合格」。
 * 所以畫面的主角不是機構,是那支**扭力錶**:錶針依 applied_torque 擺動(L1),
 * 錶面畫出允收帶(62 ± 3.1 N·m),峰值停在 peak_torque 的位置。
 *
 * 最重要的視覺是 `sensor_bias` 那根**紅色偏差指針**:它畫在錶面上,直接告訴學生
 * 「儀器說的」和「真的」差多少。真工廠靠定期校正與標準件比對才知道,這裡先把答案
 * 畫出來建立直覺 —— 因為這台的陷阱是:感測器漂了會讓**良品被退回**,
 * 學生若只看退回率會誤判成上游品質變差,對症其實是 calibrate_sensor。
 *
 * 夾具打滑(fixture_wear)則畫成工件在夾爪裡**突然轉一下**,並累計 slip_events。
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FaultSmoke, Shake, StatusBeacon, StatusText, WORKPIECE, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approach, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const CYCLE_S = 11.0;
const NOM_NM = 62.0;
const TOL_NM = 3.1;
const FULL_NM = 90.0;                  // 錶面滿刻度
const SWEEP = (240 * Math.PI) / 180;   // 錶面掃過的角度

/** 扭力值 → 錶針角度(rad)。0 在左下、滿刻度在右下,順時針。 */
const needleAngle = (nm: number) => SWEEP / 2 - clamp01(nm / FULL_NM) * SWEEP;

export const TorqueTesterModel = ({ motion }: MachineProps) => {
  const needleRef = useRef<THREE.Group>(null);
  const peakRef = useRef<THREE.Group>(null);
  const biasRef = useRef<THREE.Group>(null);
  const partRef = useRef<THREE.Group>(null);
  const jawRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const headRef = useRef<THREE.Group>(null);
  const bandRef = useRef<THREE.Mesh>(null);
  const phase = useRef(0);
  const shown = useRef(0);
  const slipSpin = useRef(0);
  const prevSlips = useRef<number | null>(null);
  const slipKick = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.cycle_time || CYCLE_S, motion.timeScale);
    if (motion.running) phase.current = (phase.current + delta / per.value) % 1;

    // 錶針:即時施加扭力(applied_torque L1 → 角度)
    const applied = motion.running ? (t.applied_torque ?? 0) : 0;
    shown.current = approach(shown.current, applied, 0.09, delta, 0.05);
    if (needleRef.current) needleRef.current.rotation.z = needleAngle(shown.current);
    // 峰值指針:停在 peak_torque(儀器讀到的值,含偏差)
    if (peakRef.current) {
      peakRef.current.visible = motion.running;
      peakRef.current.rotation.z = needleAngle(t.peak_torque ?? 0);
    }
    // 偏差指針(紅):sensor_bias —— 「儀器說的」與「真的」差多少
    if (biasRef.current) {
      const bias = t.sensor_bias ?? 0;
      biasRef.current.visible = Math.abs(bias) > 0.15;
      biasRef.current.rotation.z = needleAngle(NOM_NM + bias);
    }
    // 允收帶:超出即紅(判定的視覺化)
    if (bandRef.current) {
      const pk = t.peak_torque ?? NOM_NM;
      const out = Math.abs(pk - NOM_NM) > TOL_NM;
      const m = bandRef.current.material as THREE.MeshStandardMaterial;
      m.color.set(out && motion.running ? "#c9483c" : "#3f8f5a");
      m.emissive.set(out && motion.running ? "#c9483c" : "#1e4a2e");
      m.emissiveIntensity = motion.running ? 0.7 : 0.15;
    }

    // 加載頭:下壓扭轉(前 70% 相位加載)
    const loading = motion.running && phase.current < 0.70 ? phase.current / 0.70 : 0;
    if (headRef.current) {
      headRef.current.position.y = 3.5 - 0.5 * clamp01(loading * 3);
      headRef.current.rotation.y = loading * 1.5;
    }
    // 夾爪:夾持壓力掉 → 張開一點(clamp_pressure L2)
    const clamp = clamp01((t.clamp_pressure ?? 0) / 44);
    jawRefs.forEach((r, i) => {
      if (!r.current) return;
      const sgn = i === 0 ? -1 : 1;
      r.current.position.z = sgn * (0.52 + 0.16 * (1 - clamp));
    });
    // 打滑:slip_events 每 +1 → 工件在夾爪裡突然轉一下(看得見的「量測沒抓穩」)
    const slips = Math.round(t.slip_events ?? 0);
    if (prevSlips.current !== null && slips > prevSlips.current) slipKick.current = 1;
    prevSlips.current = slips;
    if (slipKick.current > 0) {
      slipSpin.current += delta * 9.0 * slipKick.current;
      slipKick.current = Math.max(0, slipKick.current - delta * 3.0);
    }
    if (partRef.current) {
      partRef.current.visible = motion.running;
      partRef.current.rotation.y = loading * 0.5 + slipSpin.current;
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={0.7}>
      <group>
        {/* 機座 + 立柱 */}
        <Box args={[4.6, 1.1, 3.0]} position={[0, 0.55, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.55} />
        </Box>
        <Box args={[0.8, 4.6, 1.0]} position={[-1.7, 3.3, -0.8]} castShadow receiveShadow>
          <meshStandardMaterial color="#5a6a72" metalness={0.6} />
        </Box>

        {/* 加載頭 */}
        <group ref={headRef} position={[0, 3.5, 0]}>
          <Cylinder args={[0.42, 0.42, 0.9, 14]} castShadow>
            <meshStandardMaterial color="#7a8890" metalness={0.75} />
          </Cylinder>
          <Cylinder args={[0.16, 0.16, 0.8, 10]} position={[0, -0.8, 0]}>
            <meshStandardMaterial color="#9aa7ad" metalness={0.88} />
          </Cylinder>
        </group>

        {/* 夾具 + 受測工具 */}
        <Box args={[1.8, 0.6, 1.6]} position={[0, 1.4, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#5f6b72" metalness={0.6} />
        </Box>
        {jawRefs.map((r, i) => (
          <mesh key={i} ref={r} position={[0, 1.95, i === 0 ? -0.52 : 0.52]} castShadow>
            <boxGeometry args={[0.7, 0.5, 0.22]} />
            <meshStandardMaterial color="#8a959b" metalness={0.8} />
          </mesh>
        ))}
        <group ref={partRef} position={[0, 2.0, 0]}>
          <Box args={[1.5, 0.16, 0.3]} castShadow>
            <meshStandardMaterial color={WORKPIECE} metalness={0.75} roughness={0.28} />
          </Box>
          <Cylinder args={[0.26, 0.26, 0.2, 14]} position={[0.72, 0, 0]} castShadow>
            <meshStandardMaterial color="#b9c2c8" metalness={0.85} roughness={0.22} />
          </Cylinder>
        </group>

        {/* ── 扭力錶(本站的主角)────────────────────── */}
        <group position={[2.3, 3.4, 0.4]} rotation={[0, -0.35, 0]}>
          <Cylinder args={[1.5, 1.5, 0.18, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow>
            <meshStandardMaterial color="#20262a" metalness={0.4} roughness={0.6} />
          </Cylinder>
          {/* 允收帶(62 ± 3.1)—— 超出即轉紅 */}
          <mesh ref={bandRef} position={[0, 0, -0.11]}
                rotation={[0, 0, needleAngle(NOM_NM)]}>
            <torusGeometry args={[1.15, 0.09, 8, 16, (TOL_NM * 2 / FULL_NM) * SWEEP]} />
            <meshStandardMaterial color="#3f8f5a" emissive="#1e4a2e" emissiveIntensity={0.7}
                                  toneMapped={false} />
          </mesh>
          {/* 刻度 */}
          {Array.from({ length: 10 }, (_, i) => {
            const a = needleAngle((i / 9) * FULL_NM);
            return (
              <Box key={i} args={[0.28, 0.05, 0.04]}
                   position={[Math.cos(a) * 1.28, Math.sin(a) * 1.28, -0.12]}
                   rotation={[0, 0, a]}>
                <meshStandardMaterial color="#cdd6db" />
              </Box>
            );
          })}
          {/* 即時錶針(applied_torque L1) */}
          <group ref={needleRef} position={[0, 0, -0.16]}>
            <Box args={[1.15, 0.07, 0.04]} position={[0.5, 0, 0]}>
              <meshStandardMaterial color="#f2f6f8" emissive="#8fa6b2" emissiveIntensity={0.5} />
            </Box>
            {/* 驗證探針:錶針端點世界位置 ↔ applied_torque */}
            <object3D name="probe:needle" position={[1.15, 0, 0]} />
          </group>
          {/* 峰值指針(peak_torque) */}
          <group ref={peakRef} position={[0, 0, -0.2]}>
            <Box args={[1.2, 0.045, 0.03]} position={[0.55, 0, 0]}>
              <meshStandardMaterial color="#e8c45a" emissive="#e8a02e" emissiveIntensity={0.8}
                                    toneMapped={false} />
            </Box>
          </group>
          {/* 感測器偏差指針(sensor_bias)—— 教學用的照妖鏡 */}
          <group ref={biasRef} position={[0, 0, -0.24]}>
            <Box args={[0.9, 0.04, 0.03]} position={[0.4, 0, 0]}>
              <meshStandardMaterial color="#e2564a" emissive="#c9483c" emissiveIntensity={1.1}
                                    toneMapped={false} />
            </Box>
          </group>
          <Cylinder args={[0.14, 0.14, 0.3, 12]} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.2]}>
            <meshStandardMaterial color="#8d979c" metalness={0.8} />
          </Cylinder>
        </group>

        <StatusBeacon motion={motion} position={[-2.1, 2.0, -1.3]} scale={1.2} />
        <FaultSmoke motion={motion} position={[0, 5.4, -0.8]} />
        <StatusText motion={motion} position={[0, 0.85, 1.7]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function TorqueTester3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(motion.tags.cycle_time || CYCLE_S, motion.timeScale);
  return (
    <MachineScene camera={[0.5, 5.0, 10.5]} fov={42} target={[0.6, 2.9, 0]} shadowScale={22}
                  note={scaleNote(per)} overlay={<TorqueReadout motion={motion} />}>
      <TorqueTesterModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function TorqueReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const bias = t.sensor_bias ?? 0;
  const pk = t.peak_torque ?? 0;
  const rows: Row[] = [
    ["APPLIED", `${(t.applied_torque ?? 0).toFixed(1)} N·m`],
    ["PEAK", `${pk.toFixed(2)} N·m`, Math.abs(pk - NOM_NM) > TOL_NM],
    ["SPEC", `${NOM_NM} ± ${TOL_NM} N·m`],
    ["SENSOR BIAS", `${bias >= 0 ? "+" : ""}${bias.toFixed(2)} N·m`, Math.abs(bias) > 1.5],
    ["ANGLE", `${(t.torque_angle ?? 0).toFixed(1)} °`, (t.torque_angle ?? 0) > 45],
    ["CLAMP", `${(t.clamp_pressure ?? 0).toFixed(1)} bar`, (t.clamp_pressure ?? 42) < 34],
    ["SLIPS", `${Math.round(t.slip_events ?? 0)}`],
    ["LOAD RATE", `${(t.load_rate ?? 0).toFixed(2)} N·m/s`],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 3.5],
    ["CYCLE", `${(t.cycle_time ?? 0).toFixed(1)} s`],
    ["TESTED", `${Math.round(t.tested_count ?? 0)}`],
  ];
  const hint = Math.abs(bias) > 1.5
    ? "⚠ 感測器偏差變大 → 良品也會被判退回。這不是上游做壞了,是**這台該校正**"
      + "(calibrate_sensor,不是 replace_wear_part)"
    : (t.clamp_pressure ?? 42) < 34
      ? "⚠ 夾持壓力掉 + 打滑次數升 + 角度變大 → fixture_wear(換夾爪)"
    : (t.vibration_rms ?? 0) > 3.5
      ? "⚠ 振動升 + 加載速率掉 → drive_motor_wear(這條會走到 fault)"
    : "量測站的「不良」有兩種:真的沒扭到(fixture_slip)與量錯了(sensor_out_of_cal)";
  return <Readout rows={rows} hint={hint} />;
}
