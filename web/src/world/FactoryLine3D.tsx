/**
 * 廠內產線 3D:一個 Canvas 擺 N 台設備。
 *
 * 燈光 / 環境貼圖 / 接地陰影**只在這裡出現一次**(契約 docs/animation_binding.md §5)。
 * 機種 model 內部不得自帶,否則 N 台就是 N 份環境 cubemap + N 個陰影 render target
 * —— 那正是先前 WebGL context lost 的來源。
 */
import React from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls, Box, ContactShadows } from "@react-three/drei";
import { DeviceSnapshot } from "../api";
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

type ModelComp = React.ComponentType<{ motion: DeviceMotion }>;

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

/** 各機種在產線視圖中的縮放(風機 20 m 高、電表 6 m,不縮會互相打架)。 */
const LINE_SCALE: Record<string, number> = {
  wind_turbine: 0.22, stamping_press: 0.45, injection_molding: 0.42,
  heat_treat_furnace: 0.55, semi_process_chamber: 0.6, robot_arm_6axis: 0.55,
  air_compressor: 0.6, conveyor: 0.5, energy_meter: 0.7, agv_mobile_robot: 0.7,
  cnc_machining_center: 1.0,
};

const CameraController = ({ y, z }: { y: number; z: number }) => {
  const { camera } = useThree();
  React.useEffect(() => { camera.position.set(0, y, z); camera.lookAt(0, 0, 0); }, [y, z, camera]);
  return null;
};

export default function FactoryLine3D({
  devices, snapshots, multiplier = 1, onDeviceClick,
}: {
  devices: { id: string; template: string }[];
  snapshots: Record<string, DeviceSnapshot>;
  multiplier?: number;
  onDeviceClick?: (id: string) => void;
}) {
  const n = Math.max(1, devices.length);
  const startX = -((n - 1) * 8) / 2;
  // 讓整條線剛好填滿畫面:半寬 n*4 / tan(水平半視角) + 邊距
  const cameraZ = Math.max(20, n * 5.7 + 10);
  const cameraY = Math.max(8, n * 1.5 + 5);

  return (
    <div style={{ width: "100%", height: "100%", background: "linear-gradient(to bottom,#f3e9d6,#e2d3ba)", position: "relative" }}>
      <Canvas shadows camera={{ position: [0, cameraY, cameraZ], fov: 45 }}>
        <CameraController y={cameraY} z={cameraZ} />
        {/* ↓ 全場僅此一組(契約 §5);環境貼圖本地生成,離線可用 */}
        <StudioEnvironment tone="city" />
        <ambientLight intensity={0.45} />
        <directionalLight castShadow position={[5, 12, 6]} intensity={1.4} shadow-mapSize={[1024, 1024]} />
        <directionalLight position={[-5, 5, -5]} intensity={0.45} color="#d9a441" />

        <OrbitControls makeDefault autoRotate autoRotateSpeed={0.4} maxPolarAngle={Math.PI / 2 - 0.05} />

        <Box args={[n * 8 + 4, 0.2, 14]} position={[0, -0.1, 0]} receiveShadow>
          <meshStandardMaterial color="#cfc3ab" metalness={0.15} roughness={0.85} />
        </Box>
        <gridHelper args={[n * 8 + 4, (n * 8 + 4) * 2, 0xb8a888, 0xd8c9ae]} position={[0, 0.01, 0]} />

        {devices.map((dev, idx) => {
          const Model = MODELS[dev.template];
          if (!Model) return null;
          const snap = snapshots[dev.id];
          const motion = buildMotion(snap ? { ...snap, template: dev.template } : null, multiplier);
          const scale = LINE_SCALE[dev.template] ?? 0.6;
          return (
            <group key={dev.id} position={[startX + idx * 8, 0, 0]}
                   onClick={(e) => { e.stopPropagation(); onDeviceClick?.(dev.id); }}
                   onPointerOver={() => (document.body.style.cursor = "pointer")}
                   onPointerOut={() => (document.body.style.cursor = "default")}>
              <group scale={scale}>
                <Model motion={motion} />
              </group>
              <Box position={[0, -0.05, 3.2]} args={[2.6, 0.05, 0.7]}>
                <meshStandardMaterial color="#f6efe1" />
              </Box>
              <CanvasLabel text={dev.id} position={[0, 0.02, 3.2]} rotation={[-Math.PI / 2, 0, 0]}
                           height={0.44} bg="none" />
            </group>
          );
        })}

        <ContactShadows resolution={1024} scale={n * 8 + 6} blur={2} opacity={0.42} far={12} color="#4a3f2f" />
      </Canvas>
      <div style={{ position: "absolute", top: 12, left: 16, display: "flex", flexDirection: "column", gap: 4,
                    fontSize: 12, pointerEvents: "none" }}>
        <span style={{ background: "rgba(255,250,240,.8)", color: "var(--muted)", padding: "4px 10px",
                       borderRadius: 8, alignSelf: "flex-start" }}>
          拖曳旋轉 · 滾輪縮放 · 點機台看詳情
        </span>
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
