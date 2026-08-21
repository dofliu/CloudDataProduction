/**
 * 感應加熱爐 3D(綁定表見 docs/animation_binding.md §4.20)。
 *
 * 這台的「動作」是**棒料穿過線圈**:一支進、一支出,出料端是紅熱的。
 *   · 棒料位置 —— 由相位推進(L3,節拍 22 s 取自 billet_count 的節拍常數;
 *     引擎沒有給位置 tag,所以這裡標示為本地重建 + 倍率,不假裝是 L1)。
 *   · 出料棒料顏色 —— billet_temp_out(°C,L1 → 色溫):1180 °C 白熾、不足時偏暗紅。
 *     **這是這台最重要的一格**:溫度不足的棒料鍛出來會裂,顏色直接讀得出來。
 *   · 線圈輝光 —— coil_current(A,L2)。
 *   · 冷卻水流 —— cooling_flow(L/min,L2 → 水管藍色亮度)。
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder, Torus } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const BILLET_S = 22.0;        // 引擎額定:一支棒料通過線圈
const TARGET_C = 1180;
const TRACK_X = 9.0;          // 輸送軌全長(模型單位)
const N_BILLETS = 4;          // 軌上同時可見幾支

export const InductionHeaterModel = ({ motion }: MachineProps) => {
  const billetRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null),
                      useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const billetMats = [useRef<THREE.MeshStandardMaterial>(null), useRef<THREE.MeshStandardMaterial>(null),
                      useRef<THREE.MeshStandardMaterial>(null), useRef<THREE.MeshStandardMaterial>(null)];
  const coilMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const waterMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const leakLampRef = useRef<THREE.MeshStandardMaterial>(null);
  const travel = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(BILLET_S, motion.timeScale);
    if (motion.running) travel.current = (travel.current + delta / per.value) % 1;

    const coldC = 30;
    const outC = t.billet_temp_out ?? coldC;
    billetRefs.forEach((r, i) => {
      if (!r.current) return;
      const p = ((travel.current + i / N_BILLETS) % 1 + 1) % 1;   // 0 = 入料端
      r.current.position.x = -TRACK_X / 2 + p * TRACK_X;
      r.current.visible = motion.running;
      const mat = billetMats[i].current;
      if (!mat) return;
      // 沿線加熱:進線圈(p 0.35~0.65)才開始紅,出線圈後維持 billet_temp_out 的色溫。
      // 出料端的顏色**直接是引擎的溫度**(L1),不是憑感覺調的。
      const heated = p < 0.35 ? 0 : p < 0.65 ? (p - 0.35) / 0.3 : 1;
      const hot = clamp01((outC - 600) / 620) * heated;
      mat.emissive.setRGB(hot, 0.35 * hot * hot, 0.06 * hot);
      mat.emissiveIntensity = motion.running ? 0.15 + 3.2 * hot : 0;
      mat.color.setRGB(0.42 + 0.5 * hot, 0.42 + 0.25 * hot, 0.44);
    });

    if (coilMatRef.current) {
      const i = clamp01((t.coil_current ?? 0) / 1500);
      coilMatRef.current.emissiveIntensity = motion.running ? 0.3 + 2.4 * i : 0.05;
    }
    if (waterMatRef.current) {
      const f = clamp01((t.cooling_flow ?? 0) / 100);
      waterMatRef.current.emissiveIntensity = 0.15 + 1.2 * f;    // 結垢 → 流量掉 → 變暗
      waterMatRef.current.color.setRGB(0.25, 0.55 + 0.3 * f, 0.9);
    }
    if (leakLampRef.current) {
      const bad = motion.running && (t.leakage_current ?? 0) > 12;
      leakLampRef.current.color.set(bad ? FX.warn : FX.ok);
      leakLampRef.current.emissive.set(bad ? FX.warn : FX.ok);
      leakLampRef.current.emissiveIntensity = bad ? 2.2 : 0.8;
    }
  });

  const body = bodyColor(motion);
  return (
    <Shake motion={motion} amount={0.5}>
      <group>
        {/* 機座 + 輸送軌 */}
        <Box args={[10.4, 1.0, 2.6]} position={[0, 0.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.5} />
        </Box>
        {[-0.55, 0.55].map((z) => (
          <Box key={z} args={[10.0, 0.12, 0.18]} position={[0, 1.12, z]} receiveShadow>
            <meshStandardMaterial color="#39434a" metalness={0.6} />
          </Box>
        ))}

        {/* 感應線圈(三圈,輝光跟 coil_current) */}
        {[-0.7, 0, 0.7].map((x) => (
          <Torus key={x} args={[0.85, 0.14, 10, 24]} position={[x, 1.5, 0]}
                 rotation={[0, Math.PI / 2, 0]} castShadow>
            <meshStandardMaterial ref={x === 0 ? coilMatRef : undefined} color="#b8762e"
                                  metalness={0.85} emissive="#ff8a2a" emissiveIntensity={0.3}
                                  toneMapped={false} />
          </Torus>
        ))}
        {/* 線圈外殼 */}
        <Box args={[2.6, 2.4, 2.2]} position={[0, 1.5, 0]}>
          <meshStandardMaterial color="#4a565c" transparent opacity={0.22} metalness={0.4} />
        </Box>

        {/* 棒料(穿過線圈;出料端顏色 = billet_temp_out) */}
        {billetRefs.map((r, i) => (
          <mesh key={i} ref={r} position={[-TRACK_X / 2, 1.45, 0]} rotation={[0, 0, Math.PI / 2]} castShadow>
            <cylinderGeometry args={[0.22, 0.22, 1.5, 14]} />
            <meshStandardMaterial ref={billetMats[i]} color="#6d6d70" metalness={0.6}
                                  emissive="#000000" emissiveIntensity={0} toneMapped={false} />
          </mesh>
        ))}
        {/* 驗證探針:出料端(棒料離開線圈的位置) */}
        <object3D name="probe:billet_exit" position={[TRACK_X / 2, 1.45, 0]} />

        {/* 冷卻水管(流量 = cooling_flow) */}
        {[-1.5, 1.5].map((z) => (
          <Cylinder key={z} args={[0.12, 0.12, 8.0, 10]} rotation={[0, 0, Math.PI / 2]}
                    position={[0, 2.9, z]} castShadow>
            <meshStandardMaterial ref={z < 0 ? waterMatRef : undefined} color="#3f8fd0"
                                  emissive="#2b7fd0" emissiveIntensity={0.4} toneMapped={false} />
          </Cylinder>
        ))}
        {/* 電源櫃 + 漏電警示燈 */}
        <Box args={[1.8, 3.0, 1.8]} position={[-4.6, 2.5, -1.6]} castShadow receiveShadow>
          <meshStandardMaterial color="#4a565c" metalness={0.5} />
        </Box>
        <mesh position={[-4.6, 3.6, -0.68]}>
          <circleGeometry args={[0.2, 18]} />
          <meshStandardMaterial ref={leakLampRef} color={FX.ok} emissive={FX.ok}
                                emissiveIntensity={0.8} toneMapped={false} />
        </mesh>

        <StatusBeacon motion={motion} position={[4.8, 1.9, -1.2]} scale={1.2} />
        <FaultSmoke motion={motion} position={[0, 3.6, 0]} />
        <StatusText motion={motion} position={[0, 1.7, 1.6]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function InductionHeater3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(BILLET_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 5.5, 12]} fov={42} target={[0, 1.8, 0]} shadowScale={26}
                  note={scaleNote(per)} overlay={<IndReadout motion={motion} />}>
      <InductionHeaterModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function IndReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const cold = (t.billet_temp_out ?? TARGET_C) < TARGET_C - 55;
  const rows: Row[] = [
    ["BILLET OUT", `${(t.billet_temp_out ?? 0).toFixed(0)} °C`, cold],
    ["COIL TEMP", `${(t.coil_temp ?? 0).toFixed(0)} °C`, (t.coil_temp ?? 0) > 110],
    ["COIL I", `${(t.coil_current ?? 0).toFixed(0)} A`],
    ["POWER", `${(t.output_power ?? 0).toFixed(0)} kW`],
    ["PF", `${(t.power_factor ?? 0).toFixed(3)}`, (t.power_factor ?? 1) < 0.88],
    ["LEAKAGE", `${(t.leakage_current ?? 0).toFixed(1)} mA`, (t.leakage_current ?? 0) > 12],
    ["COOLING", `${(t.cooling_flow ?? 0).toFixed(0)} L/min`, (t.cooling_flow ?? 100) < 70],
    ["BILLETS", `${Math.round(t.billet_count ?? 0)}`],
  ];
  const hint = (t.leakage_current ?? 0) > 12
    ? "⚠ 漏電流升 + 功因掉 → coil_insulation(換電氣元件,這條會走到 fault)"
    : (t.cooling_flow ?? 100) < 70 ? "⚠ 冷卻流量掉 + 線圈溫升 → cooling_scale(除垢,不是換線圈)"
    : cold ? "⚠ 出料溫度不足但線圈電流正常 → coupling_drift(重新校正加熱配方)" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
