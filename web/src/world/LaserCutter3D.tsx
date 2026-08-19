/**
 * 雷射切割機 3D(綁定表見 docs/animation_binding.md §4.16)。
 *
 * 切割頭位置直接吃引擎的 head_pos_x / head_pos_y(mm,L1,÷50)。節拍(CUT_S=24 s)
 * 在 sim ×120 下低於可視極限 —— 倍率 ≈1 時 L1 鎖定,否則本地跑**同一條矩形輪廓
 * 參數式**慢放並標倍率(L3)。參數式與 engine/templates/laser_cutter.py::_rect_xy 對應。
 *
 * 光束開關**由 tag 判定**(laser_power > 1000 W = 出光),與引擎的不變量檢定同一條線:
 *   · protective_lens_fouling → lens_temp → 切割頭發熱輝光(heat)+ 切速讀值下滑
 *   · chiller_degradation → chiller_temp → 冷卻機讀值 + 警示
 *   · nozzle_wear → dross_rate → 切口火花變多變紅(wear)
 */
import React, { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FX, FaultSmoke, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, approach, clamp01, scaleNote, visualPeriod } from "./deviceMotion";

const MM = 1 / 50;
const RECT_X = 150, RECT_Y = 100;   // 引擎切割矩形(±mm)
const CUT_S = 24.0, CUT_FRAC = 0.80;
const PERIM = 4 * (RECT_X + RECT_Y);
const HEAD_Y = 3.0;                 // 切割頭高度(模型單位)
const BED_Y = 1.15;                 // 床面高度

/** 與引擎 _rect_xy() 逐行對應:相位 → 矩形輪廓座標(mm)。 */
function rectXY(ph: number): [number, number] {
  let s = (ph / CUT_FRAC) * PERIM;
  if (s < 2 * RECT_X) return [-RECT_X + s, -RECT_Y];
  s -= 2 * RECT_X;
  if (s < 2 * RECT_Y) return [RECT_X, -RECT_Y + s];
  s -= 2 * RECT_Y;
  if (s < 2 * RECT_X) return [RECT_X - s, RECT_Y];
  s -= 2 * RECT_X;
  return [-RECT_X, RECT_Y - s];
}

const KerfSparks = ({ active, at, dross }: { active: boolean; at: THREE.Vector3; dross: number }) => {
  const COUNT = 36;
  const particles = useMemo(() => new Float32Array(COUNT * 3).fill(-100), []);
  const vel = useMemo(() => Array.from({ length: COUNT }, () => new THREE.Vector3()), []);
  const ref = useRef<THREE.Points>(null);
  useFrame((_, delta) => {
    if (!ref.current) return;
    const p = ref.current.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      if (!active) { p[i * 3 + 1] = -100; continue; }
      if (p[i * 3 + 1] < 0.05 || Math.random() < 0.12 + 0.4 * clamp01(dross)) {
        p[i * 3] = at.x; p[i * 3 + 1] = at.y; p[i * 3 + 2] = at.z;
        vel[i].set((Math.random() - 0.5) * 6, Math.random() * 3 + 1, (Math.random() - 0.5) * 6);
      } else {
        vel[i].y -= 16 * delta;
        p[i * 3] += vel[i].x * delta; p[i * 3 + 1] += vel[i].y * delta; p[i * 3 + 2] += vel[i].z * delta;
      }
    }
    ref.current.geometry.attributes.position.needsUpdate = true;
    (ref.current.material as THREE.PointsMaterial).color.setHex(dross > 0.5 ? 0xff5a20 : 0xffb84d);
  });
  return (
    <points frustumCulled={false} ref={ref}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={COUNT} array={particles} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.12} color="#ffb84d" transparent opacity={0.9}
                      blending={THREE.AdditiveBlending} depthWrite={false} />
    </points>
  );
};

export const LaserCutterModel = ({ motion }: MachineProps) => {
  const gantryRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const beamRef = useRef<THREE.MeshStandardMaterial>(null);
  const headGlowRef = useRef<THREE.MeshStandardMaterial>(null);
  const chillerLampRef = useRef<THREE.MeshStandardMaterial>(null);
  const phase = useRef(0);
  const pos = useRef<[number, number]>([-RECT_X, -RECT_Y]);
  const kerf = useMemo(() => new THREE.Vector3(0, BED_Y, 0), []);

  useFrame((_, delta) => {
    const t = motion.tags;
    const per = visualPeriod(CUT_S, motion.timeScale);
    const locked = Math.abs(per.factor - 1) < 0.05 &&
      typeof t.head_pos_x === "number" && typeof t.head_pos_y === "number";

    let mx: number, my: number;
    if (!motion.running) {
      [mx, my] = [-RECT_X, -RECT_Y];
      phase.current = 0;
    } else if (locked) {
      mx = t.head_pos_x; my = t.head_pos_y;                // L1
    } else {
      phase.current = (phase.current + delta / per.value) % 1;
      [mx, my] = phase.current < CUT_FRAC ? rectXY(phase.current) : [-RECT_X, -RECT_Y];
    }
    pos.current = [
      approach(pos.current[0], mx, 0.1, delta, 0.25),
      approach(pos.current[1], my, 0.1, delta, 0.25),
    ];
    if (headRef.current) headRef.current.position.x = pos.current[0] * MM;
    if (gantryRef.current) gantryRef.current.position.z = pos.current[1] * MM;

    // 光束由 laser_power 判定(>1000 W = 出光)—— 與引擎不變量同一條界線
    const firing = motion.running && (t.laser_power ?? 0) > 1000;
    if (beamRef.current) {
      beamRef.current.opacity = firing ? 0.85 : 0;
      beamRef.current.emissiveIntensity = firing ? 3.0 : 0;
    }
    // 切割頭輝光 = lens_temp(L2:污損吸收 → 發熱)
    if (headGlowRef.current) {
      headGlowRef.current.emissiveIntensity = 0.2 + 2.2 * clamp01(motion.heat);
    }
    // 冷卻水溫警示(>30 °C 亮黃)
    if (chillerLampRef.current) {
      const hot = (t.chiller_temp ?? 22) > 30;
      chillerLampRef.current.color.set(hot ? FX.warn : FX.ok);
      chillerLampRef.current.emissive.set(hot ? FX.warn : FX.ok);
      chillerLampRef.current.emissiveIntensity = hot ? 2 : 0.8;
    }
    kerf.set(pos.current[0] * MM, BED_Y, pos.current[1] * MM);
  });

  const body = bodyColor(motion);
  const firingNow = motion.running && (motion.tags.laser_power ?? 0) > 1000;
  return (
    <Shake motion={motion} amount={0.8}>
      <group>
        {/* 切割床(蜂巢床面 + 板材) */}
        <Box args={[8.6, 1.0, 6.0]} position={[0, 0.5, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.6} />
        </Box>
        <Box args={[7.6, 0.1, 5.0]} position={[0, 1.05, 0]} receiveShadow>
          <meshStandardMaterial color="#2b3338" roughness={0.8} />
        </Box>
        <Box args={[6.8, 0.06, 4.4]} position={[0, BED_Y - 0.02, 0]} receiveShadow>
          <meshStandardMaterial color="#9aa6ad" metalness={0.85} roughness={0.3} />
        </Box>
        {/* 已切輪廓刻線(裝飾:引擎輪廓的靜態幾何,±150×±100) */}
        {([[0, -RECT_Y], [0, RECT_Y]] as const).map(([cx, cy], i) => (
          <Box key={`h${i}`} args={[2 * RECT_X * MM, 0.02, 0.05]} position={[cx, BED_Y + 0.02, cy * MM]}>
            <meshStandardMaterial color="#4a3020" />
          </Box>
        ))}
        {([[-RECT_X, 0], [RECT_X, 0]] as const).map(([cx, cy], i) => (
          <Box key={`v${i}`} args={[0.05, 0.02, 2 * RECT_Y * MM]} position={[cx * MM, BED_Y + 0.02, cy]}>
            <meshStandardMaterial color="#4a3020" />
          </Box>
        ))}

        {/* 龍門(Z 向走 head_pos_y)+ 切割頭(X 向走 head_pos_x) */}
        {[-3.9, 3.9].map((x) => (
          <Box key={x} args={[0.5, 2.6, 6.0]} position={[x, 2.0, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#5a6a72" metalness={0.6} />
          </Box>
        ))}
        <group ref={gantryRef}>
          <Box args={[8.6, 0.4, 0.6]} position={[0, HEAD_Y + 0.4, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#7a8890" metalness={0.7} />
          </Box>
          <group ref={headRef}>
            <Box args={[0.55, 0.9, 0.55]} position={[0, HEAD_Y - 0.2, 0]} castShadow>
              <meshStandardMaterial ref={headGlowRef} color="#37444b" emissive="#ff5a20"
                                    emissiveIntensity={0.2} metalness={0.6} />
            </Box>
            <Cylinder args={[0.12, 0.07, 0.5, 12]} position={[0, HEAD_Y - 0.85, 0]} castShadow>
              <meshStandardMaterial color="#c8a03a" metalness={0.8} />
            </Cylinder>
            {/* 光束:頭到床面的細圓柱(出光才可見) */}
            <Cylinder args={[0.035, 0.035, HEAD_Y - 1.1 - BED_Y, 8]}
                      position={[0, (HEAD_Y - 1.1 + BED_Y) / 2, 0]}>
              <meshStandardMaterial ref={beamRef} color="#ff3020" emissive="#ff4020"
                                    emissiveIntensity={0} transparent opacity={0} toneMapped={false} />
            </Cylinder>
            {/* 驗證探針:切割頭世界座標 ↔ head_pos_x / head_pos_y */}
            <object3D name="probe:laser_head" position={[0, HEAD_Y - 0.85, 0]} />
          </group>
        </group>

        <KerfSparks active={firingNow} at={kerf} dross={clamp01(motion.wear)} />

        {/* 冷卻機(chiller)+ 水溫警示燈 */}
        <Box args={[1.6, 1.8, 1.4]} position={[5.4, 0.9, -1.6]} castShadow receiveShadow>
          <meshStandardMaterial color="#3f5a6e" metalness={0.5} />
        </Box>
        <mesh position={[5.4, 1.6, -0.88]}>
          <circleGeometry args={[0.16, 18]} />
          <meshStandardMaterial ref={chillerLampRef} color={FX.ok} emissive={FX.ok}
                                emissiveIntensity={0.8} toneMapped={false} />
        </mesh>

        <StatusBeacon motion={motion} position={[3.9, 3.6, -2.6]} scale={1.2} />
        <FaultSmoke motion={motion} position={[0, 4.2, 0]} />
        <StatusText motion={motion} position={[0, 1.9, 3.05]} size={0.3} />
      </group>
    </Shake>
  );
};

export default function LaserCutter3D({ motion, debug }: MachineProps) {
  const per = visualPeriod(CUT_S, motion.timeScale);
  return (
    <MachineScene camera={[0, 7, 12]} fov={42} target={[0, 2.0, 0]} shadowScale={26} note={scaleNote(per)}
                  overlay={<LaserReadout motion={motion} />}>
      <LaserCutterModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function LaserReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["HEAD X", `${(t.head_pos_x ?? 0).toFixed(0)} mm`],
    ["HEAD Y", `${(t.head_pos_y ?? 0).toFixed(0)} mm`],
    ["POWER", `${(t.laser_power ?? 0).toFixed(0)} W`, (t.cut_speed ?? 0) > 5 && (t.laser_power ?? 3000) < 2600],
    ["LENS TEMP", `${(t.lens_temp ?? 0).toFixed(1)} °C`, (t.lens_temp ?? 0) > 60],
    ["CHILLER", `${(t.chiller_temp ?? 0).toFixed(1)} °C`, (t.chiller_temp ?? 22) > 30],
    ["GAS", `${(t.assist_gas_pressure ?? 0).toFixed(2)} bar`],
    ["CUT SPEED", `${(t.cut_speed ?? 0).toFixed(1)} mm/s`, (t.cut_speed ?? 35) > 1 && (t.cut_speed ?? 35) < 26],
    ["DROSS", `${(t.dross_rate ?? 0).toFixed(2)} %`, (t.dross_rate ?? 0) > 3.5],
    ["CUTS", `${Math.round(t.cut_count ?? 0)}`],
  ];
  const hint = (t.lens_temp ?? 0) > 60 ? "⚠ 鏡片溫度升 + 切速掉 → protective_lens_fouling(換保護鏡片)"
    : (t.chiller_temp ?? 22) > 30 ? "⚠ 冷卻水溫升 → chiller_degradation(雷射源降額中)"
    : (t.dross_rate ?? 0) > 3.5 ? "⚠ 掛渣升 + 氣壓波動 → nozzle_wear" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
