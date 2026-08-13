/**
 * AGV 搬運車 3D(綁定表見 docs/animation_binding.md §4.3)。
 *
 * 位置 / 朝向 / 速度 / 載重 / 電量全部直接吃引擎(L1):pos_x、pos_y、heading、speed、
 * payload、battery_soc。引擎的巡迴路線是 (2,2)-(18,2)-(18,12)-(2,12),兩個停靠站在
 * s=16(18,2)與 s=42(2,12),各停 6 秒 —— 站邊的上下料手臂就以「AGV 停在站上」為觸發。
 *
 * 修正:原本用一個 module-level 的 `globalAgvHasPayload` 記載貨狀態,多台 AGV 會互相
 * 干擾;現在直接讀 payload tag。位置補間也改成 delta-based。
 *
 * `compact` 供 FactoryLine3D 使用:把 20×14 m 的巡迴路線縮進單一機台格內。
 */
import React, { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder, Line } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { CanvasLabel, FX, FaultSmoke, HeatGlow, StatusBeacon, WORKPIECE, bodyColor } from "./MachineFx";
import {
  AGV_LOOP, DeviceMotion, MachineProps, agvLockS, agvPosFromS, agvSFromPos,
  approachAngleRad, clamp01,
} from "./deviceMotion";

// 引擎 _LOOP 的四個角(幾何本體在 deviceMotion.AGV_LOOP,與引擎逐點相同)與中心
const LOOP = AGV_LOOP;
const LOOP_CENTER: [number, number] = [10, 7];
const STATION_LOAD: [number, number] = [18, 2];     // s = 16
const STATION_UNLOAD: [number, number] = [2, 12];   // s = 42
const WHEEL_R = 0.2;
// compact(產線視圖)的空間縮尺:20×14 m 巡迴路線縮進單一機台格。先前只把中心平移、
// 沒縮比例,車體照原尺寸路線在產線裡滿場開、直接穿過別台機器。縮尺是空間版的
// 「時間換算標倍率」(契約 §1):位置仍逐點對應 pos_x/pos_y,只是等比縮小,
// 並把縮小後的路徑畫在地上,讀起來是「廠內物流圈」的沙盤。
const COMPACT_SCALE = 0.25;
const compactXY = (x: number, y: number): [number, number] =>
  [(x - LOOP_CENTER[0]) * COMPACT_SCALE, (y - LOOP_CENTER[1]) * COMPACT_SCALE];

export const AgvModel = ({ motion, compact = false }: MachineProps & { compact?: boolean }) => {
  const ref = useRef<THREE.Group>(null);
  const payloadRef = useRef<THREE.Group>(null);
  const wheelRefs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const wheelAngle = useRef(0);
  const sLocal = useRef<number | null>(null);

  useFrame((_, delta) => {
    const t = motion.tags;
    const g = ref.current;
    if (!g) return;

    // 位置走弧長鎖定(契約 §4.3):回報 (pos_x, pos_y) 投影成路徑弧長,本地 s 沿
    // 前進向趨近、到位貼齊 —— 車體任何時刻都在巡迴路徑上,不再直線切過轉角。
    const sTarget = agvSFromPos(t.pos_x ?? LOOP_CENTER[0], t.pos_y ?? LOOP_CENTER[1]);
    sLocal.current = sLocal.current === null ? sTarget : agvLockS(sLocal.current, sTarget, delta);
    const [px, py] = agvPosFromS(sLocal.current);
    if (compact) {
      const [cx, cz] = compactXY(px, py);
      g.position.x = cx;
      g.position.z = cz;
    } else {
      g.position.x = px;
      g.position.z = py;
    }
    // 朝向維持 L1 吃 heading tag(wrap-aware,0.5° 內貼齊)
    g.rotation.y = approachAngleRad(
      g.rotation.y, THREE.MathUtils.degToRad(t.heading ?? 0), 0.3, delta, THREE.MathUtils.degToRad(0.5));

    // 輪子轉速由 speed 換算(v = ωr),sim 倍率也算進去
    const v = (t.speed ?? 0) * motion.timeScale;
    wheelAngle.current += (v / WHEEL_R) * delta;
    for (const w of wheelRefs) if (w.current) w.current.rotation.x = wheelAngle.current;

    if (payloadRef.current) payloadRef.current.visible = (t.payload ?? 0) > 0;
  });

  const soc = motion.tags.battery_soc ?? 0;
  const body = motion.fault ? FX.fault : motion.charging ? "#44aa44" : bodyColor(motion, "#ffaa00");

  // compact:縮小後的巡迴路徑畫在地上(車體在標線上跑,讀起來才是「物流圈」而非亂開)
  const compactLoopPts = useMemo(() => {
    if (!compact) return null;
    return [...LOOP, LOOP[0]].map(([x, y]) => {
      const [cx, cz] = compactXY(x, y);
      return [cx, 0.02, cz] as [number, number, number];
    });
  }, [compact]);

  return (
    <group>
      {compact && compactLoopPts && (
        <group>
          <Line points={compactLoopPts} color="#b8a888" lineWidth={2} dashed dashSize={0.25} gapSize={0.15} />
          {[STATION_LOAD, STATION_UNLOAD].map((s, i) => {
            const [cx, cz] = compactXY(s[0], s[1]);
            return (
              <Cylinder key={i} args={[0.35, 0.35, 0.04, 20]} position={[cx, 0.02, cz]}>
                <meshStandardMaterial color={i === 0 ? "#8a6f3a" : "#5a7a5a"} />
              </Cylinder>
            );
          })}
          <CanvasLabel text={`巡迴路線縮尺 1:${Math.round(1 / COMPACT_SCALE)}`}
                       position={[0, 0.03, 2.6]} rotation={[-Math.PI / 2, 0, 0]}
                       height={0.34} color="#8a7a5e" bg="none" />
        </group>
      )}
    <group ref={ref} position={[compact ? 0 : LOOP_CENTER[0], 0, compact ? 0 : LOOP_CENTER[1]]}>
      {/* 驗證探針:車體中心 —— 世界 (x,z) 應等於 (pos_x, pos_y),朝向應等於 heading */}
      <object3D name="probe:agv_body" />
      <object3D name="probe:agv_nose" position={[0, 0, 1]} />
      <Cylinder args={[1.2, 1.2, 0.5, 32]} position={[0, 0.4, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={body} />
      </Cylinder>
      <Cylinder args={[0.3, 0.3, 1.2, 16]} position={[0, 1.2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#888888" />
      </Cylinder>
      {[[-0.7, 0.7], [0.7, 0.7], [-0.7, -0.7], [0.7, -0.7]].map((p, i) => (
        <Cylinder key={i} ref={wheelRefs[i]} args={[WHEEL_R, WHEEL_R, 0.2, 16]} rotation={[0, 0, Math.PI / 2]}
                  position={[p[0], WHEEL_R, p[1]]} castShadow receiveShadow>
          <meshStandardMaterial color="#222222" />
        </Cylinder>
      ))}
      <Cylinder args={[0.9, 0.9, 0.1, 32]} position={[0, 1.8, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#444444" />
      </Cylinder>
      <group ref={payloadRef} position={[0, 2.1, 0]} visible={false}>
        <Box args={[0.5, 0.5, 0.5]} castShadow receiveShadow><meshStandardMaterial color={WORKPIECE} /></Box>
      </group>
      {/* 行進方向燈 */}
      <Box args={[0.6, 0.1, 0.4]} position={[0, 0.55, 1.0]} castShadow receiveShadow>
        <meshStandardMaterial color="#ffffff" emissive={motion.running ? "#ffffff" : "#000000"} emissiveIntensity={0.6} />
      </Box>
      {/* 馬達發熱 */}
      <HeatGlow motion={motion} position={[0, 0.4, 0]} radius={1.4} />
      <StatusBeacon motion={motion} position={[0, 1.8, -0.6]} scale={0.8} />
      <FaultSmoke motion={motion} position={[0, 1.4, 0]} scale={0.7} />
      <CanvasLabel text={`SOC ${soc.toFixed(1)}%`} position={[0, 3.1, 0]} rotation={[0, Math.PI, 0]}
                   height={0.46} color={soc < 30 ? FX.fault : "#3a3226"} />
    </group>
    </group>
  );
};

// ── 站邊設備(視覺道具):以「AGV 停在本站」為觸發,節拍配合引擎的 6 秒停靠 ──

const StationCNC = ({ position }: { position: [number, number, number] }) => (
  <group position={position}>
    <Box args={[4, 5, 3]} position={[0, 2.5, 0]} castShadow receiveShadow>
      <meshStandardMaterial color="#7b8a8b" />
    </Box>
    <Box args={[2.5, 2, 0.2]} position={[0, 2.5, 1.5]} castShadow><meshStandardMaterial color="#222222" /></Box>
    <Box args={[1.5, 1, 1.5]} position={[0, 0.5, 2.25]} castShadow receiveShadow>
      <meshStandardMaterial color="#555555" />
    </Box>
  </group>
);

/** 上下料手臂:AGV 停穩在本站就開始 6 秒搬運循環(與引擎 stop_timer=6.0 同步)。 */
const StationArm = ({ at, motion, isLoad }: { at: [number, number]; motion: DeviceMotion; isLoad: boolean }) => {
  const j1 = useRef<THREE.Group>(null), j2 = useRef<THREE.Group>(null), j3 = useRef<THREE.Group>(null);
  const grip = useRef<THREE.Group>(null);
  const boxRef = useRef<THREE.Mesh>(null), srcBoxRef = useRef<THREE.Mesh>(null);
  const timer = useRef(0);

  useFrame((_, delta) => {
    const t = motion.tags;
    const dx = (t.pos_x ?? 0) - at[0], dz = (t.pos_y ?? 0) - at[1];
    const docked = motion.running && Math.hypot(dx, dz) < 3.0 && (t.speed ?? 0) < 0.02;
    timer.current = docked ? Math.min(6, timer.current + delta) : 0;

    const smooth = (x: number) => x * x * (3 - 2 * x);
    const interp = (a: number, b: number, p: number) => a + (b - a) * smooth(Math.max(0, Math.min(1, p)));
    const tt = timer.current;
    let a1 = 0, a2 = 20, a3 = 30, hasBox = false, srcBox = isLoad;

    if (tt === 0) { srcBox = isLoad; }
    else if (tt < 1) { a1 = interp(0, 90, tt); a2 = interp(20, 60, tt); a3 = interp(30, 45, tt); }
    else if (tt < 2) { a1 = 90; a2 = 60; a3 = 45; hasBox = tt > 1.5 ? isLoad : !isLoad; srcBox = tt > 1.5 ? !isLoad : isLoad; }
    else if (tt < 4) {
      const p = (tt - 2) / 2;
      a1 = interp(90, -90, p);
      a2 = p < 0.5 ? interp(60, 20, p * 2) : interp(20, 60, (p - 0.5) * 2);
      a3 = p < 0.5 ? interp(45, 30, p * 2) : interp(30, 45, (p - 0.5) * 2);
      hasBox = isLoad; srcBox = !isLoad;
    } else if (tt < 5) { a1 = -90; a2 = 60; a3 = 45; hasBox = tt > 4.5 ? !isLoad : isLoad; srcBox = !isLoad; }
    else { const p = tt - 5; a1 = interp(-90, 0, p); a2 = interp(60, 20, p); a3 = interp(45, 30, p); hasBox = !isLoad; srcBox = !isLoad; }

    const D = THREE.MathUtils.degToRad;
    if (j1.current) j1.current.rotation.y = D(a1);
    if (j2.current) j2.current.rotation.z = D(a2);
    if (j3.current) j3.current.rotation.z = D(a3);
    if (grip.current) grip.current.rotation.z = D(-(a2 + a3));
    if (boxRef.current) boxRef.current.visible = hasBox;
    if (srcBoxRef.current) srcBoxRef.current.visible = srcBox;
  });

  return (
    <group>
      <Box ref={srcBoxRef} args={[0.5, 0.5, 0.5]} position={[0, 2.05, -3.2]} castShadow>
        <meshStandardMaterial color={WORKPIECE} />
      </Box>
      <Cylinder args={[0.6, 0.8, 1.0, 32]} position={[0, 0.5, 0]} castShadow><meshStandardMaterial color="#444444" /></Cylinder>
      <group ref={j1} position={[0, 1.0, 0]}>
        <Cylinder args={[0.5, 0.6, 1.0, 32]} position={[0, 0.5, 0]} castShadow><meshStandardMaterial color="#f0b030" /></Cylinder>
        <group position={[0, 1.0, 0]}>
          <Cylinder args={[0.4, 0.4, 1.0, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow><meshStandardMaterial color="#222222" /></Cylinder>
          <group ref={j2}>
            <Box args={[0.6, 2.0, 0.6]} position={[0, 1.0, 0]} castShadow><meshStandardMaterial color="#f0b030" /></Box>
            <group position={[0, 2.0, 0]}>
              <Cylinder args={[0.3, 0.3, 0.8, 32]} rotation={[Math.PI / 2, 0, 0]} castShadow><meshStandardMaterial color="#222222" /></Cylinder>
              <group ref={j3}>
                <Box args={[0.4, 1.5, 0.4]} position={[0, 0.75, 0]} castShadow><meshStandardMaterial color="#f0b030" /></Box>
                <group position={[0, 1.5, 0]}>
                  <Box args={[0.2, 0.2, 0.2]} castShadow><meshStandardMaterial color="#222222" /></Box>
                  <group ref={grip}>
                    <Box args={[0.05, 0.4, 0.1]} position={[-0.15, 0.2, 0]}><meshStandardMaterial color="#222222" /></Box>
                    <Box args={[0.05, 0.4, 0.1]} position={[0.15, 0.2, 0]}><meshStandardMaterial color="#222222" /></Box>
                    <Box ref={boxRef} args={[0.5, 0.5, 0.5]} position={[0, 0.5, 0]} castShadow visible={false}>
                      <meshStandardMaterial color={WORKPIECE} />
                    </Box>
                  </group>
                </group>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
};

export default function AgvMobileRobot3D({ motion, debug }: MachineProps) {
  const pathPoints = useMemo(
    () => [...LOOP, LOOP[0]].map(([x, z]) => new THREE.Vector3(x, 0.05, z)),
    [],
  );
  const t = motion.tags;

  return (
    <MachineScene camera={[9, 15, 26]} fov={45} target={[10, 0, 7]} env="warehouse"
                  groundSize={70} shadowScale={50} shadowY={0}
                  overlay={<AgvReadout motion={motion} />}>
      <Line points={pathPoints} color="#d4a373" lineWidth={4} dashed dashSize={1} gapSize={0.5} dashScale={1} />

      <AgvModel motion={motion} />

      {/* 中央貨架(場景參考物) */}
      <group position={[10, 0, 7]}>
        <Box args={[1.5, 2.0, 1.0]} position={[0, 1.0, 0]} castShadow receiveShadow>
          <meshStandardMaterial color="#c0c0c0" />
        </Box>
        {[0.5, 1.2, 1.9].map((y, i) => (
          <Box key={i} args={[1.6, 0.1, 1.1]} position={[0, y, 0]}><meshStandardMaterial color="#555555" /></Box>
        ))}
        <CanvasLabel text="中央貨架" position={[0, 2.5, 0]} height={0.5} />
      </group>

      {/* 上料站 (18, 2) —— 引擎 s=16 的停靠點 */}
      <group position={[STATION_LOAD[0], 0, STATION_LOAD[1] - 3.2]}>
        <StationCNC position={[0, 0, -3.2]} />
        <StationArm at={STATION_LOAD} motion={motion} isLoad />
      </group>
      {/* 下料站 (2, 12) —— 引擎 s=42 的停靠點 */}
      <group position={[STATION_UNLOAD[0], 0, STATION_UNLOAD[1] + 3.2]} rotation={[0, Math.PI, 0]}>
        <StationCNC position={[0, 0, -3.2]} />
        <StationArm at={STATION_UNLOAD} motion={motion} isLoad={false} />
      </group>

      {/* 走道 */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[10, 0.01, 7]} receiveShadow>
        <planeGeometry args={[16.2, 10.2]} />
        <meshBasicMaterial color="#d9a441" transparent opacity={0.12} />
      </mesh>

      {debug as React.ReactNode}
    </MachineScene>
  );
}

function AgvReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["POS X / Y", `${(t.pos_x ?? 0).toFixed(2)}, ${(t.pos_y ?? 0).toFixed(2)} m`],
    ["HEADING", `${(t.heading ?? 0).toFixed(0)} °`],
    ["SPEED", `${(t.speed ?? 0).toFixed(3)} m/s`],
    ["PAYLOAD", `${(t.payload ?? 0).toFixed(0)} kg`],
    ["SOC", `${(t.battery_soc ?? 0).toFixed(1)} %`, (t.battery_soc ?? 100) < 25],
    ["BATT V", `${(t.battery_voltage ?? 0).toFixed(2)} V`],
    ["MOTOR L/R", `${(t.motor_current_l ?? 0).toFixed(2)}/${(t.motor_current_r ?? 0).toFixed(2)} A`],
    ["MOTOR TEMP", `${(t.motor_temp ?? 0).toFixed(1)} °C`, clamp01(motion.heat) > 0.7],
    ["BATT TEMP", `${(t.battery_temp ?? 0).toFixed(1)} °C`],
  ];
  const hint = motion.charging ? "充電中:速度 0、SOC 上升"
    : clamp01(motion.heat) > 0.7 ? "⚠ 馬達溫升 + 電流升 → motor_bearing 退化" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
