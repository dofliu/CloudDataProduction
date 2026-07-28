/**
 * 輸送帶 3D(綁定表見 docs/animation_binding.md §4.4)。
 *
 * 皮帶與工件的前進速度直接吃 belt_speed(m/s,L1):1 m/s = 1 模型單位/s ×(sim 倍率)。
 * 輸送帶的振動量級本來就小(0~2 mm/s),deviceMotion 對它套較低的 severity 門檻,
 * 否則 Shake 永遠是 0、學生看不出 bearing_wear。
 */
import React, { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FaultSmoke, Shake, StatusBeacon, StatusText, bodyColor } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01, scaleNote } from "./deviceMotion";

const LENGTH = 12, WIDTH = 2, HEIGHT = 1.5;
const PART_COUNT = 8;
const MAX_BELT_UPS = 3.0;      // 皮帶在畫面上的速度上限(模型單位/s),超過就降速並標示

export const ConveyorModel = ({ motion }: MachineProps) => {
  const partsRef = useRef<THREE.InstancedMesh>(null);
  const beltRef = useRef<THREE.Mesh>(null);
  const rollerRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const probeRef = useRef<THREE.Object3D>(null);
  const travel = useRef(0);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const beltTexture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 256; canvas.height = 256;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#333"; ctx.fillRect(0, 0, 256, 256);
      ctx.strokeStyle = "#222"; ctx.lineWidth = 10;
      for (let i = 0; i < 10; i++) { ctx.beginPath(); ctx.moveTo(0, i * 25.6); ctx.lineTo(256, i * 25.6); ctx.stroke(); }
    }
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(1, 4);
    return tex;
  }, []);

  useFrame((_, delta) => {
    const speedMs = motion.running ? (motion.tags.belt_speed ?? 0) : 0;
    // 1 m/s = 1 模型單位/s;sim 加速後在牆鐘上更快,超過可視上限就降速(倍率標示於畫面)
    const raw = speedMs * motion.timeScale;
    const shown = Math.min(MAX_BELT_UPS, raw);
    travel.current += shown * delta;

    if (beltRef.current) {
      const mat = beltRef.current.material as THREE.MeshStandardMaterial;
      if (mat.map) mat.map.offset.y = -travel.current * 0.25;
    }
    // 端輥轉速由皮帶線速度換算(r = 0.2)
    for (const r of rollerRefs) if (r.current) r.current.rotation.x = travel.current / 0.2;

    if (partsRef.current) {
      for (let i = 0; i < PART_COUNT; i++) {
        const progress = ((travel.current / LENGTH + i / PART_COUNT) % 1 + 1) % 1;
        dummy.position.set(-LENGTH / 2 + progress * LENGTH, HEIGHT + 0.3, 0);
        dummy.updateMatrix();
        partsRef.current.setMatrixAt(i, dummy.matrix);
      }
      partsRef.current.instanceMatrix.needsUpdate = true;
    }
    // 驗證探針:第 0 個工件的位置(instancedMesh 讀不到,另掛一個空節點)
    if (probeRef.current) {
      const p0 = ((travel.current / LENGTH) % 1 + 1) % 1;
      probeRef.current.position.set(-LENGTH / 2 + p0 * LENGTH, HEIGHT + 0.3, 0);
      probeRef.current.userData.travel = travel.current;
    }
  });

  const body = bodyColor(motion);

  return (
    <Shake motion={motion} amount={0.8}>
      <group position={[0, -1, 0]}>
        <Box args={[LENGTH + 0.5, HEIGHT - 0.2, WIDTH + 0.5]} position={[0, HEIGHT / 2 - 0.1, 0]} castShadow receiveShadow>
          <meshStandardMaterial color={body} metalness={0.6} />
        </Box>
        <Box ref={beltRef} args={[LENGTH, 0.2, WIDTH]} position={[0, HEIGHT - 0.1, 0]} receiveShadow>
          <meshStandardMaterial map={beltTexture} roughness={0.9} metalness={0.1} />
        </Box>
        {[-1, 1].map((s, i) => (
          <Cylinder key={i} ref={rollerRefs[i]} args={[0.2, 0.2, WIDTH, 16]} rotation={[Math.PI / 2, 0, 0]}
                    position={[s * (LENGTH / 2 + 0.1), HEIGHT - 0.2, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#333333" />
          </Cylinder>
        ))}
        {[-LENGTH / 2 + 1, LENGTH / 2 - 1].map((x, i) => (
          <group key={i}>
            <Cylinder args={[0.1, 0.1, HEIGHT, 16]} position={[x, HEIGHT / 2, WIDTH / 2]} castShadow receiveShadow>
              <meshStandardMaterial color="#aaaaaa" />
            </Cylinder>
            <Cylinder args={[0.1, 0.1, HEIGHT, 16]} position={[x, HEIGHT / 2, -WIDTH / 2]} castShadow receiveShadow>
              <meshStandardMaterial color="#aaaaaa" />
            </Cylinder>
          </group>
        ))}

        <instancedMesh ref={partsRef} args={[undefined, undefined, PART_COUNT]} castShadow receiveShadow>
          <boxGeometry args={[0.8, 0.6, 0.8]} />
          <meshStandardMaterial color="#f09000" roughness={0.3} metalness={0.8} />
        </instancedMesh>
        <object3D ref={probeRef} name="probe:belt_part0" />

        <Box args={[0.5, 1.5, 0.5]} position={[0, HEIGHT, WIDTH / 2 + 0.3]} castShadow receiveShadow>
          <meshStandardMaterial color="#506060" />
        </Box>
        <StatusText motion={motion} position={[0, HEIGHT + 0.55, WIDTH / 2 + 0.57]} size={0.24} />

        <StatusBeacon motion={motion} position={[LENGTH / 2 - 0.6, HEIGHT, -WIDTH / 2 - 0.5]} scale={1.1} />
        <FaultSmoke motion={motion} position={[0, HEIGHT + 0.6, 0]} />
      </group>
    </Shake>
  );
};

export default function Conveyor3D({ motion, debug }: MachineProps) {
  const raw = (motion.tags.belt_speed ?? 0) * motion.timeScale;
  const note = raw > MAX_BELT_UPS ? `皮帶視覺 ×1/${(raw / MAX_BELT_UPS).toFixed(1)}` : "";
  return (
    <MachineScene camera={[0, 8, 12]} fov={40} target={[0, 2, 0]} shadowScale={30} note={scaleNote(note)}
                  overlay={<BeltReadout motion={motion} />}>
      <ConveyorModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function BeltReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["BELT SPEED", `${(t.belt_speed ?? 0).toFixed(3)} m/s`],
    ["MOTOR CURR", `${(t.motor_current ?? 0).toFixed(2)} A`, (t.motor_current ?? 0) > 6.4],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(3)} mm/s`, (t.vibration_rms ?? 0) > 1.2],
  ];
  const hint = clamp01(motion.severity) > 0.5 ? "⚠ 振動 + 電流同步升高 → bearing_wear 徵兆" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
