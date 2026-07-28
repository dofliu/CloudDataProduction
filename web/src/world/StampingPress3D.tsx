/**
 * 沖壓機 3D(綁定表見 docs/animation_binding.md §4.5)。
 *
 * 滑塊高度直接吃引擎的 ram_position(mm, 0~120,L1),不再自己跑 sin。
 * 行程節拍取自 stroke_rate(spm)。60 spm 在 sim ×120 下等於牆鐘 1/120 秒一下,
 * 遠低於可視極限,因此走 L3 慢放並在畫面標示倍率;此時 ram_position 已低於
 * Nyquist,不做相位鎖定(倍率≈1 時才鎖)。
 *
 * 兩條退化線都畫得出來:
 *   · clutch_brake_wear → vibration_rms → 整機抖動(Shake)+ 噸位錶波動
 *   · die_wear → burr_rate → 工件邊緣毛邊變粗變暗(良率題,設備不會 fault)
 *   · lube_pump_wear → lubrication_pressure → 潤滑警示燈
 */
import React, { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, HeatGlow, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const RAM_MAX_MM = 120;      // 引擎 ram_position 上死點
const RAM_TRAVEL = 3.0;      // 模型單位行程

const Sparks = ({ active, position, burr }: { active: boolean; position: THREE.Vector3; burr: number }) => {
  const COUNT = 30;
  const particles = useMemo(() => new Float32Array(COUNT * 3).fill(-100), []);
  const vel = useMemo(() => Array.from({ length: COUNT }, () => new THREE.Vector3()), []);
  const ref = useRef<THREE.Points>(null);

  useFrame((_, delta) => {
    if (!ref.current) return;
    const p = ref.current.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      if (!active) { p[i * 3 + 1] = -100; continue; }
      if (Math.random() < 0.2 || p[i * 3 + 1] < 0.1) {
        p[i * 3] = position.x; p[i * 3 + 1] = position.y; p[i * 3 + 2] = position.z;
        vel[i].set((Math.random() - 0.5) * 15, Math.random() * 5 + 2, (Math.random() - 0.5) * 15);
      } else {
        vel[i].y -= 20 * delta;
        p[i * 3] += vel[i].x * delta; p[i * 3 + 1] += vel[i].y * delta; p[i * 3 + 2] += vel[i].z * delta;
      }
    }
    ref.current.geometry.attributes.position.needsUpdate = true;
    (ref.current.material as THREE.PointsMaterial).color.setHex(burr > 0.5 ? 0xff6a20 : 0xffaa00);
  });

  return (
    <points frustumCulled={false} ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={COUNT} array={particles} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.2} color="#ffaa00" transparent opacity={0.85} blending={THREE.AdditiveBlending} depthWrite={false} />
    </points>
  );
};

export const StampingPressModel = ({ motion }: MachineProps) => {
  const sliderRef = useRef<THREE.Group>(null);
  const workRef = useRef<THREE.MeshStandardMaterial>(null);
  const lubeRef = useRef<THREE.MeshStandardMaterial>(null);
  const phase = useRef(0);
  const ramRef = useRef(RAM_MAX_MM);
  const hittingRef = useRef(false);
  const sparkPos = useMemo(() => new THREE.Vector3(0, 1.2, 0), []);

  useFrame((_, delta) => {
    const t = motion.tags;
    const spm = t.stroke_rate || 60;
    const per = visualPeriod(60 / Math.max(1, spm), motion.timeScale);
    const locked = Math.abs(per.factor - 1) < 0.05 && typeof t.ram_position === "number";

    let ramMm: number;
    if (!motion.running) {
      ramMm = RAM_MAX_MM;                                   // 停機 → 滑塊停在上死點
      phase.current = 0;
    } else if (locked) {
      ramMm = t.ram_position;                               // L1:直接用引擎值
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      // 與引擎同一條參數式:ram = 60 - 60·cos(2π·phase)
      ramMm = 60 - 60 * Math.cos(phase.current * Math.PI * 2);
    }
    ramRef.current = ramMm;

    if (sliderRef.current) sliderRef.current.position.y = (ramMm / RAM_MAX_MM) * RAM_TRAVEL;
    hittingRef.current = motion.running && ramMm < 8;       // 下死點附近 = 正在沖壓

    // 毛邊率(die_wear)→ 工件外觀:越毛邊越暗、越紅(L2)
    if (workRef.current) {
      const burr = clamp01(motion.wear);
      workRef.current.color.setRGB(0.85 - 0.35 * burr, 0.64 - 0.34 * burr, 0.25 - 0.12 * burr);
      workRef.current.roughness = 0.35 + 0.6 * burr;
      workRef.current.emissiveIntensity = hittingRef.current ? 1 : 0;
    }
    // 潤滑壓力(lube_pump_wear)→ 警示燈:< 2.0 bar 亮黃
    if (lubeRef.current) {
      const lube = t.lubrication_pressure ?? 3;
      lubeRef.current.color.set(lube < 2.0 ? FX.warn : FX.ok);
      lubeRef.current.emissive.set(lube < 2.0 ? FX.warn : FX.ok);
      lubeRef.current.emissiveIntensity = lube < 2.0 ? 2 : 0.8;
    }
  });

  const body = bodyColor(motion);

  return (
    <Shake motion={motion}>
      <group position={[0, -1, 0]}>
        <Box args={[6, 1, 4]} position={[0, 0.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#445555" metalness={0.7} />
        </Box>
        <Box args={[4, 0.5, 3]} position={[0, 1, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#333333" metalness={0.8} />
        </Box>

        <Box args={[1.5, 8, 3]} position={[-2.25, 5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} />
        </Box>
        <Box args={[1.5, 8, 3]} position={[2.25, 5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} />
        </Box>
        <Box args={[6, 2, 4]} position={[0, 9.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#445555" metalness={0.5} />
        </Box>

        <group ref={sliderRef} position={[0, RAM_TRAVEL, 0]}>
          <Box args={[3, 2, 2.5]} position={[0, 3.5, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#889999" />
          </Box>
          <Box args={[2.5, 0.5, 2]} position={[0, 2.25, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#444444" metalness={0.8} />
          </Box>
          {/* 驗證探針:上模面 —— 世界高度應與 ram_position 呈固定線性關係 */}
          <object3D name="probe:ram" position={[0, 2.0, 0]} />
        </group>

        <Box args={[2.5, 0.5, 2]} position={[0, 1.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#444444" metalness={0.8} />
        </Box>
        <HeatGlow motion={motion} position={[0, 1.6, 0]} radius={1.8} />

        {/* 工件:外觀吃 burr_rate */}
        <Box args={[1.5, 0.1, 1.2]} position={[0, 1.8, 0]} castShadow receiveShadow>
          <meshStandardMaterial ref={workRef} color="#d9a441" emissive="#ffaa00" emissiveIntensity={0} />
        </Box>

        <Sparks active={hittingRef.current} position={sparkPos} burr={clamp01(motion.wear)} />

        {/* 潤滑壓力警示燈 */}
        <mesh position={[-2.25, 7.4, 1.55]}>
          <circleGeometry args={[0.22, 20]} />
          <meshStandardMaterial ref={lubeRef} color={FX.ok} emissive={FX.ok} emissiveIntensity={0.8} toneMapped={false} />
        </mesh>

        <StatusBeacon motion={motion} position={[2.25, 9.5, 1.2]} scale={1.5} />
        <FaultSmoke motion={motion} position={[0, 11, 0]} scale={1.4} />
        <StatusText motion={motion} position={[0, 8.4, 2.1]} size={0.35} />
      </group>
    </Shake>
  );
};

export default function StampingPress3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(60 / Math.max(1, motion.tags.stroke_rate || 60), motion.timeScale);
  return (
    <MachineScene camera={[0, 8, 16]} fov={40} target={[0, 4, 0]} shadowScale={30} note={scaleNote(per)}
                  overlay={<PressReadout motion={motion} />}>
      <StampingPressModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function PressReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["RAM", `${(t.ram_position ?? 0).toFixed(0)} mm`],
    ["TONNAGE", `${(t.tonnage ?? 0).toFixed(0)} ton`],
    ["RATE", `${(t.stroke_rate ?? 0).toFixed(0)} spm`],
    ["STROKES", `${Math.round(t.stroke_count ?? 0)}`],
    ["DIE TEMP", `${(t.die_temp ?? 0).toFixed(1)} °C`, (t.die_temp ?? 0) > 78],
    ["CURRENT", `${(t.motor_current ?? 0).toFixed(1)} A`, (t.motor_current ?? 0) > 40],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["BURR", `${(t.burr_rate ?? 0).toFixed(2)} %`, (t.burr_rate ?? 0) > 5],
    ["LUBE", `${(t.lubrication_pressure ?? 0).toFixed(2)} bar`, (t.lubrication_pressure ?? 3) < 2],
  ];
  const hint = (t.burr_rate ?? 0) > 5 ? "⚠ 毛邊率上升 → die_wear(良率題,設備不會 fault)"
    : (t.lubrication_pressure ?? 3) < 2 ? "⚠ 潤滑壓力偏低 → lube_pump_wear"
    : clamp01(motion.severity) > 0.5 ? "⚠ 振動 + 噸位波動 → clutch_brake_wear" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
