/**
 * 熔煉爐 3D(綁定表見 docs/animation_binding.md §4.18)。
 *
 * 會動的部位只有兩個,兩個都直接吃引擎的 tag(L1):
 *   · 爐體傾轉 = tilt_angle(deg,0 直立 / -45 出湯中)—— 出湯那一下就是這台的「動作」。
 *   · 熔湯液面高度 = bath_level(%,0..100)。
 * 顏色與輝光是 L2:melt_temp 越高越白熾、shell_temp 越高爐殼越紅(爐襯薄的視覺線索)。
 *
 * 節拍 72 s(一籃)在 ×120 下低於可視極限 —— 與沖壓機同款:倍率 ≈1 時 L1 鎖定,
 * 否則本地跑同一條參數式慢放並標倍率(L3)。
 *
 * 三條退化線的畫面表現:
 *   · refractory_wear → shell_temp ↑ → 爐殼由灰轉暗紅(這是「爐襯該換了」的現場徵候)
 *   · electrode_wear  → electrode_current 震盪 → 電極輝光閃爍
 *   · slag_buildup    → slag_ratio ↑ → 熔湯表面浮渣變厚變暗
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FaultSmoke, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approach, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const MELT_CYCLE_S = 72.0;      // 引擎額定出湯節拍
const TAP_FRAC = 0.88;          // 相位 >= 此值進入出湯段(與引擎同一常數)
const TILT_MAX_DEG = 45;
const BATH_Y0 = 1.15;           // 液面最低高度(模型單位)
const BATH_H = 1.5;             // 滿池時的液面上升量

/** 與引擎 drv_tilt 同一條式子:相位 → 傾轉角(deg)。 */
function tiltOf(ph: number): number {
  if (ph < TAP_FRAC) return 0;
  const u = (ph - TAP_FRAC) / (1 - TAP_FRAC);
  return -TILT_MAX_DEG * Math.sin(u * Math.PI);
}
/** 與引擎 drv_bath_level 同一條式子:相位 → 液位(%)。 */
function bathOf(ph: number): number {
  if (ph < TAP_FRAC) return 55 + 40 * (ph / TAP_FRAC);
  const u = (ph - TAP_FRAC) / (1 - TAP_FRAC);
  return Math.max(0, 95 * (1 - u));
}

export const MeltingFurnaceModel = ({ motion }: MachineProps) => {
  const tiltRef = useRef<THREE.Group>(null);
  const bathRef = useRef<THREE.Mesh>(null);
  const bathMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const slagRef = useRef<THREE.MeshStandardMaterial>(null);
  const shellMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const electrodeMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const streamRef = useRef<THREE.Mesh>(null);
  const phase = useRef(0);
  const tilt = useRef(0);
  const level = useRef(55);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.melt_cycle_time || MELT_CYCLE_S, motion.timeScale);
    const locked = Math.abs(per.factor - 1) < 0.05 && typeof t.tilt_angle === "number";

    let tiltDeg: number, bath: number;
    if (!motion.running) {
      tiltDeg = 0; bath = 0; phase.current = 0;
    } else if (locked) {
      tiltDeg = t.tilt_angle; bath = t.bath_level ?? 0;        // L1:直接用引擎值
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      tiltDeg = tiltOf(phase.current);                          // L3:同一條參數式慢放
      bath = bathOf(phase.current);
    }
    tilt.current = approach(tilt.current, tiltDeg, 0.12, delta, 0.2);
    level.current = approach(level.current, bath, 0.5, delta, 0.25);
    if (tiltRef.current) tiltRef.current.rotation.z = (tilt.current * Math.PI) / 180;
    if (bathRef.current) {
      const h = clamp01(level.current / 100);
      bathRef.current.position.y = BATH_Y0 + BATH_H * h;
      bathRef.current.visible = h > 0.02;
    }

    // 熔湯亮度 = melt_temp(L2):1450 °C 白熾,冷下來轉暗橙
    if (bathMatRef.current) {
      const hot = clamp01(((t.melt_temp ?? 0) - 700) / 800);
      bathMatRef.current.emissiveIntensity = motion.running ? 0.6 + 3.4 * hot : 0.1;
      bathMatRef.current.color.setRGB(1, 0.45 + 0.4 * hot, 0.1 + 0.45 * hot);
    }
    // 浮渣厚度 / 顏色 = slag_ratio(L2)
    if (slagRef.current) {
      const slag = clamp01((t.slag_ratio ?? 0) / 8);
      slagRef.current.opacity = 0.15 + 0.75 * slag;
      slagRef.current.color.setRGB(0.35 - 0.2 * slag, 0.3 - 0.18 * slag, 0.28 - 0.16 * slag);
    }
    // 爐殼溫度 = shell_temp(L2):爐襯薄 → 外壁由灰轉暗紅
    if (shellMatRef.current) {
      const s = clamp01(((t.shell_temp ?? 30) - 90) / 160);
      shellMatRef.current.emissive.setRGB(0.55 * s, 0.12 * s, 0.03 * s);
      shellMatRef.current.emissiveIntensity = motion.running ? 0.2 + 1.6 * s : 0.05;
    }
    // 電極輝光跟著 electrode_current 震盪(電極磨耗 → 幅度變大)
    if (electrodeMatRef.current) {
      const i = clamp01(((t.electrode_current ?? 0) - 700) / 200);
      electrodeMatRef.current.emissiveIntensity = motion.running ? 0.4 + 3.0 * i : 0.05;
    }
    // 出湯流:傾轉超過 8° 才看得到湯流下來
    if (streamRef.current) {
      const pouring = Math.abs(tilt.current) > 8;
      streamRef.current.visible = motion.running && pouring;
      streamRef.current.scale.y = Math.min(1.6, Math.abs(tilt.current) / 28);
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={0.5}>
      <group>
        {/* 基座 + 傾轉軸座 */}
        <Box args={[7.4, 1.0, 5.2]} position={[0, 0.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.5} />
        </Box>
        {[-2.3, 2.3].map((x) => (
          <Box key={x} args={[0.7, 1.6, 1.2]} position={[x, 1.6, 0]} castShadow>
            <meshStandardMaterial color="#5a6a72" metalness={0.6} />
          </Box>
        ))}

        {/* 爐體(繞 Z 傾轉:tilt_angle L1) */}
        <group ref={tiltRef} position={[0, 2.4, 0]}>
          <Cylinder args={[2.0, 1.8, 2.9, 24]} castShadow receiveShadow>
            <meshStandardMaterial ref={shellMatRef} color="#6b6259" metalness={0.35}
                                  roughness={0.7} emissive="#000000" emissiveIntensity={0.05} />
          </Cylinder>
          {/* 爐口(上緣) */}
          <Cylinder args={[2.05, 2.05, 0.18, 24]} position={[0, 1.5, 0]} castShadow>
            <meshStandardMaterial color="#4a4a44" metalness={0.4} />
          </Cylinder>
          {/* 熔湯液面(bath_level L1 → 高度;melt_temp L2 → 亮度) */}
          <mesh ref={bathRef} position={[0, BATH_Y0, 0]}>
            <cylinderGeometry args={[1.72, 1.72, 0.12, 24]} />
            <meshStandardMaterial ref={bathMatRef} color="#ff9a3c" emissive="#ff7a1a"
                                  emissiveIntensity={1.6} toneMapped={false} />
          </mesh>
          {/* 浮渣(slag_ratio L2) */}
          <Cylinder args={[1.74, 1.74, 0.05, 24]} position={[0, BATH_Y0 + BATH_H * 0.55 + 0.1, 0]}>
            <meshStandardMaterial ref={slagRef} color="#3a332e" transparent opacity={0.2} />
          </Cylinder>
          {/* 電極(三支,輝光跟 electrode_current) */}
          {[-0.9, 0, 0.9].map((x) => (
            <Cylinder key={x} args={[0.16, 0.16, 3.4, 12]} position={[x, 2.3, 0]} castShadow>
              <meshStandardMaterial ref={x === 0 ? electrodeMatRef : undefined}
                                    color="#2b2b2b" emissive="#ff5a10"
                                    emissiveIntensity={0.4} toneMapped={false} />
            </Cylinder>
          ))}
          {/* 出湯嘴 */}
          <Box args={[1.0, 0.4, 0.9]} position={[-2.2, 1.0, 0]} rotation={[0, 0, -0.25]} castShadow>
            <meshStandardMaterial color="#6b6259" roughness={0.8} />
          </Box>
          {/* 驗證探針:爐口世界座標 ↔ tilt_angle(傾轉後位置會變) */}
          <object3D name="probe:furnace_lip" position={[-2.2, 1.0, 0]} />
        </group>

        {/* 出湯流 + 受湯包 */}
        <mesh ref={streamRef} position={[-3.4, 1.9, 0]}>
          <cylinderGeometry args={[0.16, 0.22, 1.6, 10]} />
          <meshStandardMaterial color="#ffb347" emissive="#ff7a1a" emissiveIntensity={3}
                                toneMapped={false} />
        </mesh>
        <Cylinder args={[0.95, 0.75, 1.3, 16]} position={[-3.4, 0.9, 0]} castShadow>
          <meshStandardMaterial color="#544c45" roughness={0.85} />
        </Cylinder>

        <StatusBeacon motion={motion} position={[3.2, 2.0, -2.0]} scale={1.2} />
        <FaultSmoke motion={motion} position={[0, 5.2, 0]} />
        <StatusText motion={motion} position={[0, 1.5, 2.7]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function MeltingFurnace3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(motion.tags.melt_cycle_time || MELT_CYCLE_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 6.5, 12]} fov={42} target={[0, 2.4, 0]} shadowScale={26}
                  note={scaleNote(per)} overlay={<MeltReadout motion={motion} />}>
      <MeltingFurnaceModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function MeltReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["MELT TEMP", `${(t.melt_temp ?? 0).toFixed(0)} °C`, (t.melt_temp ?? 1450) < 1380],
    ["SHELL", `${(t.shell_temp ?? 0).toFixed(0)} °C`, (t.shell_temp ?? 0) > 180],
    ["TILT", `${(t.tilt_angle ?? 0).toFixed(1)}°`],
    ["BATH", `${(t.bath_level ?? 0).toFixed(0)} %`],
    ["SLAG", `${(t.slag_ratio ?? 0).toFixed(2)} %`, (t.slag_ratio ?? 0) > 3],
    ["ELEC I", `${(t.electrode_current ?? 0).toFixed(0)} A`],
    ["POWER", `${(t.power_input ?? 0).toFixed(0)} kW`],
    ["TAPS", `${Math.round(t.tap_count ?? 0)}`],
  ];
  const hint = (t.shell_temp ?? 0) > 180
    ? "⚠ 爐殼外壁溫升 + 功率吃更多才維持得住爐溫 → refractory_wear(重砌爐襯)"
    : (t.slag_ratio ?? 0) > 3 ? "⚠ 含渣量升 → slag_buildup(清渣,不是換爐)"
    : clamp01(motion.severity) > 0.5 ? "⚠ 電極電流震盪變大 → electrode_wear" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
