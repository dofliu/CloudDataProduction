/**
 * 半導體製程腔體 3D(綁定表見 docs/animation_binding.md §4.10)。新增機種。
 *
 * 這台的教學重點是 subtle fault:process_drift 只推高 particle_count(良率殺手),
 * 沒有任何訊號會「跳警報」。所以腔內飄浮微粒的數量與顏色直接綁 particle_count ——
 * 學生用眼睛就能發現「這台沒壞,但髒了」,再回頭用資料證實。
 *
 * 另一條是 vacuum_pump_wear:泵電流升 + 腔壓抽不到底,兩者一起看才成立。
 */
import React, { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FaultSmoke, HeatGlow, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01, scaleNote, visualPeriod, visualSpin } from "./deviceMotion";

const RF_NOM = 1500;                 // 引擎 RF_NOM
const GAS_NOM = [50, 30, 15];        // 引擎 GAS_SETPOINTS
const PARTICLE_MAX = 70;             // 引擎 process_drift 全劣化時的增量
const PUMP_RPM = 900;                // 泵浦機構常數(引擎未發此 tag)

/** 腔內飄浮微粒:數量 = particle_count(L1 計數 → L2 視覺密度)。 */
const Particles = ({ count, active }: { count: number; active: boolean }) => {
  const MAX = 90;
  const positions = useMemo(() => {
    const a = new Float32Array(MAX * 3);
    for (let i = 0; i < MAX; i++) {
      a[i * 3] = (Math.random() - 0.5) * 2.4;
      a[i * 3 + 1] = Math.random() * 1.4;
      a[i * 3 + 2] = (Math.random() - 0.5) * 2.4;
    }
    return a;
  }, []);
  const ref = useRef<THREE.Points>(null);

  useFrame((st, delta) => {
    const p = ref.current;
    if (!p) return;
    const arr = p.geometry.attributes.position.array as Float32Array;
    const live = active ? Math.min(MAX, Math.round(count)) : 0;
    for (let i = 0; i < MAX; i++) {
      if (i >= live) { arr[i * 3 + 1] = -999; continue; }
      if (arr[i * 3 + 1] < -900) arr[i * 3 + 1] = Math.random() * 1.4;
      arr[i * 3 + 1] += Math.sin(st.clock.elapsedTime * 0.8 + i) * 0.12 * delta;
      arr[i * 3] += Math.cos(st.clock.elapsedTime * 0.6 + i * 1.7) * 0.15 * delta;
    }
    p.geometry.attributes.position.needsUpdate = true;
    const mat = p.material as THREE.PointsMaterial;
    const dirty = clamp01(count / PARTICLE_MAX);
    mat.color.setRGB(0.85, 0.85 - 0.55 * dirty, 0.9 - 0.7 * dirty);   // 乾淨=淡藍白,髒=偏黃
    mat.size = 0.05 + 0.05 * dirty;
  });

  return (
    <points frustumCulled={false} ref={ref} position={[0, 2.4, 0]}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={MAX} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.06} color="#d8e8ff" transparent opacity={0.85} depthWrite={false} />
    </points>
  );
};

/** 三路 MFC 氣體流線:線寬 / 亮度 = 各路 gas_flow(sccm)。 */
const GasLines = ({ motion }: { motion: DeviceMotion }) => {
  const refs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  useFrame((st) => {
    refs.forEach((r, i) => {
      if (!r.current) return;
      const f = motion.tags[`gas_flow_${i + 1}`] ?? 0;
      const ratio = clamp01(f / GAS_NOM[i]);
      const mat = r.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = ratio * (1.1 + 0.35 * Math.sin(st.clock.elapsedTime * 5 + i));
      r.current.scale.set(0.4 + ratio, 1, 0.4 + ratio);
    });
  });
  return (
    <>
      {[0, 1, 2].map((i) => (
        <Cylinder key={i} ref={refs[i]} args={[0.09, 0.09, 2.2, 12]} rotation={[0, 0, Math.PI / 2]}
                  position={[-2.6, 3.2 - i * 0.42, 0]}>
          <meshStandardMaterial color="#7fc6d8" emissive="#7fc6d8" emissiveIntensity={0} toneMapped={false} />
        </Cylinder>
      ))}
    </>
  );
};

export const ProcessChamberModel = ({ motion }: MachineProps) => {
  const plasmaRef = useRef<THREE.Mesh>(null);
  const pumpRef = useRef<THREE.Group>(null);
  const waferRef = useRef<THREE.Group>(null);
  const spin = useRef(0);
  const waferPhase = useRef(0);

  useFrame((st, delta) => {
    const t = motion.tags;
    // 電漿輝光:強度 = rf_power / RF_NOM(L2)
    if (plasmaRef.current) {
      const mat = plasmaRef.current.material as THREE.MeshBasicMaterial;
      const rf = clamp01((t.rf_power ?? 0) / RF_NOM);
      mat.opacity = rf * (0.32 + 0.1 * Math.sin(st.clock.elapsedTime * 6));
      plasmaRef.current.scale.setScalar(0.9 + 0.1 * rf);
    }
    // 真空泵:轉動(L3 降頻)
    if (pumpRef.current && motion.running) {
      spin.current += visualSpin(PUMP_RPM, motion.timeScale).value * delta;
      pumpRef.current.rotation.y = spin.current * Math.PI * 2;
    }
    // 晶圓搬運節拍 = throughput(wph)
    const wph = t.throughput ?? 0;
    if (waferRef.current) {
      if (motion.running && wph > 0.1) {
        const per = visualPeriod(3600 / wph, motion.timeScale);
        waferPhase.current = (waferPhase.current + delta / per.value) % 1;
        const u = waferPhase.current;
        // 0~0.25 進片 / 0.25~0.75 製程中 / 0.75~1 出片
        const x = u < 0.25 ? -3.4 + (u / 0.25) * 3.4 : u < 0.75 ? 0 : (u - 0.75) / 0.25 * 3.4;
        waferRef.current.position.x = x;
        waferRef.current.visible = true;
      } else {
        waferRef.current.visible = false;
      }
    }
  });

  const body = bodyColor(motion, "#b8c0c4");

  return (
    <Shake motion={motion} amount={0.6}>
      <group position={[0, -1, 0]}>
        {/* 機台底座 */}
        <Box args={[7, 1.6, 5]} position={[0, 0.8, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#5a6468" metalness={0.6} roughness={0.5} />
        </Box>

        {/*
          腔體本體(圓筒)。刻意做成半透明「剖視」—— 這台的教學重點(電漿強度、腔內微粒)
          全在腔內,做成不透明就等於什麼都看不到。用透明度換可讀性,幾何仍是真的。
        */}
        <Cylinder args={[1.8, 1.8, 2.2, 32]} position={[0, 2.7, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.65} roughness={0.3}
                                transparent opacity={0.34} depthWrite={false} side={THREE.DoubleSide} />
        </Cylinder>
        {/* 腔體法蘭(不透明,維持金屬量體感) */}
        {[1.62, 3.78].map((y, i) => (
          <Cylinder key={i} args={[1.92, 1.92, 0.16, 32]} position={[0, y, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={body} metalness={0.8} roughness={0.25} />
          </Cylinder>
        ))}
        {/* 觀察窗 */}
        <Cylinder args={[0.55, 0.55, 0.08, 24]} rotation={[Math.PI / 2, 0, 0]} position={[0, 2.9, 1.82]}>
          <meshStandardMaterial color="#1c2630" metalness={0.4} roughness={0.1} transparent opacity={0.6} />
        </Cylinder>
        {/* 上蓋 / RF 匹配箱 */}
        <Cylinder args={[2.0, 2.0, 0.35, 32]} position={[0, 3.95, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#8f9a9e" metalness={0.8} />
        </Cylinder>
        <Box args={[1.4, 0.9, 1.4]} position={[0, 4.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#6f7a80" />
        </Box>

        {/* 電漿輝光 */}
        <mesh ref={plasmaRef} position={[0, 2.6, 0]}>
          <sphereGeometry args={[1.5, 20, 16]} />
          <meshBasicMaterial color="#9c6bce" transparent opacity={0} depthWrite={false}
                             blending={THREE.AdditiveBlending} toneMapped={false} />
        </mesh>

        {/* 晶圓座 + 搬運中的晶圓 */}
        <Cylinder args={[1.2, 1.2, 0.14, 28]} position={[0, 1.85, 0]}>
          <meshStandardMaterial color="#3b4348" metalness={0.7} />
        </Cylinder>
        <group ref={waferRef} position={[0, 2.02, 0]} visible={false}>
          <Cylinder args={[0.95, 0.95, 0.05, 28]}>
            <meshStandardMaterial color="#cfd8dc" metalness={0.9} roughness={0.15} />
          </Cylinder>
        </group>

        <Particles count={motion.tags.particle_count ?? 0} active={motion.running} />
        <GasLines motion={motion} />

        {/* 三支 MFC */}
        {[0, 1, 2].map((i) => (
          <Box key={i} args={[0.5, 0.34, 0.5]} position={[-4.0, 3.2 - i * 0.42, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#8f9a9e" metalness={0.6} />
          </Box>
        ))}

        {/* 真空泵(轉動 + 發熱) */}
        <group position={[3.0, 1.9, 0]}>
          <Cylinder args={[0.9, 0.9, 1.4, 24]} castShadow receiveShadow>
            <meshStandardMaterial color="#6f7a80" metalness={0.7} />
          </Cylinder>
          <group ref={pumpRef} position={[0, 0.75, 0]}>
            {[0, 1, 2, 3].map((i) => (
              <Box key={i} args={[1.5, 0.06, 0.28]} rotation={[0, (i * Math.PI) / 4, 0]}>
                <meshStandardMaterial color="#444444" />
              </Box>
            ))}
          </group>
          <HeatGlow motion={motion} radius={1.1} />
        </group>
        {/* 抽氣管 */}
        <Cylinder args={[0.28, 0.28, 1.5, 16]} rotation={[0, 0, Math.PI / 2]} position={[2.1, 2.2, 0]}>
          <meshStandardMaterial color="#8f9a9e" metalness={0.7} />
        </Cylinder>

        <StatusBeacon motion={motion} position={[-2.6, 3.4, -1.6]} scale={1.3} />
        <FaultSmoke motion={motion} position={[3.0, 3.0, 0]} />
        <StatusText motion={motion} position={[0, 5.4, 0]} size={0.34} />
      </group>
    </Shake>
  );
};

export default function ProcessChamber3D({ motion }: MachineProps) {
  const wph = motion.tags.throughput ?? 0;
  const per = wph > 0.1 ? visualPeriod(3600 / wph, motion.timeScale) : undefined;
  const spin = visualSpin(PUMP_RPM, motion.timeScale);
  return (
    <MachineScene camera={[8, 7, 12]} fov={45} target={[0, 2.4, 0]} env="city"
                  ground="#d8d4cc" shadowScale={22} note={scaleNote(per, spin)}
                  overlay={<ChamberReadout motion={motion} />}>
      <ProcessChamberModel motion={motion} />
    </MachineScene>
  );
}

function ChamberReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const dirty = (t.particle_count ?? 0) > 20;
  const pumpBad = (t.vacuum_pump_current ?? 0) > 10 && (t.chamber_pressure ?? 0) > 65;
  const rows: Row[] = [
    ["RF POWER", `${(t.rf_power ?? 0).toFixed(0)} W`],
    ["PRESSURE", `${(t.chamber_pressure ?? 0).toFixed(1)} mTorr`, (t.chamber_pressure ?? 0) > 65],
    ["CHAMBER T", `${(t.chamber_temp ?? 0).toFixed(1)} °C`],
    ["GAS 1/2/3", `${(t.gas_flow_1 ?? 0).toFixed(1)}/${(t.gas_flow_2 ?? 0).toFixed(1)}/${(t.gas_flow_3 ?? 0).toFixed(1)}`, (t.gas_flow_1 ?? 50) > 56],
    ["PUMP CURR", `${(t.vacuum_pump_current ?? 0).toFixed(2)} A`, (t.vacuum_pump_current ?? 0) > 10],
    ["PUMP TEMP", `${(t.pump_temp ?? 0).toFixed(1)} °C`, (t.pump_temp ?? 0) > 72],
    ["PARTICLES", `${(t.particle_count ?? 0).toFixed(1)} /wafer`, dirty],
    ["THROUGHPUT", `${(t.throughput ?? 0).toFixed(1)} wph`],
    ["WAFERS", `${Math.round(t.wafer_count ?? 0)}`],
  ];
  const hint = dirty ? "⚠ 微粒偏高 → process_drift(設備不會 fault,良率會掉)"
    : pumpBad ? "⚠ 泵電流升 + 基壓抽不到底 → vacuum_pump_wear" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
