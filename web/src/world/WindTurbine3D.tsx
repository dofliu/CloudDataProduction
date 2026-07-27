/**
 * 風力發電機 3D(綁定表見 docs/animation_binding.md §4.7)。
 *
 * 修正:機艙原本繞 `tags.yaw_angle` 轉 —— 引擎沒有這支 tag。實際有的是
 * `pitch_angle`(葉片槳距,0°=工作 / 88°=順槳停機),語意完全不同:它讓**葉片沿自身
 * 長軸轉**,是「停機時葉片轉成順風面」這個關鍵動作。停機時學生應該看到葉片順槳 + 停轉,
 * 而不是整個機艙偏航。
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { CanvasLabel, FX, FaultSmoke, HeatGlow, Shake, StatusBeacon, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approachAngleDeg, clamp01, scaleNote, visualSpin } from "./deviceMotion";

export const WindTurbineModel = ({ motion }: MachineProps) => {
  const rotorRef = useRef<THREE.Group>(null);
  const bladeRefs = [useRef<THREE.Group>(null), useRef<THREE.Group>(null), useRef<THREE.Group>(null)];
  const vaneRef = useRef<THREE.Group>(null);
  const pitchRef = useRef(0);

  useFrame((st, delta) => {
    const t = motion.tags;
    // 轉速:6~15 rpm 本身很慢,但 sim ×120 之後在牆鐘上是 30 rev/s,仍需降頻(倍率已標示)
    const spin = visualSpin(t.rotor_rpm ?? 0, motion.timeScale).value;
    if (rotorRef.current) rotorRef.current.rotation.z -= spin * Math.PI * 2 * delta;

    // 槳距角:0°=工作面迎風、88°=順槳。停機 / 故障時引擎會回 88°,葉片會轉平停下。
    pitchRef.current = approachAngleDeg(pitchRef.current, t.pitch_angle ?? 0, 0.8, delta);
    for (const r of bladeRefs) if (r.current) r.current.rotation.y = THREE.MathUtils.degToRad(pitchRef.current);

    // 風向袋擺動幅度綁 wind_speed(m/s):風大擺得兇
    if (vaneRef.current) {
      const ws = clamp01((t.wind_speed ?? 0) / 25);
      vaneRef.current.rotation.z = Math.sin(st.clock.elapsedTime * 3.8) * 0.35 * ws;
    }
  });

  const tower = bodyColor(motion, "#dddddd");
  const feathered = (motion.tags.pitch_angle ?? 0) > 45;

  return (
    <Shake motion={motion} amount={0.5}>
      <group position={[0, -1, 0]}>
        <Cylinder args={[1.5, 2, 1, 32]} position={[0, 0.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#666666" />
        </Cylinder>
        <Cylinder args={[0.8, 1.5, 14, 32]} position={[0, 8, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={tower} />
        </Cylinder>

        <group position={[0, 15, 0]}>
          <Box args={[2, 2, 4.5]} position={[0, 0, -1]} castShadow receiveShadow>
            <meshStandardMaterial color="#dddddd" />
          </Box>
          {/* 齒輪箱 / 發電機發熱 */}
          <HeatGlow motion={motion} position={[0, 0, -1]} radius={2.4} />

          <group position={[0, 0, 1.5]} ref={rotorRef}>
            <Cylinder args={[0.6, 0.8, 1.5, 16]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
              <meshStandardMaterial color="#cccccc" />
            </Cylinder>
            {[0, 1, 2].map((i) => (
              <group key={i} rotation={[0, 0, (i * Math.PI * 2) / 3]}>
                {/* 內層 group 繞葉片長軸(Y)轉 = 槳距 */}
                <group ref={bladeRefs[i]} position={[0, 5.5, 0]}>
                  <Box args={[0.5, 10, 0.12]} castShadow receiveShadow>
                    <meshStandardMaterial color="#ffffff" />
                  </Box>
                </group>
              </group>
            ))}
          </group>

          {/* 風向袋:靠風速擺動,讓「有風但不發電」一眼看得出來 */}
          <group position={[0, 1.4, -3.2]} ref={vaneRef}>
            <Box args={[0.08, 1.0, 0.08]} position={[0, 0.5, 0]}><meshStandardMaterial color="#8a7c63" /></Box>
            <Box args={[0.9, 0.35, 0.04]} position={[0.5, 1.0, 0]}><meshStandardMaterial color={FX.warn} /></Box>
          </group>

          <StatusBeacon motion={motion} position={[1.3, -1.0, -2.2]} scale={1.2} />
          <FaultSmoke motion={motion} position={[0, 1.2, -1]} />
        </group>
      </group>
      {feathered && (
        <CanvasLabel text="葉片順槳 pitch 88°" position={[0, 12.6, 3]} height={1.0} color={FX.warn} />
      )}
    </Shake>
  );
};

export default function WindTurbine3D({ motion }: MachineProps) {
  const spin = visualSpin(motion.tags.rotor_rpm ?? 0, motion.timeScale);
  return (
    <MachineScene camera={[15, 15, 25]} fov={40} target={[0, 10, 0]} env="outdoor"
                  ground="#6a8a5a" groundSize={100} shadowScale={40} note={scaleNote(spin)}
                  overlay={<TurbineReadout motion={motion} />}>
      <WindTurbineModel motion={motion} />
    </MachineScene>
  );
}

function TurbineReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["WIND", `${(t.wind_speed ?? 0).toFixed(1)} m/s`],
    ["ROTOR", `${(t.rotor_rpm ?? 0).toFixed(1)} rpm`],
    ["PITCH", `${(t.pitch_angle ?? 0).toFixed(1)} °`, (t.pitch_angle ?? 0) > 45],
    ["POWER", `${(t.power_output ?? 0).toFixed(0)} kW`],
    ["GEARBOX", `${(t.gearbox_temp ?? 0).toFixed(1)} °C`, (t.gearbox_temp ?? 0) > 80],
    ["GENERATOR", `${(t.generator_temp ?? 0).toFixed(1)} °C`, (t.generator_temp ?? 0) > 80],
    ["NACELLE", `${(t.nacelle_temp ?? 0).toFixed(1)} °C`],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["ENERGY", `${(t.total_energy ?? 0).toFixed(0)} kWh`],
  ];
  const hint = (t.pitch_angle ?? 0) > 45 && (t.wind_speed ?? 0) > 4
    ? "有風但葉片順槳 → 機組被停機或故障(非無風)"
    : clamp01(motion.severity) > 0.5 ? "⚠ 振動 + 齒輪箱溫升 → gearbox_wear" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
