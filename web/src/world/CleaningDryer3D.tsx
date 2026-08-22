/**
 * 清洗乾燥機 3D(綁定表見 docs/animation_binding.md §4.24)。
 *
 * 這是一台**連續網帶機**:噴淋區、風刀區、烘乾區同時都有工件在裡面。
 * 畫面因此不做「這段在洗、那段在烘」的相位切換 —— 三區的效果只看 running,
 * 與引擎的訊號語意完全一致(引擎那邊也拿掉了相位 gating)。
 *
 * 本站最值得教的一課是**反直覺的組合**:噴嘴堵 → 壓力「升」但流量掉。
 * 畫面把兩者分開表達 —— 壓力用噴桿的輝光(升),流量用噴霧錐的大小(掉),
 * 學生一眼就看得出「壓力升不代表洗得更用力」。
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, Shake, StatusBeacon, StatusText, WORKPIECE, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const CYCLE_S = 15.0;
const RESIDUE_SPEC = 2.0;
const BELT_LEN = 11.0;      // 網帶可見長度(模型單位)
const N_PARTS = 5;          // 帶上同時可見的工件數

export const CleaningDryerModel = ({ motion }: MachineProps) => {
  const partRefs = Array.from({ length: N_PARTS }, () => useRef<THREE.Mesh>(null));
  const partMats = Array.from({ length: N_PARTS }, () => useRef<THREE.MeshStandardMaterial>(null));
  const sprayRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const sprayMats = [useRef<THREE.MeshStandardMaterial>(null), useRef<THREE.MeshStandardMaterial>(null),
                     useRef<THREE.MeshStandardMaterial>(null)];
  const barMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const dryMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const steamRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const bathMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const phase = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.cycle_time || CYCLE_S, motion.timeScale);
    if (motion.running) phase.current = (phase.current + delta / per.value) % 1;

    // 網帶上的工件:等間距連續前進(L3 —— 一個節拍前進一格,倍率標在角落)
    partRefs.forEach((r, i) => {
      if (!r.current) return;
      r.current.visible = motion.running;
      const u = ((phase.current + i / N_PARTS) % 1);
      r.current.position.x = -BELT_LEN / 2 + u * BELT_LEN;
      // 工件殘留污染:越髒顏色越濁(residue_level L2)。出料端才看得出來洗乾淨沒有。
      const m = partMats[i].current;
      if (m) {
        const res = clamp01((t.residue_level ?? 0) / (RESIDUE_SPEC * 2));
        m.color.setRGB(0.23 + 0.30 * res, 0.54 - 0.22 * res, 0.23 - 0.06 * res);
        m.roughness = 0.3 + 0.55 * res;
      }
    });

    // 噴淋:壓力 → 噴桿輝光;流量 → 噴霧錐大小。兩者刻意分開(堵塞時一升一降)。
    const p = clamp01((t.spray_pressure ?? 0) / 5.5);
    const f = clamp01((t.spray_flow ?? 0) / 190);
    if (barMatRef.current) {
      barMatRef.current.emissive.setRGB(0.15 * p, 0.42 * p, 0.62 * p);
      barMatRef.current.emissiveIntensity = motion.running ? 0.1 + 2.2 * p : 0.02;
    }
    sprayRefs.forEach((r, i) => {
      if (!r.current) return;
      r.current.visible = motion.running && f > 0.05;
      r.current.scale.set(0.35 + 0.95 * f, 1, 0.35 + 0.95 * f);
      const m = sprayMats[i].current;
      if (m) m.opacity = 0.10 + 0.42 * f;
    });
    // 槽液髒污:導電度越高越濁(bath_conductivity L2 → 換液的視覺指標)
    if (bathMatRef.current) {
      const c = clamp01(((t.bath_conductivity ?? 0) - 320) / 2400);
      bathMatRef.current.color.setRGB(0.16 + 0.34 * c, 0.34 - 0.12 * c, 0.40 - 0.22 * c);
      bathMatRef.current.opacity = 0.55 + 0.35 * c;
    }
    // 烘乾區:溫度輝光 + 蒸氣(dry_temp L2 —— 加熱器老化 → 輝光變弱)
    const dry = clamp01(((t.dry_temp ?? 0) - 40) / 75);
    if (dryMatRef.current) {
      dryMatRef.current.emissive.setRGB(0.72 * dry, 0.26 * dry, 0.05 * dry);
      dryMatRef.current.emissiveIntensity = motion.running ? 0.08 + 1.9 * dry : 0.02;
    }
    steamRefs.forEach((r, i) => {
      if (!r.current) return;
      r.current.visible = motion.running && dry > 0.25;
      const k = ((performance.now() / 900 + i * 0.33) % 1);
      r.current.position.set(3.2 + i * 0.9, 3.1 + k * 2.0, 0);
      r.current.scale.setScalar(0.3 + 0.75 * k * dry);
      (r.current.material as THREE.MeshStandardMaterial).opacity = (1 - k) * 0.30 * dry;
    });
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={0.8}>
      <group>
        {/* 機殼:左段噴淋、中段風刀、右段烘乾 */}
        <Box args={[13.0, 0.8, 3.4]} position={[0, 0.4, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.5} />
        </Box>
        <Box args={[5.4, 2.8, 3.0]} position={[-3.6, 2.6, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#54636b" metalness={0.55} transparent opacity={0.28} />
        </Box>
        <Box args={[5.0, 2.8, 3.0]} position={[3.6, 2.6, 0]} castShadow receiveShadow>
          <meshStandardMaterial ref={dryMatRef} color="#5c5148" metalness={0.5}
                                emissive="#ff8a30" emissiveIntensity={0.08}
                                transparent opacity={0.30} />
        </Box>

        {/* 清洗槽(導電度 → 濁度) */}
        <Box args={[5.0, 0.7, 2.4]} position={[-3.6, 0.95, 0]}>
          <meshStandardMaterial ref={bathMatRef} color="#2a5766" transparent opacity={0.6}
                                metalness={0.1} roughness={0.35} />
        </Box>

        {/* 網帶 */}
        <Box args={[BELT_LEN + 1.0, 0.12, 2.2]} position={[0, 1.45, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#3f4a50" metalness={0.7} roughness={0.5} />
        </Box>
        {/* 帶上工件(連續前進) */}
        {partRefs.map((r, i) => (
          <mesh key={i} ref={r} position={[0, 1.75, 0]} castShadow>
            <boxGeometry args={[0.75, 0.26, 0.52]} />
            <meshStandardMaterial ref={partMats[i]} color={WORKPIECE} roughness={0.3} metalness={0.7} />
          </mesh>
        ))}

        {/* 噴桿(壓力 → 輝光)+ 噴霧錐(流量 → 大小) */}
        <Cylinder args={[0.13, 0.13, 4.6, 12]} rotation={[0, 0, Math.PI / 2]}
                  position={[-3.6, 3.5, 0]} castShadow>
          <meshStandardMaterial ref={barMatRef} color="#7f8c93" metalness={0.8}
                                emissive="#4aa8dd" emissiveIntensity={0.1} toneMapped={false} />
        </Cylinder>
        {sprayRefs.map((r, i) => (
          <mesh key={i} ref={r} position={[-5.2 + i * 1.6, 2.65, 0]}>
            <coneGeometry args={[0.62, 1.5, 12, 1, true]} />
            <meshStandardMaterial ref={sprayMats[i]} color="#bfe2f2" transparent opacity={0.3}
                                  side={THREE.DoubleSide} />
          </mesh>
        ))}
        {/* 驗證探針:出料端(工件離開烘乾區的位置) */}
        <object3D name="probe:belt_exit" position={[BELT_LEN / 2, 1.75, 0]} />

        {/* 蒸氣 */}
        {steamRefs.map((r, i) => (
          <mesh key={i} ref={r} position={[3.2 + i * 0.9, 3.1, 0]}>
            <sphereGeometry args={[0.5, 8, 7]} />
            <meshStandardMaterial color="#e8eef1" transparent opacity={0.22} />
          </mesh>
        ))}

        <StatusBeacon motion={motion} position={[-6.4, 2.4, -1.8]} scale={1.2} />
        <FaultSmoke motion={motion} position={[0, 4.6, 0]} />
        <StatusText motion={motion} position={[0, 0.9, 2.1]} size={0.32} />
      </group>
    </Shake>
  );
};

export default function CleaningDryer3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(motion.tags.cycle_time || CYCLE_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 6.0, 15]} fov={44} target={[0, 2.4, 0]} shadowScale={30}
                  note={scaleNote(per)} overlay={<WashReadout motion={motion} />}>
      <CleaningDryerModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function WashReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["BATH T", `${(t.bath_temp ?? 0).toFixed(0)} °C`],
    ["COND", `${(t.bath_conductivity ?? 0).toFixed(0)} µS/cm`, (t.bath_conductivity ?? 0) > 1600],
    ["SPRAY P", `${(t.spray_pressure ?? 0).toFixed(2)} bar`, (t.spray_pressure ?? 0) > 4.2],
    ["SPRAY Q", `${(t.spray_flow ?? 0).toFixed(0)} L/min`, (t.spray_flow ?? 180) < 120],
    ["DRY T", `${(t.dry_temp ?? 0).toFixed(0)} °C`, (t.dry_temp ?? 105) < 92],
    ["RESIDUE", `${(t.residue_level ?? 0).toFixed(2)} mg/m²`, (t.residue_level ?? 0) > RESIDUE_SPEC],
    ["MOISTURE", `${(t.moisture_ppm ?? 0).toFixed(0)} ppm`, (t.moisture_ppm ?? 0) > 260],
    ["PUMP I", `${(t.pump_current ?? 0).toFixed(1)} A`],
    ["CYCLE", `${(t.cycle_time ?? 0).toFixed(1)} s`],
    ["TRANSIT", `${(t.transit_time ?? 0).toFixed(0)} s`],
    ["WASHED", `${Math.round(t.washed_count ?? 0)}`],
  ];
  const hiP = (t.spray_pressure ?? 0) > 4.2, loQ = (t.spray_flow ?? 180) < 120;
  const hint = hiP && loQ
    ? "⚠ 噴淋壓力升**但**流量掉 → nozzle_clog(噴嘴堵,出口變小才讓壓力升;清噴嘴)"
    : (t.bath_conductivity ?? 0) > 1600 ? "⚠ 導電度爬升 + 殘留污染升 → bath_contamination(換清洗液)"
    : (t.dry_temp ?? 105) < 92 ? "⚠ 烘乾溫度到不了設定值 + 殘留水分升 → heater_aging(換加熱器)"
    : (t.vibration_rms ?? 0) > 4.0 ? "⚠ 泵振動升 → pump_bearing_wear(這條會走到 fault)"
    : "本站洗不乾淨,不良要到電鍍站的孔隙率才看得出來 —— 跨站根因分析";
  return <Readout rows={rows} hint={hint} />;
}
