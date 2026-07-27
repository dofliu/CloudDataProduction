/**
 * 射出成型機 3D(綁定表見 docs/animation_binding.md §4.6)。
 *
 * 循環相位不再是前端自訂的 6 秒表,而是對應引擎的模內相位 ph
 * (engine/templates/injection_molding.py:`st["ph"] = (t % CYCLE_S)/CYCLE_S·2π`):
 *   u = ph/2π ∈ [0,0.5)  射出 / 保壓(injection_pressure = 90 + 70·sin ph,峰值在 u=0.25)
 *          [0.5,0.75) 冷卻
 *          [0.75,0.9)  開模
 *          [0.9,1.0)   頂出 + 閉模
 * 循環週期取自 cycle_time(隨 screw_wear 變長),經 L3 換算到可讀區間並標示倍率。
 * 熔膠亮度綁 injection_pressure、料管熱度綁 barrel_temp_*、螺桿轉速綁 screw_speed。
 */
import React, { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FaultSmoke, HeatGlow, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01, scaleNote, visualPeriod, visualSpin } from "./deviceMotion";

const INJ_LO = 90, INJ_HI = 160;      // injection_pressure 的谷 / 峰(bar)

export const InjectionMoldingModel = ({ motion }: MachineProps) => {
  const platenRef = useRef<THREE.Group>(null);
  const screwRef = useRef<THREE.Mesh>(null);
  const meltRef = useRef<THREE.Mesh>(null);
  const hopperRef = useRef<THREE.Mesh>(null);
  const productRef = useRef<THREE.Mesh>(null);
  const phase = useRef(0);
  const lastPhase = useRef(0);
  const lastInj = useRef(INJ_LO);
  // 頂出的成品用固定池 + ref 驅動,避免每幀 setState 觸發 React 重繪
  const EJECT_POOL = 6;
  const ejectRefs = useRef<(THREE.Group | null)[]>(Array(EJECT_POOL).fill(null));
  const ejectLife = useRef<number[]>(Array(EJECT_POOL).fill(-1));
  const ejectSlot = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(t.cycle_time || 30, motion.timeScale);
    lastPhase.current = phase.current;

    if (!motion.running) {
      phase.current = 0;
    } else if (Math.abs(per.factor - 1) < 0.05 && typeof t.injection_pressure === "number") {
      // 倍率≈1 才由 injection_pressure 反推相位(sin 半週,配合 clamping_force 定象限)
      const s = clamp01((t.injection_pressure - INJ_LO) / (INJ_HI - INJ_LO));
      const ph = Math.asin(Math.min(1, s));                       // 0..π/2
      const rising = t.injection_pressure >= lastInj.current;
      lastInj.current = t.injection_pressure;
      phase.current = (rising ? ph : Math.PI - ph) / (Math.PI * 2);
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
    }
    const u = phase.current;

    // 螺桿:射出段前進 + 轉動(轉速吃 screw_speed,L3 降頻)
    const injecting = u < 0.3;
    if (screwRef.current) {
      screwRef.current.position.x = -7.5 + (injecting ? (u / 0.3) * 0.5 : 0);
      if (motion.running) {
        const spin = visualSpin(t.screw_speed ?? 0, motion.timeScale).value;
        screwRef.current.rotation.x += spin * Math.PI * 2 * delta;
      }
    }
    // 熔膠:長度隨射出進度,亮度綁 injection_pressure(L2)
    if (meltRef.current) {
      const mat = meltRef.current.material as THREE.MeshStandardMaterial;
      const p = clamp01(((t.injection_pressure ?? INJ_LO) - INJ_LO) / (INJ_HI - INJ_LO));
      meltRef.current.scale.y = injecting ? Math.max(0.01, u / 0.3) : 0.01;
      meltRef.current.position.x = -5.0 + meltRef.current.scale.y;
      mat.emissiveIntensity = injecting ? 0.6 + 2.0 * p : 0;
    }
    if (hopperRef.current) {
      hopperRef.current.scale.y = injecting ? 1 - (u / 0.3) * 0.2 : 1;
      hopperRef.current.position.y = injecting ? 5.0 - (u / 0.3) * 0.1 : 5.0;
    }

    // 開模:u 0.75→0.9 開,0.9→1.0 閉
    let open = 0;
    if (u >= 0.75 && u < 0.9) open = ((u - 0.75) / 0.15) * 2.0;
    else if (u >= 0.9) open = (1 - (u - 0.9) / 0.1) * 2.0;
    if (platenRef.current) platenRef.current.position.x = open;

    // 模內成品:射出後出現,冷卻中降溫(emissive 退掉),開模後頂出
    if (productRef.current) {
      const mat = productRef.current.material as THREE.MeshStandardMaterial;
      productRef.current.visible = motion.running && u > 0.08 && u < 0.82;
      if (u < 0.5) mat.emissiveIntensity = 2.0;
      else if (u < 0.75) mat.emissiveIntensity = 2.0 * (1 - (u - 0.5) / 0.25);
      else mat.emissiveIntensity = 0;
    }

    // 頂出:相位跨過 0.82 時掉一件
    if (motion.running && lastPhase.current < 0.82 && u >= 0.82) {
      ejectLife.current[ejectSlot.current] = 0;
      ejectSlot.current = (ejectSlot.current + 1) % EJECT_POOL;
    }
    for (let i = 0; i < EJECT_POOL; i++) {
      const g = ejectRefs.current[i];
      if (!g) continue;
      if (ejectLife.current[i] < 0) { g.visible = false; continue; }
      ejectLife.current[i] += delta;
      const life = ejectLife.current[i];
      g.visible = true;
      g.position.set(-2.0, 2.5 - 4 * life, 0);
      g.rotation.set(life * 2, life * 2, 0);
      if (g.position.y < -2) ejectLife.current[i] = -1;
    }
  });

  const machinery = bodyColor(motion);
  const moldColor = "#444444";

  return (
    <Shake motion={motion}>
      <group position={[0, -1, 0]}>
        <Box args={[12, 1, 4]} position={[0, 0.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#506060" metalness={0.7} />
        </Box>

        <Box args={[1, 4, 3.5]} position={[-3.5, 3, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={machinery} />
        </Box>
        <Box args={[0.8, 2.5, 2.5]} position={[-2.6, 3, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={moldColor} metalness={0.8} />
        </Box>

        {[[-1.2, 1.2], [-1.2, -1.2], [1.2, 1.2], [1.2, -1.2]].map((p, i) => (
          <Cylinder key={i} args={[0.1, 0.1, 6, 16]} rotation={[0, 0, Math.PI / 2]} position={[0, 3 + p[0], p[1]]} castShadow receiveShadow>
            <meshStandardMaterial color="#cccccc" metalness={0.9} />
          </Cylinder>
        ))}

        <group position={[-1, 0, 0]} ref={platenRef}>
          <Box args={[0.8, 2.5, 2.5]} position={[-0.8, 3, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={moldColor} metalness={0.8} />
          </Box>
          <Box args={[1, 4, 3.5]} position={[0.1, 3, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={machinery} />
          </Box>
          <Box ref={productRef} args={[0.4, 1.5, 1.5]} position={[-1.4, 3, 0]} castShadow>
            <meshStandardMaterial color="#f09000" emissive="#ff5500" emissiveIntensity={0} />
          </Box>
        </group>

        <Box args={[2, 3, 2]} position={[2, 2.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={machinery} />
        </Box>
        {/* 液壓油溫 */}
        <HeatGlow motion={motion} position={[2, 2.5, 0]} radius={2.2} />

        {/* 料斗 */}
        <Cylinder args={[0.6, 0.1, 1.5, 16]} position={[-5.5, 5.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#ffffff" opacity={0.3} transparent />
        </Cylinder>
        <Cylinder ref={hopperRef} args={[0.55, 0.15, 1.4, 16]} position={[-5.5, 5.5, 0]}>
          <meshStandardMaterial color="#f09000" />
        </Cylinder>

        {/* 料管 + 四段加熱區(顏色綁 barrel_temp_1..4) */}
        <Cylinder args={[0.5, 0.5, 4, 32]} rotation={[0, 0, Math.PI / 2]} position={[-6, 3, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={machinery} />
        </Cylinder>
        <BarrelHeaters motion={motion} />

        <Cylinder ref={meltRef} args={[0.15, 0.15, 2, 16]} rotation={[0, 0, Math.PI / 2]} position={[-4.5, 3, 0]}>
          <meshStandardMaterial color="#ff5500" emissive="#ff5500" emissiveIntensity={0} toneMapped={false} />
        </Cylinder>

        <Box args={[3, 1.1, 1.1]} position={[-8.5, 3, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#333333" />
        </Box>
        <Cylinder ref={screwRef} args={[0.3, 0.3, 2.5, 16]} rotation={[0, 0, Math.PI / 2]} position={[-7.5, 3, 0]}>
          <meshStandardMaterial color="#aaaaaa" wireframe />
        </Cylinder>

        {Array.from({ length: EJECT_POOL }, (_, i) => (
          <group key={i} ref={(el) => { ejectRefs.current[i] = el; }} visible={false}>
            <Box args={[0.4, 1.5, 1.5]} castShadow><meshStandardMaterial color="#f09000" /></Box>
          </group>
        ))}

        <StatusBeacon motion={motion} position={[3.4, 4.0, 0]} scale={1.4} />
        <FaultSmoke motion={motion} position={[-6, 4.2, 0]} />
        <StatusText motion={motion} position={[-3.5, 6.4, 1.8]} size={0.32} />
      </group>
    </Shake>
  );
};

/** 料管四段加熱圈:顏色由該段 barrel_temp 決定(225~240 °C 正常,偏離即變色)。 */
function BarrelHeaters({ motion }: { motion: DeviceMotion }) {
  const nominal = [225, 235, 240, 230];
  return (
    <>
      {nominal.map((nom, i) => {
        const v = motion.tags[`barrel_temp_${i + 1}`] ?? nom;
        const dev = clamp01(Math.abs(v - nom) / 12);          // 偏離 12 °C 視為滿刻度
        const col = new THREE.Color("#ff7a2f").lerp(new THREE.Color("#c85a4a"), dev);
        return (
          <Cylinder key={i} args={[0.58, 0.58, 0.5, 20]} rotation={[0, 0, Math.PI / 2]}
                    position={[-7.4 + i * 0.95, 3, 0]} castShadow>
            <meshStandardMaterial color={col} emissive={col} emissiveIntensity={0.35 + 0.5 * dev} toneMapped={false} />
          </Cylinder>
        );
      })}
    </>
  );
}

export default function InjectionMolding3D({ motion }: MachineProps) {
  const per = visualPeriod(motion.tags.cycle_time || 30, motion.timeScale);
  const spin = visualSpin(motion.tags.screw_speed ?? 0, motion.timeScale);
  return (
    <MachineScene camera={[0, 8, 16]} fov={40} target={[-1, 3, 0]} shadowScale={30} note={scaleNote(per, spin)}
                  overlay={<MoldReadout motion={motion} />}>
      <InjectionMoldingModel motion={motion} />
    </MachineScene>
  );
}

function MoldReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const barrels = [1, 2, 3, 4].map((i) => t[`barrel_temp_${i}`] ?? 0);
  const rows: Row[] = [
    ["CLAMP", `${(t.clamping_force ?? 0).toFixed(0)} ton`],
    ["INJ PRESS", `${(t.injection_pressure ?? 0).toFixed(0)} bar`],
    ["SCREW", `${(t.screw_speed ?? 0).toFixed(0)} rpm`],
    ["BARREL T", barrels.map((v) => v.toFixed(0)).join("/")],
    ["CYCLE", `${(t.cycle_time ?? 0).toFixed(2)} s`, (t.cycle_time ?? 30) > 34],
    ["OIL TEMP", `${(t.oil_temp ?? 0).toFixed(1)} °C`, (t.oil_temp ?? 0) > 75],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["SHOTS", `${Math.round(t.shot_count ?? 0)}`],
  ];
  const hint = (t.cycle_time ?? 30) > 34 ? "⚠ 節拍變長 → screw_wear(良率題)"
    : clamp01(motion.severity) > 0.5 ? "⚠ 振動 + 油溫升高 → hydraulic_pump 退化" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
