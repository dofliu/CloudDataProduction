/**
 * 動畫正確性驗證載具(dev only)。見 tests/animation/README.md。
 *
 * 把 `tests/animation/capture_frames.py` 從**真實引擎**錄下來的 telemetry 一格一格
 * 餵給機種 3D 元件,並把 three.js 場景中的探針(name 以 `probe:` 開頭的 Object3D)
 * 世界座標暴露到 window,讓 Playwright 讀回來跟引擎的 tag 值比對。
 *
 * 這裡不做任何斷言 —— 斷言全在 tests/animation/verify_animation.mjs,
 * 這支只負責「照實把場景算出來的東西吐出來」。
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { buildMotion } from "../src/world/deviceMotion";
import CncMachine3D from "../src/world/CncMachine3D";
import RobotArm3D from "../src/world/RobotArm3D";
import InjectionMolding3D from "../src/world/InjectionMolding3D";
import AgvMobileRobot3D from "../src/world/AgvMobileRobot3D";
import Conveyor3D from "../src/world/Conveyor3D";
import StampingPress3D from "../src/world/StampingPress3D";
import WindTurbine3D from "../src/world/WindTurbine3D";
import AirCompressor3D from "../src/world/AirCompressor3D";
import EnergyMeter3D from "../src/world/EnergyMeter3D";
import ProcessChamber3D from "../src/world/ProcessChamber3D";
import HeatTreatFurnace3D from "../src/world/HeatTreatFurnace3D";
import AoiInspection3D from "../src/world/AoiInspection3D";
import WeldingCell3D from "../src/world/WeldingCell3D";
import LaserCutter3D from "../src/world/LaserCutter3D";
import PackagingMachine3D from "../src/world/PackagingMachine3D";
import MeltingFurnace3D from "../src/world/MeltingFurnace3D";
import DieCastingMachine3D from "../src/world/DieCastingMachine3D";
import InductionHeater3D from "../src/world/InductionHeater3D";
import ForgingPress3D from "../src/world/ForgingPress3D";
import TrimmingPress3D from "../src/world/TrimmingPress3D";
import GrindingPolisher3D from "../src/world/GrindingPolisher3D";
import CleaningDryer3D from "../src/world/CleaningDryer3D";
import PlatingLine3D from "../src/world/PlatingLine3D";
import AssemblyStation3D from "../src/world/AssemblyStation3D";
import TorqueTester3D from "../src/world/TorqueTester3D";

const SCENES: Record<string, React.ComponentType<any>> = {
  cnc_machining_center: CncMachine3D, robot_arm_6axis: RobotArm3D, injection_molding: InjectionMolding3D,
  agv_mobile_robot: AgvMobileRobot3D, conveyor: Conveyor3D, stamping_press: StampingPress3D,
  wind_turbine: WindTurbine3D, air_compressor: AirCompressor3D, energy_meter: EnergyMeter3D,
  semi_process_chamber: ProcessChamber3D, heat_treat_furnace: HeatTreatFurnace3D,
  aoi_inspection: AoiInspection3D, welding_cell: WeldingCell3D,
  laser_cutter: LaserCutter3D, packaging_machine: PackagingMachine3D,
  melting_furnace: MeltingFurnace3D, die_casting_machine: DieCastingMachine3D,
  induction_heater: InductionHeater3D, forging_press: ForgingPress3D,
  trimming_press: TrimmingPress3D,
  grinding_polisher: GrindingPolisher3D, cleaning_dryer: CleaningDryer3D,
  plating_line: PlatingLine3D, assembly_station: AssemblyStation3D,
  torque_tester: TorqueTester3D,
};

type Frame = { sim_t: number; multiplier: number; devices: Record<string, any> };
type Capture = { time_multiplier: number; frames: Frame[] };

/**
 * 每幀把場景裡所有 `probe:*` 的世界座標 / 世界旋轉寫到 window。
 *
 * 另外累積 `__dtSum` —— 動畫是對 useFrame 的 delta 積分的,速率類斷言必須拿它當分母,
 * 不能拿牆鐘。在這個 headless 軟體渲染環境裡,rAF 的時間基準與 `performance.now()`
 * 不一致(實測 Σdelta ≈ 牆鐘 × 1.4),用牆鐘會誤判成「動畫跑太快」。
 * 真實瀏覽器上兩者相同,所以這個分母在哪裡都成立。
 */
function ProbeReporter() {
  const { scene } = useThree();
  useFrame((_st, delta) => {
    (window as any).__dtSum = ((window as any).__dtSum || 0) + delta;
    const out: Record<string, any> = {};
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const eul = new THREE.Euler();
    scene.traverse((o) => {
      // 材質探針:柱燈那類「會動的不是位置而是亮度」的元素。材質不在場景圖的走訪
      // 範圍內,所以從 Mesh 的 material 反查 —— 名稱同樣以 probe: 開頭。
      const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mat && !Array.isArray(mat) && mat.name?.startsWith("probe:")) {
        o.getWorldPosition(pos);
        out[mat.name.slice(6)] = {
          x: pos.x, y: pos.y, z: pos.z,
          emissive: (mat as THREE.MeshStandardMaterial).emissiveIntensity ?? 0,
        };
      }
      if (!o.name.startsWith("probe:")) return;
      o.getWorldPosition(pos);
      o.getWorldQuaternion(quat);
      eul.setFromQuaternion(quat, "YXZ");
      out[o.name.slice(6)] = {
        x: pos.x, y: pos.y, z: pos.z,
        rx: eul.x, ry: eul.y, rz: eul.z,
        ...(o.userData || {}),
      };
    });
    (window as any).__probes = out;
    (window as any).__probeFrames = ((window as any).__probeFrames || 0) + 1;
  });
  return null;
}

function Harness({ capture }: { capture: Capture }) {
  const [deviceId, setDeviceId] = useState<string>(
    new URLSearchParams(location.search).get("device") || "cnc_machining_center");
  const [idx, setIdx] = useState(0);
  // 測試用:覆寫命令線圈(驗「教師停機時機構是否真的停下來」)
  const [coilOverride, setCoilOverride] = useState<Record<string, boolean> | null>(null);
  // 測試用:覆寫 state。錄製窗內不一定有設備進入 fault,但柱燈語意(§2)必須驗得到
  // fault 這一格 —— 這是唯一的取得方式。
  const [stateOverride, setStateOverride] = useState<string | null>(null);

  const raw = capture.frames[idx]?.devices[deviceId];
  const snap = useMemo(() => {
    if (!raw) return raw;
    let s = raw;
    if (coilOverride) s = { ...s, coils: { ...(s.coils || {}), ...coilOverride } };
    if (stateOverride) s = { ...s, state: stateOverride };
    return s;
  }, [raw, coilOverride, stateOverride]);
  const multiplier = capture.frames[idx]?.multiplier ?? capture.time_multiplier;
  const motion = useMemo(() => buildMotion(snap, multiplier), [snap, multiplier]);
  const Scene = SCENES[snap?.template];

  useEffect(() => {
    const w = window as any;
    w.__setFrame = (i: number) => setIdx(Math.max(0, Math.min(capture.frames.length - 1, i)));
    w.__setDevice = (d: string) => { setDeviceId(d); setIdx(0); };
    w.__forceCoil = (c: Record<string, boolean> | null) => setCoilOverride(c);
    w.__forceState = (v: string | null) => setStateOverride(v);
    w.__frameCount = capture.frames.length;
    w.__deviceIds = Object.keys(capture.frames[0].devices);
    w.__currentTags = () => snap?.tags ?? {};
    w.__currentSetpoints = () => snap?.setpoints ?? {};
    w.__currentState = () => snap?.state ?? "";
    w.__multiplier = multiplier;
    w.__ready = true;
  }, [capture, snap, multiplier]);

  if (!Scene) return <div style={{ padding: 20 }}>no 3D model for {deviceId}</div>;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <Scene motion={motion} debug={<ProbeReporter />} />
      <div id="hud" style={{ position: "absolute", left: 10, bottom: 10, font: "12px monospace",
                             background: "rgba(255,255,255,.85)", padding: "4px 8px", borderRadius: 6 }}>
        {deviceId} · frame {idx}/{capture.frames.length - 1} · ×{multiplier}
      </div>
    </div>
  );
}

async function boot() {
  // ?capture=slow(multiplier 1,可逐幀比對座標)/ fast(×120,課堂設定)
  const which = new URLSearchParams(location.search).get("capture") || "slow";
  const res = await fetch(`/preview/frames_${which}.json`);
  const capture: Capture = await res.json();
  createRoot(document.getElementById("root")!).render(<Harness capture={capture} />);
}
boot();
