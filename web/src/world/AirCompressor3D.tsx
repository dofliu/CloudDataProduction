/**
 * 空壓機 3D(綁定表見 docs/animation_binding.md §4.8)。
 *
 * 修正:壓力錶原本讀 `tags.tank_pressure` —— 引擎沒有這支 tag,永遠是 undefined。
 * 正確欄位是 `outlet_pressure`(bar),另外把學生可寫的 ⚙ pressure_setpoint 畫成
 * 錶面紅線,學生改設定點後可以立刻看到指針追過去。
 *
 * 濾網阻塞(filter_clog)的教學重點是「電流升 + 流量降」兩訊號交叉,所以出風粒子
 * 密度綁 flow、機殼熱綁 motor_temp,兩者一起看就能讀出阻塞。
 */
import React, { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { CanvasLabel, FaultSmoke, HeatGlow, Shake, StatusBeacon, StatusText, bodyColor, FX } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01, scaleNote, visualSpin } from "./deviceMotion";

const GAUGE_MAX_BAR = 10;
const GAUGE_SWEEP = (Math.PI * 3) / 2;     // 錶盤 270°
const MOTOR_RPM = 1500;                    // 空壓機馬達額定(引擎未發此 tag,屬機構常數)

/** 出風氣流:粒子密度與速度綁 flow(m³/min)。 */
const AirJet = ({ flow, active }: { flow: number; active: boolean }) => {
  const COUNT = 36;
  const positions = useMemo(() => new Float32Array(COUNT * 3).fill(-100), []);
  const ref = useRef<THREE.Points>(null);

  useFrame((_, delta) => {
    if (!ref.current) return;
    const p = ref.current.geometry.attributes.position.array as Float32Array;
    const live = active ? Math.round(COUNT * clamp01(flow / 8)) : 0;
    const speed = 2 + 1.6 * clamp01(flow / 8);
    for (let i = 0; i < COUNT; i++) {
      if (i >= live) { p[i * 3 + 1] = -100; continue; }
      if (p[i * 3] > 3.2 || p[i * 3 + 1] < -50) {
        p[i * 3] = 0; p[i * 3 + 1] = (Math.random() - 0.5) * 0.25; p[i * 3 + 2] = (Math.random() - 0.5) * 0.25;
      } else {
        p[i * 3] += speed * delta;
        p[i * 3 + 1] += (Math.random() - 0.5) * 0.6 * delta;
        p[i * 3 + 2] += (Math.random() - 0.5) * 0.6 * delta;
      }
    }
    ref.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points frustumCulled={false} ref={ref} position={[-3.6, 1.5, 0]}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={COUNT} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.16} color="#bcd8e8" transparent opacity={0.55} depthWrite={false} />
    </points>
  );
};

export const AirCompressorModel = ({ motion }: MachineProps) => {
  const flywheelRef = useRef<THREE.Group>(null);
  const pistonRef = useRef<THREE.Mesh>(null);
  const needleRef = useRef<THREE.Group>(null);
  const spinPhase = useRef(0);

  const t = motion.tags;
  const pressure = t.outlet_pressure ?? 0;               // ★ 正確 tag
  const setpoint = motion.setpoints.pressure_setpoint ?? 7.5;
  const flow = t.flow ?? 0;

  useFrame((_, delta) => {
    if (!motion.running) return;
    // L3:1500 rpm 直接畫會 aliasing,降頻(倍率標在畫面上)
    const spin = visualSpin(MOTOR_RPM, motion.timeScale).value;
    spinPhase.current += spin * delta;
    if (flywheelRef.current) flywheelRef.current.rotation.z = -spinPhase.current * Math.PI * 2;
    // 活塞與飛輪同相位(機構上本來就是同一根曲軸)
    if (pistonRef.current) pistonRef.current.position.y = 0.4 + Math.sin(spinPhase.current * Math.PI * 2) * 0.15;
  });

  useFrame((_, delta) => {
    if (!needleRef.current) return;
    const target = -GAUGE_SWEEP / 2 + clamp01(pressure / GAUGE_MAX_BAR) * GAUGE_SWEEP;
    needleRef.current.rotation.z += (target - needleRef.current.rotation.z) * (1 - Math.exp(-delta / 0.25));
  });

  const machinery = bodyColor(motion);
  const tankColor = "#4477aa";
  const setAngle = -GAUGE_SWEEP / 2 + clamp01(setpoint / GAUGE_MAX_BAR) * GAUGE_SWEEP;

  return (
    <Shake motion={motion}>
      <group position={[0, -1, 0]}>
        {/* 儲氣桶 */}
        <Cylinder args={[1.5, 1.5, 7, 32]} rotation={[0, 0, Math.PI / 2]} position={[0, 1.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={tankColor} metalness={0.6} roughness={0.4} />
        </Cylinder>
        {[[-3.5, 0], [3.5, Math.PI]].map(([x, rot], i) => (
          <mesh key={i} position={[x, 1.5, 0]} rotation={[0, 0, rot]} castShadow receiveShadow>
            <sphereGeometry args={[1.5, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2]} />
            <meshStandardMaterial color={tankColor} metalness={0.6} roughness={0.4} />
          </mesh>
        ))}
        {[-2.5, 2.5].map((x, i) => (
          <group key={i}>
            <Box args={[0.5, 1, 1.2]} position={[x, 0.5, 0.8]} castShadow receiveShadow><meshStandardMaterial color="#333" /></Box>
            <Box args={[0.5, 1, 1.2]} position={[x, 0.5, -0.8]} castShadow receiveShadow><meshStandardMaterial color="#333" /></Box>
          </group>
        ))}

        <Box args={[4, 0.2, 2.5]} position={[0.5, 3.1, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#222" />
        </Box>

        {/* 馬達 */}
        <Cylinder args={[0.7, 0.7, 2, 32]} rotation={[Math.PI / 2, 0, 0]} position={[1.5, 3.8, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={machinery} />
        </Cylinder>
        <HeatGlow motion={motion} position={[1.5, 3.8, 0]} radius={1.5} />
        <Cylinder args={[0.3, 0.3, 0.2, 16]} rotation={[Math.PI / 2, 0, 0]} position={[1.5, 3.8, 1.1]} castShadow receiveShadow>
          <meshStandardMaterial color="#444" />
        </Cylinder>

        {/* 壓縮泵 + 散熱鰭片 + 活塞 */}
        <Box args={[1.5, 1.5, 1.5]} position={[-0.5, 3.85, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={machinery} />
        </Box>
        <group position={[-0.5, 4.6, 0]}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Box key={i} args={[1.2, 0.05, 1.2]} position={[0, i * 0.15, 0]} castShadow receiveShadow>
              <meshStandardMaterial color="#555" />
            </Box>
          ))}
          <Cylinder ref={pistonRef} args={[0.4, 0.4, 0.8, 16]} position={[0, 0.4, 0]}>
            <meshStandardMaterial color="#ccc" />
          </Cylinder>
        </group>

        {/* 飛輪 */}
        <group position={[-0.5, 3.8, 1.1]} ref={flywheelRef}>
          <Cylinder args={[1.2, 1.2, 0.2, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#222" />
          </Cylinder>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Box key={i} args={[2.4, 0.1, 0.1]} rotation={[0, 0, (i * Math.PI) / 3]} castShadow receiveShadow>
              <meshStandardMaterial color="#444" />
            </Box>
          ))}
        </group>
        <group position={[0.5, 3.8, 1.1]}>
          <Box args={[2, 0.8, 0.15]} castShadow receiveShadow><meshStandardMaterial color="#111" /></Box>
        </group>
        <Cylinder args={[0.1, 0.1, 2, 8]} position={[-1.5, 3.5, 0]} rotation={[0, 0, Math.PI / 6]} castShadow receiveShadow>
          <meshStandardMaterial color="#b87333" roughness={0.3} metalness={0.8} />
        </Cylinder>

        {/* 壓力錶:指針 = outlet_pressure,紅線 = ⚙ pressure_setpoint */}
        <group position={[-2.5, 3.5, 1.05]}>
          <Cylinder args={[0.62, 0.62, 0.1, 28]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#f2ede2" />
          </Cylinder>
          {Array.from({ length: 11 }, (_, i) => {
            const a = -GAUGE_SWEEP / 2 + (i / 10) * GAUGE_SWEEP;
            return (
              <Box key={i} args={[0.04, 0.12, 0.02]} position={[Math.sin(a) * 0.5, Math.cos(a) * 0.5, 0.06]} rotation={[0, 0, -a]}>
                <meshStandardMaterial color="#7a6b58" />
              </Box>
            );
          })}
          {/* 設定點紅線 */}
          <Box args={[0.05, 0.2, 0.02]} position={[Math.sin(setAngle) * 0.46, Math.cos(setAngle) * 0.46, 0.07]} rotation={[0, 0, -setAngle]}>
            <meshStandardMaterial color={FX.fault} emissive={FX.fault} emissiveIntensity={1.2} toneMapped={false} />
          </Box>
          {/* 指針 */}
          <group ref={needleRef} position={[0, 0, 0.08]}>
            <Box args={[0.05, 0.52, 0.02]} position={[0, 0.26, 0]}>
              <meshStandardMaterial color="#31281c" />
            </Box>
            {/* 驗證探針:指針尖端 —— 相對錶心的方位角應與 outlet_pressure 線性 */}
            <object3D name="probe:gauge_tip" position={[0, 0.52, 0]} />
          </group>
          <object3D name="probe:gauge_center" position={[0, 0, 0.08]} />
          <CanvasLabel text={`${pressure.toFixed(2)} bar`} position={[0, -0.9, 0.08]} height={0.28} />
        </group>

        <AirJet flow={flow} active={motion.running} />

        <StatusBeacon motion={motion} position={[3.2, 3.1, 0]} scale={1.3} />
        <FaultSmoke motion={motion} position={[-0.5, 5.6, 0]} />
        <StatusText motion={motion} position={[-2.5, 5.2, 0]} size={0.32} />
      </group>
    </Shake>
  );
};

export default function AirCompressor3D({ motion, debug }: MachineProps) {
  const spin = visualSpin(MOTOR_RPM, motion.timeScale);
  return (
    <MachineScene camera={[0, 6, 12]} fov={45} target={[0, 2.5, 0]} note={scaleNote(spin)}
                  overlay={<CompressorReadout motion={motion} />}>
      <AirCompressorModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function CompressorReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  // 濾網阻塞的判讀:電流偏高但流量偏低(兩訊號交叉,單看一支看不出來)
  const clog = (t.motor_current ?? 0) > 24 && (t.flow ?? 8) < 6.5;
  const rows: Row[] = [
    ["PRESSURE", `${(t.outlet_pressure ?? 0).toFixed(2)} bar`],
    ["SETPOINT", `${(motion.setpoints.pressure_setpoint ?? 7.5).toFixed(1)} bar`],
    ["FLOW", `${(t.flow ?? 0).toFixed(2)} m³/min`, clog],
    ["CURRENT", `${(t.motor_current ?? 0).toFixed(2)} A`, clog],
    ["MOTOR TEMP", `${(t.motor_temp ?? 0).toFixed(1)} °C`, (t.motor_temp ?? 0) > 70],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["HOURS", `${(t.running_hours ?? 0).toFixed(1)} h`],
  ];
  const hint = clog ? "⚠ 電流高 + 流量低 → filter_clog 徵兆"
    : clamp01(motion.severity) > 0.5 ? "⚠ 振動偏高 → motor_bearing 退化" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
