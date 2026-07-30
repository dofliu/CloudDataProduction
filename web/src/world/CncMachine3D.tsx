/**
 * CNC 加工中心 3D(綁定表見 docs/animation_binding.md §4.1)。
 *
 * 三軸位置**直接吃引擎的 pos_x / pos_y / pos_z**(L1),不再由前端另跑一套刀路。
 * 遙測只有 1 Hz,所以本地用同一條參數曲線做連續推進,並在每次遙測到達時把相位
 * 鎖回引擎回報的位置(lockCncPhase)—— 學生用 Modbus 讀 pos_x,值會對得上畫面刀尖。
 */
import React, { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import { Box, Cylinder } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { FaultSmoke, HeatGlow, Shake, StatusBeacon, bodyColor } from "./MachineFx";
import {
  DeviceMotion, MachineProps, approach, clamp01, cncToolPath, engraveStrokes, engraveText,
  lockCncPhase, scaleNote, visualPeriod, visualSpin,
} from "./deviceMotion";

const MM_PER_UNIT = 50;               // 引擎 mm → 模型單位
const MAX_TRAIL_POINTS = 4000;
// 刻痕的相位間距。pattern 0 的切削路徑總長約 22 模型單位,1/0.0027 ≈ 370 顆,
// 顆徑 0.13 → 略為重疊,連成實線。
const PHASE_STEP = 0.0027;
// 單幀最多補幾顆 —— 防止長時間卡頓後一次補上千顆
const MAX_MARKS_PER_FRAME = 240;

/** 冷卻液:只在真正下刀(pos_z < 0)時噴。 */
const Coolant = ({ active }: { active: boolean }) => {
  const count = 40;
  const particles = useMemo(() => new Float32Array(count * 3).fill(100), [count]);
  const velocities = useMemo(
    () => Array.from({ length: count }, () =>
      new THREE.Vector3((Math.random() - 0.5) * 0.5, -Math.random() * 8 - 4, (Math.random() - 0.5) * 0.5)),
    [count]);
  const pointsRef = useRef<THREE.Points>(null);

  useFrame((_, delta) => {
    if (!pointsRef.current) return;
    const p = pointsRef.current.geometry.attributes.position.array as Float32Array;
    for (let i = 0; i < count; i++) {
      if (!active) { p[i * 3 + 1] = 100; continue; }
      if (p[i * 3 + 1] < -4.5 || p[i * 3 + 1] > 50 || Math.random() < 0.03) {
        p[i * 3] = (Math.random() - 0.5) * 0.4; p[i * 3 + 1] = -2.0; p[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
      } else {
        p[i * 3] += velocities[i].x * delta; p[i * 3 + 1] += velocities[i].y * delta; p[i * 3 + 2] += velocities[i].z * delta;
      }
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true;
  });

  return (
    <points frustumCulled={false} ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={count} array={particles} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.3} color="#88ccff" transparent opacity={0.6} depthWrite={false} blending={THREE.AdditiveBlending} />
    </points>
  );
};

/**
 * 切削火花。密度與顏色吃 tool_wear(L2):刀越鈍,火花越多、越偏紅
 * —— 學生看得到「刀具磨耗」這條 subtle 退化線,而不是只在數字裡。
 */
const Sparks = ({ active, position, wear }: { active: boolean; position: THREE.Vector3; wear: number }) => {
  const COUNT = 60;
  const particles = useMemo(() => new Float32Array(COUNT * 3).fill(-100), []);
  const velocities = useMemo(() => Array.from({ length: COUNT }, () => new THREE.Vector3()), []);
  const pointsRef = useRef<THREE.Points>(null);

  useFrame((_, delta) => {
    if (!pointsRef.current) return;
    const p = pointsRef.current.geometry.attributes.position.array as Float32Array;
    const live = Math.round(COUNT * (0.35 + 0.65 * clamp01(wear)));   // 刀鈍 → 噴得更多
    for (let i = 0; i < COUNT; i++) {
      if (!active || i >= live) { p[i * 3 + 1] = -100; continue; }
      if (Math.random() < 0.1 || p[i * 3 + 1] < 0.5) {
        p[i * 3] = position.x; p[i * 3 + 1] = position.y; p[i * 3 + 2] = position.z;
        velocities[i].set((Math.random() - 0.5) * 6, Math.random() * 5 + 1, (Math.random() - 0.5) * 6);
      } else {
        velocities[i].y -= 9.8 * delta;
        p[i * 3] += velocities[i].x * delta; p[i * 3 + 1] += velocities[i].y * delta; p[i * 3 + 2] += velocities[i].z * delta;
      }
    }
    pointsRef.current.geometry.attributes.position.needsUpdate = true;
    const mat = pointsRef.current.material as THREE.PointsMaterial;
    mat.color.setHex(clamp01(wear) > 0.55 ? 0xff5a2a : 0xffaa00);
    mat.size = 0.15 + 0.1 * clamp01(wear);
  });

  return (
    <points frustumCulled={false} ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={COUNT} array={particles} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial size={0.15} color="#ffaa00" transparent opacity={0.85} blending={THREE.AdditiveBlending} depthWrite={false} />
    </points>
  );
};

/**
 * 產線視圖用的鈑金外殼。真實 CNC 是包起來的機箱,不是裸露的龍門 ——
 * 廠內視圖要讀得出「這是一台加工中心」,細部刀路留給點進去的詳情頁看。
 * 下游側(+X)敞開當出料口,手臂從那裡把工件取走(擺位見 processFlow.ts)。
 */
const Enclosure = ({ motion }: { motion: DeviceMotion }) => {
  const W = 15, D = 15, H = 11, T = 0.45;          // 模型單位(外層還有 scale 0.5)
  const panel = bodyColor(motion, "#9aa3a6");
  return (
    <group>
      {/* 後牆 / 上游側牆 / 頂蓋 —— 下游側(+X)不封,留出料口 */}
      <Box args={[W, H, T]} position={[0, H / 2, -D / 2]} castShadow receiveShadow>
        <meshStandardMaterial color={panel} metalness={0.45} roughness={0.55} />
      </Box>
      <Box args={[T, H, D]} position={[-W / 2, H / 2, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={panel} metalness={0.45} roughness={0.55} />
      </Box>
      <Box args={[W, T, D]} position={[0, H, 0]} castShadow receiveShadow>
        <meshStandardMaterial color={panel} metalness={0.4} roughness={0.6} />
      </Box>
      {/* 前面:下裙板 + 觀察窗(半透明,看得到裡面在動)+ 上樑 */}
      <Box args={[W, 3, T]} position={[0, 1.5, D / 2]} castShadow receiveShadow>
        <meshStandardMaterial color={panel} metalness={0.45} roughness={0.55} />
      </Box>
      <Box args={[W, 2, T]} position={[0, H - 1, D / 2]} castShadow receiveShadow>
        <meshStandardMaterial color={panel} metalness={0.45} roughness={0.55} />
      </Box>
      <Box args={[W - 1.2, H - 6, 0.12]} position={[0, (H - 6) / 2 + 3, D / 2]}>
        <meshStandardMaterial color="#bcd2d8" transparent opacity={0.26}
                              metalness={0.1} roughness={0.15} depthWrite={false} />
      </Box>
      {/* 出料口框:標出工件從這一側離開 */}
      <Box args={[T, H, T]} position={[W / 2, H / 2, -D / 2]} castShadow>
        <meshStandardMaterial color="#6f777a" metalness={0.6} />
      </Box>
      <Box args={[T, H, T]} position={[W / 2, H / 2, D / 2]} castShadow>
        <meshStandardMaterial color="#6f777a" metalness={0.6} />
      </Box>
    </group>
  );
};

export const CNCModel = ({ motion, enclosed = false }: MachineProps & {
  /** 產線視圖:加上鈑金外殼,讀起來才像一台機器 */
  enclosed?: boolean;
}) => {
  const gantryRef = useRef<THREE.Group>(null);        // Z 向(引擎 pos_y)
  const spindleHeadRef = useRef<THREE.Group>(null);   // X 向(引擎 pos_x)
  const drillRef = useRef<THREE.Group>(null);         // Y 向升降(引擎 pos_z)+ 主軸自轉
  const trailMeshRef = useRef<THREE.InstancedMesh>(null);
  const headMatRef = useRef<THREE.MeshStandardMaterial>(null);

  const phase = useRef(0);                            // 本地連續相位(0..1),隨時鎖回遙測
  const pos = useRef({ x: 0, y: 0, z: 1 });           // 已補間的模型單位座標
  const lastPart = useRef(-1);
  const isCutting = useRef(false);
  const sparkPos = useRef(new THREE.Vector3());
  const lines = useRef(0);
  const lastPhase = useRef(0);
  const lastStrokes = useRef<number[][][] | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  useFrame((_, delta) => {
    const { tags, setpoints, running, timeScale } = motion;
    const pattern = Math.round(setpoints.machining_pattern ?? 0);   // ⚙ setpoint,不在 tags
    // ⚙ 刻字筆畫由 engrave_char_1..8 setpoints 生成(pattern 0 用;預設 NCUT)
    const strokes = engraveStrokes(setpoints);
    const cycle = tags.cycle_time || 45;
    const per = visualPeriod(cycle, timeScale);                     // L3:夾在可讀區間

    // 換件 → 清空刻痕(part_count 是引擎的真實累積件數);學生改了刻字文字也清
    // (快取回傳同一個陣列參照,參照變了就是文字變了)
    const part = Math.round(tags.part_count ?? 0);
    if (part !== lastPart.current || strokes !== lastStrokes.current) {
      lastPart.current = part;
      lastStrokes.current = strokes;
      lines.current = 0;
      if (trailMeshRef.current) trailMeshRef.current.count = 0;
    }

    if (running) {
      phase.current = (phase.current + delta / per.value) % 1;
      // 相位鎖定:把本地相位拉回引擎回報的位置。
      // 只在動畫**沒有被時間換算**時鎖(factor≈1);一旦慢放,1 Hz 的 pos_* 早已低於
      // 該循環的 Nyquist,硬鎖只會抖 —— 這時畫的是「代表性刀路」,倍率已標在畫面上。
      if (Math.abs(per.factor - 1) < 0.05 && typeof tags.pos_x === "number"
          && typeof tags.pos_y === "number" && typeof tags.pos_z === "number") {
        phase.current = lockCncPhase(phase.current, tags.pos_x, tags.pos_y, tags.pos_z, pattern, delta, strokes);
      }
    }

    // 目標座標:running 用鎖定後的相位取曲線;停機 / 故障就抬刀回原點(與引擎一致)
    let tx = 0, ty = 0, tz = 1;
    if (running) {
      const [mx, my, mz] = cncToolPath(phase.current, pattern, strokes);
      tx = mx / MM_PER_UNIT; ty = my / MM_PER_UNIT; tz = mz / MM_PER_UNIT;
    }
    // delta-based 趨近,與 frame rate 無關
    const tau = 0.06;
    pos.current.x = approach(pos.current.x, tx, tau, delta);
    pos.current.y = approach(pos.current.y, ty, tau, delta);
    pos.current.z = approach(pos.current.z, tz, tau, delta);

    // 切削判定用引擎語意:pos_z < 0 就是下刀
    isCutting.current = running && pos.current.z < -0.5;
    sparkPos.current.set(pos.current.x, 1.25, pos.current.y);

    // ── 刻痕:沿**相位**補點,不是沿畫面位置 ──────────────────
    // 先前是「畫面位置移動超過門檻就放一顆」,那是 frame-rate 相依的:這個環境只有
    // 約 9 fps,一幀就跨過大半個筆畫,結果一幀只放得到一顆 → 字變成散落的點。
    // (原本球夠大才勉強連成線,但那又粗到把字糊掉。)
    // 改成把這一幀走過的相位區間切細,逐點取同一條刀路曲線 —— 幀率再低,刻痕的
    // 疏密都一樣,而且轉角不會被直線內插切掉。
    if (running && trailMeshRef.current) {
      let d = phase.current - lastPhase.current;
      if (d < 0) d += 1;                       // 跨過相位 0 的那一幀
      if (d > 0 && d < 0.5) {                  // >0.5 視為跳幀 / 重新鎖相,不補
        const steps = Math.min(MAX_MARKS_PER_FRAME, Math.ceil(d / PHASE_STEP));
        for (let k = 1; k <= steps && lines.current < MAX_TRAIL_POINTS; k++) {
          const ph = (lastPhase.current + (d * k) / steps) % 1;
          const [mx, my, mz] = cncToolPath(ph, pattern, strokes);
          if (mz >= 0) continue;               // 抬刀段不留痕(語意同引擎的 pos_z<0)
          dummy.position.set(mx / MM_PER_UNIT, 1.25, my / MM_PER_UNIT);
          // 扁而窄:刻痕是「刀痕」不是「筆跡」。字高 120mm = 2.4 模型單位,
          // 筆畫寬約 0.13(字高的 5%);先前是 0.42(17%),整個字糊成一團。
          dummy.scale.set(1.3, 0.45, 1.3);
          dummy.updateMatrix();
          trailMeshRef.current.setMatrixAt(lines.current, dummy.matrix);
          lines.current += 1;
        }
        trailMeshRef.current.instanceMatrix.needsUpdate = true;
        trailMeshRef.current.count = lines.current;
      }
    }
    lastPhase.current = phase.current;

    if (gantryRef.current) gantryRef.current.position.z = pos.current.y;
    if (spindleHeadRef.current) spindleHeadRef.current.position.x = pos.current.x;
    if (drillRef.current) {
      drillRef.current.position.y = pos.current.z + 0.75;
      if (running) {
        // L3:8000 rpm 直接畫會 aliasing,降頻到可辨識轉速(倍率標在畫面上)
        const spin = visualSpin(tags.spindle_speed || 0, timeScale).value;
        drillRef.current.rotation.y -= spin * Math.PI * 2 * delta;
      }
    }
    // 主軸座過熱 → 顏色偏橘(L2)
    if (headMatRef.current) {
      const base = motion.fault ? new THREE.Color("#c85a4a") : new THREE.Color("#b5622e");
      headMatRef.current.color.copy(base).lerp(new THREE.Color("#ff7a2f"), clamp01(motion.heat) * 0.6);
    }
  });

  return (
    <Shake motion={motion}>
      <group scale={0.5}>
        {enclosed && <Enclosure motion={motion} />}
        <Box args={[14, 0.5, 14]} position={[0, 0, 0]} receiveShadow>
          <meshStandardMaterial color="#c5bcae" roughness={0.7} metalness={0.2} />
        </Box>
        <Box args={[10, 1, 10]} position={[0, 0.75, 0]} receiveShadow castShadow>
          <meshStandardMaterial color="#e6dfd3" roughness={0.8} />
        </Box>

        <instancedMesh ref={trailMeshRef} args={[undefined, undefined, MAX_TRAIL_POINTS]} castShadow receiveShadow>
          <sphereGeometry args={[0.05, 6, 6]} />
          <meshStandardMaterial color="#7a6b58" roughness={0.9} metalness={0.4} />
        </instancedMesh>

        <Sparks active={isCutting.current} position={sparkPos.current} wear={motion.wear} />

        <group ref={gantryRef}>
          <Box args={[1, 5, 2]} position={[-6.5, 2.5, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={bodyColor(motion, "#d8d0c2")} />
          </Box>
          <Box args={[1, 5, 2]} position={[6.5, 2.5, 0]} castShadow receiveShadow>
            <meshStandardMaterial color={bodyColor(motion, "#d8d0c2")} />
          </Box>
          <Box args={[14, 1.5, 2]} position={[0, 5.75, 0]} castShadow receiveShadow>
            <meshStandardMaterial color="#b8ae9a" roughness={0.6} metalness={0.4} />
          </Box>

          <group ref={spindleHeadRef} position={[0, 5, 1]}>
            <Box args={[2, 2.5, 2.5]} castShadow receiveShadow>
              <meshStandardMaterial ref={headMatRef} color="#b5622e" roughness={0.4} metalness={0.1} />
            </Box>
            <HeatGlow motion={motion} position={[0, 0, 0]} radius={2.2} />

            <group ref={drillRef}>
              <Cylinder args={[0.4, 0.4, 3, 16]} position={[0, -0.5, 0]} castShadow>
                <meshStandardMaterial color="#8a7c63" metalness={0.6} roughness={0.2} />
              </Cylinder>
              <Cylinder args={[0.1, 0.1, 2, 8]} position={[0, -2.5, 0]} castShadow>
                <meshStandardMaterial color="#5a4c36" metalness={0.8} roughness={0.1} />
              </Cylinder>
              {/* 條紋讓轉動看得出來 */}
              <Box args={[0.12, 1.9, 0.05]} position={[0, -2.5, 0]}><meshStandardMaterial color="#3a3022" /></Box>
              <Box args={[0.05, 1.9, 0.12]} position={[0, -2.5, 0]}><meshStandardMaterial color="#3a3022" /></Box>
              {/* 驗證探針:刀尖。tests/animation 以它的世界座標回推 pos_x/y/z 是否對得上遙測 */}
              <object3D name="probe:tool_tip" position={[0, -3.5, 0]} />
              <Coolant active={isCutting.current} />
            </group>
          </group>
        </group>

        <StatusBeacon motion={motion} position={[6.5, 5.0, -1.2]} scale={1.6} />
        <FaultSmoke motion={motion} position={[0, 5.8, 0]} scale={2.2} />
      </group>
    </Shake>
  );
};

/** 詳情彈窗用的單機場景:多一組即時讀值面板,值全部取自 telemetry。 */
export default function CncMachine3D({ motion, debug }: MachineProps) {
  const t = motion.tags;
  const spin = visualSpin(t.spindle_speed || 0, motion.timeScale);
  const per = visualPeriod(t.cycle_time || 45, motion.timeScale);
  return (
    <MachineScene camera={[7.5, 8.5, 11]} fov={45} target={[0, 1.8, 0]} env="city"
                  ground="#ded5c6" shadowY={0} note={scaleNote(spin, per)}
                  overlay={<CncReadout motion={motion} />}>
      <CNCModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function CncReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const rows: Row[] = [
    ["POS X / Y", `${(t.pos_x ?? 0).toFixed(0)} / ${(t.pos_y ?? 0).toFixed(0)} mm`],
    ["POS Z", `${(t.pos_z ?? 0).toFixed(0)} mm`, (t.pos_z ?? 0) < 0],
    ["PATTERN", `${Math.round(motion.setpoints.machining_pattern ?? 0)}`],
    ["TEXT", engraveText(motion.setpoints) || "(blank)"],
    ["SPINDLE", `${(t.spindle_speed ?? 0).toFixed(0)} rpm`],
    ["SPINDLE T", `${(t.spindle_temp ?? 0).toFixed(1)} °C`, (t.spindle_temp ?? 0) > 85],
    ["CURRENT", `${(t.spindle_current ?? 0).toFixed(2)} A`, (t.spindle_current ?? 0) > 10],
    ["VIB", `${(t.vibration_rms ?? 0).toFixed(2)} mm/s`, (t.vibration_rms ?? 0) > 4.5],
    ["TOOL WEAR", `${(t.tool_wear ?? 0).toFixed(1)} %`, (t.tool_wear ?? 0) > 60],
    ["CYCLE", `${(t.cycle_time ?? 0).toFixed(2)} s`, (t.cycle_time ?? 45) > 52],
    ["PARTS", `${Math.round(t.part_count ?? 0)}`],
  ];
  const hint = clamp01(motion.severity) > 0.5 ? "⚠ 振動 + 電流 + 溫度同步升高 → spindle_bearing 退化"
    : (t.tool_wear ?? 0) > 60 ? "⚠ 刀具磨耗高 → 節拍變長、良率下降" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
