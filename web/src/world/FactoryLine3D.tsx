/**
 * 廠內產線 3D:一個 Canvas 擺 N 台設備。
 *
 * 燈光 / 環境貼圖 / 接地陰影**只在這裡出現一次**(契約 docs/animation_binding.md §5)。
 * 機種 model 內部不得自帶,否則 N 台就是 N 份環境 cubemap + N 個陰影 render target
 * —— 那正是先前 WebGL context lost 的來源。
 */
import React from "react";
import * as THREE from "three";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Box, ContactShadows } from "@react-three/drei";
import { DeviceSnapshot, LineView, getTeacherToken, setClock } from "../api";
import { DeviceMotion, buildMotion } from "./deviceMotion";
import { StudioEnvironment } from "./MachineScene";
import { CanvasLabel } from "./MachineFx";

import { CNCModel } from "./CncMachine3D";
import { RobotArmModel } from "./RobotArm3D";
import { ConveyorModel } from "./Conveyor3D";
import { AgvModel } from "./AgvMobileRobot3D";
import { InjectionMoldingModel } from "./InjectionMolding3D";
import { StampingPressModel } from "./StampingPress3D";
import { WindTurbineModel } from "./WindTurbine3D";
import { AirCompressorModel } from "./AirCompressor3D";
import { EnergyMeterModel } from "./EnergyMeter3D";
import { ProcessChamberModel } from "./ProcessChamber3D";
import { HeatTreatFurnaceModel } from "./HeatTreatFurnace3D";

import { ARM_REACH_X, LINE_SCALE, layoutLine } from "./processFlow";

type ModelComp = React.ComponentType<any>;

const MODELS: Record<string, ModelComp> = {
  cnc_machining_center: CNCModel,
  robot_arm_6axis: RobotArmModel,
  conveyor: ConveyorModel,
  agv_mobile_robot: (p) => <AgvModel {...p} compact />,   // AGV 巡迴路線縮進單一機台格
  injection_molding: InjectionMoldingModel,
  stamping_press: StampingPressModel,
  wind_turbine: WindTurbineModel,
  air_compressor: AirCompressorModel,
  energy_meter: EnergyMeterModel,
  semi_process_chamber: ProcessChamberModel,
  heat_treat_furnace: HeatTreatFurnaceModel,
};

/**
 * 站邊緩衝:引擎產線物料流(snapshot.lines)的入/出料緩衝,一件一顆方塊。
 * 這**不是**裝飾 —— 顆數 = 引擎帳上的件數,學生用 Modbus FC04 讀 line_in/out_buffer
 * 會得到同一個數字。
 */
function BufferStack({ x, z, count, label }: { x: number; z: number; count: number; label: string }) {
  return (
    <group position={[x, 0, z]}>
      <Box args={[1.5, 0.08, 1.5]} position={[0, 0.04, 0]} receiveShadow>
        <meshStandardMaterial color="#b8ab90" roughness={0.9} />
      </Box>
      {Array.from({ length: Math.min(count, 6) }, (_, i) => (
        <Box key={i} args={[0.62, 0.55, 0.62]} position={[0, 0.42 + i * 0.58, 0]} castShadow>
          <meshStandardMaterial color="#3a8a3a" roughness={0.6} />
        </Box>
      ))}
      <CanvasLabel text={`${label} ${count}`} position={[0, 0.02, 1.35]}
                   rotation={[-Math.PI / 2, 0, 0]} height={0.42} bg="none" />
    </group>
  );
}

/**
 * 地面料道:一條從上游指向下游的導引帶 + 幾個方向箭頭。
 * 沒有 line: 宣告的公司,這仍只是空間上的對位標示;有產線的公司,工件在引擎裡
 * 真實流動(緩衝方塊 = 引擎帳,見 BufferStack)。
 */
function MaterialLane({ from, to }: { from: number; to: number }) {
  const len = Math.max(1, to - from);
  const mid = (from + to) / 2;
  const arrows = Math.max(2, Math.floor(len / 5));
  return (
    <group>
      <Box args={[len, 0.02, 2.2]} position={[mid, 0.015, 0]} receiveShadow>
        <meshStandardMaterial color="#e4d9c2" roughness={0.95} />
      </Box>
      {Array.from({ length: arrows }, (_, i) => {
        const x = from + (len / arrows) * (i + 0.5);
        return (
          <mesh key={i} position={[x, 0.03, 0]} rotation={[-Math.PI / 2, 0, -Math.PI / 2]}>
            <coneGeometry args={[0.42, 0.9, 3]} />
            <meshStandardMaterial color="#b39a6c" roughness={0.9} />
          </mesh>
        );
      })}
    </group>
  );
}

/**
 * 依實際內容尺寸與畫布長寬比把整條線框進畫面。
 * 先前是用「設備台數 × 常數」猜距離,和真正的佔地無關 —— 線一長就出框、一短就一片空地。
 */
/** 相機高度 / 水平距離。決定俯視角度。 */
const CAM_PITCH = 0.34;
/** 最高的機種約 5 個世界單位(量測見 preview/measure.mjs) */
const MAX_MACHINE_H = 5.5;

const CameraFit = ({ halfW, halfD }: { halfW: number; halfD: number }) => {
  const { camera, size } = useThree();
  React.useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera;
    const aspect = size.width / Math.max(1, size.height);
    const vFov = (cam.fov * Math.PI) / 180;
    const tan = Math.tan(vFov / 2);

    // 水平:直接看寬度。
    const distH = (halfW * 1.08) / (tan * aspect);
    // 垂直:**不能**把深度按全額算 —— 這是斜俯視,深度在畫面上被壓縮成 depth×sin(俯角)。
    // 按全額算會讓「一台機器 + 後排廠務」這種深而窄的場景把相機推到很遠、機台變一丁點。
    const sinP = CAM_PITCH / Math.hypot(1, CAM_PITCH);
    const distV = ((halfD * 2 * sinP + MAX_MACHINE_H) / 2 * 1.12) / tan;

    const d = Math.max(distH, distV, 13);
    cam.position.set(0, d * CAM_PITCH, d);
    cam.lookAt(0, 2.4, 0);
    cam.updateProjectionMatrix();
  }, [camera, size, halfW, halfD]);
  return null;
};

/**
 * 量測用(dev):讀出每台**已套 LINE_SCALE** 的世界包圍盒,交給 preview/measure.mjs。
 * 正式畫面不傳 onMeasured,這段就不會掛上。
 */
function Measurer({ ids, onMeasured }: {
  ids: { id: string; template: string }[];
  onMeasured: (rows: any[]) => void;
}) {
  const { scene } = useThree();
  React.useEffect(() => {
    const t = setTimeout(() => {
      const box = new THREE.Box3();
      const one = new THREE.Box3();
      const rows = ids.map(({ id, template }) => {
        const node = scene.getObjectByName(`dev:${id}`);
        if (!node) return null;
        // 只算實體 Mesh:粒子系統(冷卻液 / 火花 / 煙)在待機時把粒子停在 ±100、−999,
        // 直接 setFromObject 會被那些哨兵座標撐爆(量到 halfW 29、高 861)。
        box.makeEmpty();
        node.updateWorldMatrix(true, true);
        node.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!(m as any).isMesh || !m.geometry) return;
          one.setFromBufferAttribute(m.geometry.attributes.position as THREE.BufferAttribute);
          one.applyMatrix4(m.matrixWorld);
          box.union(one);
        });
        if (box.isEmpty()) return null;
        return {
          template,
          halfW: (box.max.x - box.min.x) / 2,
          halfD: (box.max.z - box.min.z) / 2,
          height: box.max.y - box.min.y,
        };
      }).filter(Boolean);
      onMeasured(rows as any[]);
    }, 900);            // 等補間把機構帶到穩態再量
    return () => clearTimeout(t);
  }, [scene, ids, onMeasured]);
  return null;
}

export default function FactoryLine3D({
  devices, snapshots, multiplier = 1, line, onDeviceClick, onMeasured,
}: {
  devices: { id: string; template: string }[];
  snapshots: Record<string, DeviceSnapshot>;
  multiplier?: number;
  /** 這間公司的產線物料流視圖(snapshot.lines;沒有 line: 宣告就是 undefined) */
  line?: LineView;
  onDeviceClick?: (id: string) => void;
  /** dev 量測用,正式畫面不傳 */
  onMeasured?: (rows: any[]) => void;
}) {
  const stationByDev = React.useMemo(() => {
    const m: Record<string, LineView["stations"][number]> = {};
    for (const s of line?.stations ?? []) m[s.device] = s;
    return m;
  }, [line]);
  // 依製程角色排出一條看得懂的線(上游 → 搬運 → 出料),而不是等距一列各做各的
  const layout = React.useMemo(() => layoutLine(devices), [devices]);
  // 手臂上下游的緩衝方塊要擺在手臂**真正的取放點**上(processFlow 對位的同一組數字),
  // 手臂才是「伸到堆料處取件、轉身放到下一站」,而不是各畫各的。
  const handoff = React.useMemo(() => {
    if (!line) return null;
    const idx = line.stations.findIndex((s) => s.role === "handler");
    if (idx <= 0) return null;
    const armPlaced = layout.placed.find((p) => p.id === line.stations[idx].device);
    if (!armPlaced) return null;
    return {
      upDev: line.stations[idx - 1]?.device,
      downDev: line.stations[idx + 1]?.device,
      pick: { x: armPlaced.x - ARM_REACH_X, z: 0 },   // 取件點(上游出料側)
      place: { x: armPlaced.x + ARM_REACH_X, z: 0 },  // 放件點(下游入料 / 輸送帶起點)
    };
  }, [line, layout]);
  const halfW = layout.placed.length
    ? Math.max(...layout.placed.map((p) => Math.abs(p.x))) + 3.5 : 9;
  const hasUtil = layout.placed.some((p) => p.role === "utility");
  const halfD = hasUtil ? 9 : 5.5;
  const floorW = halfW * 2 + 4;
  // 地面往後多留(廠務排在 -Z),前方只留一點 —— 前方留太多整片空地會把機台擠小
  const floorD = halfD + 7;
  const floorZ = (3 - halfD) / 2;

  return (
    <div style={{ width: "100%", height: "100%", background: "linear-gradient(to bottom,#f3e9d6,#e2d3ba)", position: "relative" }}>
      <Canvas shadows camera={{ position: [0, 12, 30], fov: 45 }}>
        <CameraFit halfW={halfW} halfD={halfD} />
        {/* ↓ 全場僅此一組(契約 §5);環境貼圖本地生成,離線可用 */}
        <StudioEnvironment tone="city" />
        <ambientLight intensity={0.45} />
        <directionalLight castShadow position={[5, 12, 6]} intensity={1.4} shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-5, 5, -5]} intensity={0.45} color="#d9a441" />

        {/* 不自動旋轉:製程是「由左至右」的,鏡頭一直繞會讓流向讀不出來 —— 學生要能
            一眼看出上游在左、下游在右。要換角度自己拖。 */}
        <OrbitControls makeDefault target={[0, 1.8, 0]} maxPolarAngle={Math.PI / 2 - 0.05} />

        <Box args={[floorW, 0.2, floorD]} position={[0, -0.1, floorZ]} receiveShadow>
          <meshStandardMaterial color="#cfc3ab" metalness={0.15} roughness={0.85} />
        </Box>
        <gridHelper args={[floorW, floorW * 2, 0xb8a888, 0xd8c9ae]} position={[0, 0.01, 0]} />

        {/* 地面料道:從上游到下游的導引線。只有真的有上下游時才畫,單機廠畫了會誤導。 */}
        {layout.lane && <MaterialLane from={layout.lane.from} to={layout.lane.to} />}

        {layout.placed.map((p) => {
          const Model = MODELS[p.template];
          if (!Model) return null;
          const snap = snapshots[p.id];
          const motion = buildMotion(snap ? { ...snap, template: p.template } : null, multiplier);
          const scale = LINE_SCALE[p.template] ?? 0.6;
          const st = stationByDev[p.id];
          return (
            <group key={p.id} position={[p.x, 0, p.z]} rotation={[0, p.yaw, 0]}
                   onClick={(e) => { e.stopPropagation(); onDeviceClick?.(p.id); }}
                   onPointerOver={() => (document.body.style.cursor = "pointer")}
                   onPointerOut={() => (document.body.style.cursor = "default")}>
              <group name={`dev:${p.id}`} scale={scale}>
                {/* 輸送帶在產線裡只畫引擎帳上的工件數(on_belt),空帶就是空的 */}
                <Model motion={motion} stations={p.stations} enclosed
                       partCount={st?.role === "terminal" ? st.on_belt ?? 0 : undefined} />
              </group>
              {/* 名牌固定朝相機:機台本體可能被轉了 yaw,牌子要轉回來才讀得到 */}
              <group rotation={[0, -p.yaw, 0]} position={[p.role === "utility" ? 0 : 0, 0, 0]}>
                <Box position={[0, -0.05, 4.6]} args={[3.0, 0.05, 0.8]}>
                  <meshStandardMaterial color="#f6efe1" />
                </Box>
                <CanvasLabel text={p.id} position={[0, 0.02, 4.6]} rotation={[-Math.PI / 2, 0, 0]}
                             height={0.46} bg="none" />
                {/* 手臂交接以外的產線緩衝(如長線的中段)仍畫在機台旁 */}
                {st?.out_buffer != null && p.id !== handoff?.upDev && (
                  <BufferStack x={2.9} z={3.1} count={st.out_buffer} label="待取" />
                )}
                {st?.in_buffer != null && p.id !== handoff?.downDev && (
                  <BufferStack x={-2.9} z={3.1} count={st.in_buffer} label="待加工" />
                )}
              </group>
            </group>
          );
        })}

        {/* 手臂交接點的緩衝:擺在手臂真正的取件 / 放件座標上(與 processFlow 對位同一組數字)。
            上游完工 → 「待取」堆高 → 手臂伸到這裡取件;下游是機台 → 「待加工」在放件點;
            下游是輸送帶 → 工件直接畫在帶上(on_belt),放件點不再另畫堆。 */}
        {handoff && stationByDev[handoff.upDev]?.out_buffer != null && (
          <BufferStack x={handoff.pick.x} z={handoff.pick.z}
                       count={stationByDev[handoff.upDev].out_buffer!} label="待取" />
        )}
        {handoff && handoff.downDev && stationByDev[handoff.downDev]?.in_buffer != null && (
          <BufferStack x={handoff.place.x} z={handoff.place.z}
                       count={stationByDev[handoff.downDev].in_buffer!} label="待加工" />
        )}

        <ContactShadows resolution={1024} scale={floorW + 6} blur={2} opacity={0.42} far={12} color="#4a3f2f" />
        {onMeasured && <Measurer ids={layout.placed} onMeasured={onMeasured} />}
      </Canvas>
      {/* 提示列放**左下**:左上是外層 WorldView 的「← 返回俯瞰 / 廠名」列(z-index 10),
          兩邊都放左上會疊在一起(這個元件是被蓋在下面那層,疊起來時被壓住的是這裡)。 */}
      <div style={{ position: "absolute", bottom: 12, left: 16, display: "flex", flexDirection: "column", gap: 4,
                    fontSize: 12, pointerEvents: "none" }}>
        <span style={{ background: "rgba(255,250,240,.8)", color: "var(--muted)", padding: "4px 10px",
                       borderRadius: 8, alignSelf: "flex-start" }}>
          拖曳旋轉 · 滾輪縮放 · 點機台看詳情
        </span>
        {layout.flowText && (
          <span style={{ background: "rgba(90,158,90,.16)", color: "#3f6b3f", padding: "4px 10px",
                         borderRadius: 8, alignSelf: "flex-start", fontWeight: 600 }}>
            製程流向:{layout.flowText}
            {line ? " · 工件實際流動(引擎產線)" : ""}
          </span>
        )}
        {line && (
          <span className="mono" style={{ background: "rgba(90,158,90,.16)", color: "#3f6b3f",
                                          padding: "4px 10px", borderRadius: 8, alignSelf: "flex-start" }}>
            已出貨 {line.shipped} 件
            {line.stations.filter((s) => s.role === "handler").map((s) =>
              ` · ${s.device} 累積搬運 ${s.moved ?? 0} 件${(s.carrying ?? 0) > 0 ? "(搬運中)" : ""}`
            ).join("")}
          </span>
        )}
        {/* ×120 下一件工件 0.2 秒就完成,取放動作本來就看不見 —— 慢速觀察把 sim 降到 ×2,
            完工 → 待取堆高 → 手臂取放 → 輸送帶送出,全部用真實資料自然看得見(教師權限)。 */}
        {line && getTeacherToken() && (
          <button
            onClick={() => setClock({ multiplier: multiplier > 4 ? 2 : 120 })}
            style={{ pointerEvents: "auto", alignSelf: "flex-start", cursor: "pointer",
                     background: multiplier > 4 ? "var(--accent, #c8703a)" : "var(--ok, #5a9e5a)",
                     color: "#fffaf0", border: "none", borderRadius: 8, padding: "5px 12px",
                     fontSize: 12, fontWeight: 700 }}>
            {multiplier > 4 ? "🎬 慢速觀察 ×2(看得見取放)" : `⏩ 恢復 ×120`}
          </button>
        )}
        {layout.utilityText && (
          <span style={{ background: "rgba(255,250,240,.8)", color: "var(--muted)", padding: "4px 10px",
                         borderRadius: 8, alignSelf: "flex-start" }}>
            {layout.utilityText}(不在主線上)
          </span>
        )}
        {multiplier > 1 && (
          <span className="mono" style={{ background: "rgba(212,122,63,.14)", color: "var(--pred)",
                                          padding: "4px 10px", borderRadius: 8, alignSelf: "flex-start" }}>
            sim ×{multiplier} · 動作節拍已做視覺換算,數值以點位為準
          </span>
        )}
      </div>
    </div>
  );
}
