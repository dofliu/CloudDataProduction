/**
 * 熱處理爐 3D(綁定表見 docs/animation_binding.md §4.11)。新增機種。
 *
 * 三條線都畫得出來:
 *   · heating_element_aging → element_current 升、furnace_temp 到不了 900 °C 設定點
 *     → 爐膛火光「該亮沒亮那麼亮」,面板同時顯示設定點與實測,差距一目了然。
 *   · insulation_degradation → temp_uniformity 變大 → 爐膛內色塊不均(熱斑)。
 *   · seal_leak → oxygen_ppm 升 → 殘氧警示燈與數值轉紅。
 */
import React, { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { CanvasLabel, FX, FaultSmoke, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01, scaleNote } from "./deviceMotion";

const SETPOINT_C = 900;      // 引擎 SETPOINT_C
const O2_WARN = 100;         // 殘氧警戒(ppm)

/** 爐溫 → 火光顏色:600 °C 暗紅 → 900 °C 亮橘白(黑體概念的粗略近似)。 */
function glowColor(tempC: number) {
  const u = clamp01((tempC - 500) / (SETPOINT_C - 500));
  return new THREE.Color(0.55 + 0.45 * u, 0.12 + 0.62 * u, 0.02 + 0.42 * u * u);
}

/** 爐膛內的熱斑:色塊亮度差距 = temp_uniformity(爐內溫差,越大越不均)。 */
const HotSpots = ({ motion }: { motion: DeviceMotion }) => {
  const refs = useMemo(() => Array.from({ length: 6 }, () => React.createRef<THREE.Mesh>()), []);
  useFrame((st) => {
    const t = motion.tags;
    const temp = t.furnace_temp ?? 30;
    const uni = clamp01(((t.temp_uniformity ?? 4) - 4) / 35);     // 4→39 °C
    const base = glowColor(temp);
    refs.forEach((r, i) => {
      if (!r.current) return;
      const mat = r.current.material as THREE.MeshBasicMaterial;
      // 均勻時六塊一樣亮;不均時各塊被推開
      const bias = uni * Math.sin(i * 2.1 + st.clock.elapsedTime * 0.7) * 0.55;
      mat.color.copy(base).multiplyScalar(Math.max(0.15, 1 + bias));
      mat.opacity = clamp01((temp - 300) / 600) * 0.9;
    });
  });
  return (
    <>
      {refs.map((r, i) => (
        <mesh key={i} ref={r} position={[-1.0 + (i % 3) * 1.0, 2.0 + Math.floor(i / 3) * 0.85, 1.88]}>
          <planeGeometry args={[0.92, 0.78]} />
          <meshBasicMaterial color="#ff6a20" transparent opacity={0} toneMapped={false} depthWrite={false} />
        </mesh>
      ))}
    </>
  );
};

/** 保護氣氛流線:粒子速度 / 密度 = atmosphere_flow(L/min)。 */
const Atmosphere = ({ flow, active }: { flow: number; active: boolean }) => {
  const COUNT = 30;
  const positions = useMemo(() => new Float32Array(COUNT * 3).fill(-999), []);
  const ref = useRef<THREE.Points>(null);
  useFrame((_, delta) => {
    const p = ref.current;
    if (!p) return;
    const arr = p.geometry.attributes.position.array as Float32Array;
    const live = active ? Math.round(COUNT * clamp01(flow / 40)) : 0;
    const speed = 0.8 + 1.4 * clamp01(flow / 40);
    for (let i = 0; i < COUNT; i++) {
      if (i >= live) { arr[i * 3 + 1] = -999; continue; }
      if (arr[i * 3 + 1] < -900 || arr[i * 3 + 1] > 3.2) {
        arr[i * 3] = (Math.random() - 0.5) * 1.8;
        arr[i * 3 + 1] = 0.4;
        arr[i * 3 + 2] = (Math.random() - 0.5) * 1.4;
      } else {
        arr[i * 3 + 1] += speed * delta;
      }
    }
    p.geometry.attributes.position.needsUpdate = true;
  });
  return (
    <points frustumCulled={false} ref={ref} position={[0, 2.0, 0]}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={COUNT} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.1} color="#cfe3ea" transparent opacity={0.4} depthWrite={false} />
    </points>
  );
};

export const HeatTreatFurnaceModel = ({ motion }: MachineProps) => {
  const doorGlowRef = useRef<THREE.Mesh>(null);
  const powerBarRef = useRef<THREE.Mesh>(null);
  const o2Ref = useRef<THREE.MeshStandardMaterial>(null);
  const coilRefs = useMemo(() => Array.from({ length: 4 }, () => React.createRef<THREE.Mesh>()), []);

  useFrame((st, delta) => {
    const t = motion.tags;
    const temp = t.furnace_temp ?? 30;
    const col = glowColor(temp);

    if (doorGlowRef.current) {
      const mat = doorGlowRef.current.material as THREE.MeshBasicMaterial;
      mat.color.copy(col);
      mat.opacity = clamp01((temp - 200) / 700) * (0.55 + 0.08 * Math.sin(st.clock.elapsedTime * 2.4));
    }
    // 加熱元件:電流越高越亮(element_current 120→160 A 就是老化的主指標)
    const ec = clamp01(((t.element_current ?? 0) - 110) / 60);
    coilRefs.forEach((r, i) => {
      if (!r.current) return;
      const mat = r.current.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = motion.running ? (0.6 + 1.8 * ec) * (0.9 + 0.1 * Math.sin(st.clock.elapsedTime * 4 + i)) : 0.05;
    });
    // 加熱功率條
    if (powerBarRef.current) {
      const target = Math.max(0.02, clamp01(((t.heating_power ?? 0) - 50) / 50)) * 2.4;
      powerBarRef.current.scale.x += (target - powerBarRef.current.scale.x) * (1 - Math.exp(-delta / 0.3));
      powerBarRef.current.position.x = -1.2 + powerBarRef.current.scale.x / 2;
    }
    // 殘氧警示
    if (o2Ref.current) {
      const o2 = t.oxygen_ppm ?? 0;
      const c = o2 > O2_WARN * 1.5 ? FX.fault : o2 > O2_WARN ? FX.warn : FX.ok;
      o2Ref.current.color.set(c); o2Ref.current.emissive.set(c);
      o2Ref.current.emissiveIntensity = o2 > O2_WARN ? 2.2 : 0.9;
    }
  });

  const shell = bodyColor(motion, "#9aa0a4");

  return (
    <Shake motion={motion} amount={0.4}>
      <group position={[0, -1, 0]}>
        <Box args={[7, 0.6, 4.4]} position={[0, 0.3, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#4d5457" metalness={0.5} />
        </Box>

        {/* 爐體外殼 */}
        <Box args={[5, 4.4, 3.6]} position={[0, 2.8, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={shell} metalness={0.35} roughness={0.7} />
        </Box>
        {/* 耐火磚爐口框(中間留空,火光才看得到) */}
        {[[0, 1.55, 3.6, 0.5], [0, -1.55, 3.6, 0.5], [-1.55, 0, 0.5, 3.6], [1.55, 0, 0.5, 3.6]].map((f, i) => (
          <Box key={i} args={[f[2], f[3], 0.3]} position={[f[0], 2.4 + f[1], 1.81]} castShadow>
            <meshStandardMaterial color="#7d6a55" roughness={0.95} />
          </Box>
        ))}
        {/* 爐膛(暗底,火光疊在上面) */}
        <mesh position={[0, 2.4, 1.7]}>
          <planeGeometry args={[3.1, 3.1]} />
          <meshStandardMaterial color="#1a1008" roughness={1} />
        </mesh>
        <HotSpots motion={motion} />
        {/* 爐膛整體火光 */}
        <mesh ref={doorGlowRef} position={[0, 2.4, 1.95]}>
          <planeGeometry args={[3.1, 3.1]} />
          <meshBasicMaterial color="#ff6a20" transparent opacity={0} toneMapped={false}
                             blending={THREE.AdditiveBlending} depthWrite={false} />
        </mesh>

        {/* 加熱元件(爐膛內四支電熱棒;亮度綁 element_current) */}
        {coilRefs.map((r, i) => (
          <Cylinder key={i} ref={r} args={[0.08, 0.08, 2.9, 12]}
                    position={[-1.2 + i * 0.8, 2.4, 1.78]}>
            <meshStandardMaterial color="#ff8a3a" emissive="#ff8a3a" emissiveIntensity={0} toneMapped={false} />
          </Cylinder>
        ))}

        <Atmosphere flow={motion.tags.atmosphere_flow ?? 0} active={motion.running} />

        {/* 煙囪 / 排氣 */}
        <Cylinder args={[0.32, 0.32, 2.2, 16]} position={[1.7, 6.1, -1.0]} castShadow receiveShadow>
          <meshStandardMaterial color="#6f7679" metalness={0.6} />
        </Cylinder>

        {/* 控制盤:加熱功率條 + 殘氧燈 */}
        <group position={[3.2, 3.2, 1.0]} rotation={[0, -Math.PI / 6, 0]}>
          <Box args={[2.8, 2.0, 0.2]} castShadow receiveShadow>
            <meshStandardMaterial color="#3b4245" metalness={0.4} />
          </Box>
          <CanvasLabel text="HEATING POWER" position={[-0.55, 0.62, 0.12]} height={0.2} color="#cfd8dc" bg="none" />
          <Box args={[2.5, 0.16, 0.02]} position={[0, 0.32, 0.12]}>
            <meshStandardMaterial color="#20272a" />
          </Box>
          <mesh ref={powerBarRef} position={[-1.2, 0.32, 0.14]}>
            <boxGeometry args={[1, 0.16, 0.03]} />
            <meshStandardMaterial color={FX.hot} emissive={FX.hot} emissiveIntensity={1.3} toneMapped={false} />
          </mesh>
          <CanvasLabel text="O₂ RESIDUAL" position={[-0.66, -0.06, 0.12]} height={0.2} color="#cfd8dc" bg="none" />
          <mesh position={[0.95, -0.06, 0.14]}>
            <circleGeometry args={[0.14, 18]} />
            <meshStandardMaterial ref={o2Ref} color={FX.ok} emissive={FX.ok} emissiveIntensity={0.9} toneMapped={false} />
          </mesh>
          <CanvasLabel text={`${(motion.tags.furnace_temp ?? 0).toFixed(0)} / ${SETPOINT_C} °C`}
                       position={[-0.55, -0.52, 0.12]} height={0.24} color="#ffd9a0" bg="none" />
        </group>

        <StatusBeacon motion={motion} position={[-2.6, 5.0, 1.2]} scale={1.4} />
        <FaultSmoke motion={motion} position={[1.7, 7.2, -1.0]} scale={1.4} />
        <StatusText motion={motion} position={[0, 5.6, 0]} size={0.34} />
      </group>
    </Shake>
  );
};

export default function HeatTreatFurnace3D({ motion }: MachineProps) {
  return (
    <MachineScene camera={[9, 7, 13]} fov={45} target={[0, 2.6, 0]} env="warehouse"
                  ground="#cfc6b6" shadowScale={24} note={scaleNote()}
                  overlay={<FurnaceReadout motion={motion} />}>
      <HeatTreatFurnaceModel motion={motion} />
    </MachineScene>
  );
}

function FurnaceReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const shortfall = SETPOINT_C - (t.furnace_temp ?? 0);
  const rows: Row[] = [
    ["FURNACE T", `${(t.furnace_temp ?? 0).toFixed(0)} °C`, motion.running && shortfall > 25],
    ["SETPOINT", `${SETPOINT_C} °C`],
    ["UNIFORMITY", `${(t.temp_uniformity ?? 0).toFixed(1)} °C`, (t.temp_uniformity ?? 0) > 15],
    ["HEAT POWER", `${(t.heating_power ?? 0).toFixed(1)} kW`, (t.heating_power ?? 0) > 80],
    ["ELEM CURR", `${(t.element_current ?? 0).toFixed(1)} A`, (t.element_current ?? 0) > 140],
    ["ATM FLOW", `${(t.atmosphere_flow ?? 0).toFixed(1)} L/min`],
    ["O₂", `${(t.oxygen_ppm ?? 0).toFixed(0)} ppm`, (t.oxygen_ppm ?? 0) > O2_WARN],
    ["ENERGY", `${Math.round(t.energy_kwh ?? 0)} kWh`],
  ];
  const hint = motion.running && shortfall > 25 ? "⚠ 到不了設定點 + 元件電流升 → heating_element_aging"
    : (t.oxygen_ppm ?? 0) > O2_WARN ? "⚠ 殘氧偏高 → seal_leak(良率題)"
    : (t.temp_uniformity ?? 0) > 15 ? "⚠ 爐內溫差變大 → insulation_degradation" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
