/**
 * 智慧電表 3D(綁定表見 docs/animation_binding.md §4.9)。
 *
 * 修正:面板原本讀 `tags.voltage` / `tags.current` —— 引擎沒有這兩支,永遠顯示 220 V / 0 A。
 * 引擎發的是三相分離的 voltage_l1/l2/l3 與 current_l1/l2/l3。改成三相分別顯示,
 * 並用三根長條圖呈現相間不平衡(引擎故意做了 1.00 / 0.98 / 1.03 的不平衡)。
 *
 * 電表本身不會 fault;它的退化是 capacitor_aging → power_factor 緩降,因此功因是這台
 * 唯一的健康指標,面板上獨立配色警示(<0.85 黃 / <0.75 紅)。
 *
 * LCD 面板用 CanvasTexture 自繪(不是 drei <Text>)—— 離線可用,且一張貼圖畫完整版面。
 */
import React, { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Box } from "@react-three/drei";
import * as THREE from "three";
import MachineScene, { Readout, Row } from "./MachineScene";
import { CanvasLabel, FX } from "./MachineFx";
import { DeviceMotion, MachineProps, clamp01 } from "./deviceMotion";

const PEAK_KW = 220;    // 引擎 energy_meter.PEAK_KW,用於負載率長條

function pfColor(pf: number) { return pf < 0.75 ? FX.fault : pf < 0.85 ? FX.warn : FX.ok; }

/** 綠底 LCD:整片用一張 CanvasTexture 畫,值變動就重繪。 */
function Lcd({ kw, volts, amps, pf, kwh }:
  { kw: number; volts: number[]; amps: number[]; pf: number; kwh: number }) {
  const W = 512, H = 320;
  const { canvas, texture } = useMemo(() => {
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    return { canvas: cv, texture: tex };
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);

  useEffect(() => {
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#101c12";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "#1d3322"; ctx.lineWidth = 2;
    ctx.strokeRect(6, 6, W - 12, H - 12);
    const mono = (s: number, b = false) => `${b ? "700 " : ""}${s}px "JetBrains Mono",ui-monospace,monospace`;

    ctx.fillStyle = "#7fe08a"; ctx.textBaseline = "middle";
    ctx.textAlign = "left"; ctx.font = mono(66, true);
    ctx.fillText(`${kw.toFixed(1)}`, 24, 60);
    ctx.font = mono(24);
    ctx.fillText("kW", 24 + ctx.measureText(`${kw.toFixed(1)}`).width + 130, 74);
    ctx.textAlign = "right"; ctx.font = mono(18);
    ctx.fillStyle = "#4c9459";
    ctx.fillText("ACTIVE POWER", W - 24, 34);

    // 三相電壓 / 電流
    ctx.textAlign = "left"; ctx.font = mono(22);
    ["L1", "L2", "L3"].forEach((l, i) => {
      const y = 130 + i * 40;
      ctx.fillStyle = "#4c9459"; ctx.fillText(l, 26, y);
      ctx.fillStyle = "#7fe08a";
      ctx.fillText(`${volts[i].toFixed(1).padStart(6)} V`, 76, y);
      ctx.fillText(`${amps[i].toFixed(1).padStart(6)} A`, 250, y);
    });

    // 功因 + 累積電能
    ctx.font = mono(30, true);
    ctx.fillStyle = pfColor(pf);
    ctx.fillText(`PF ${pf.toFixed(3)}`, 26, 264);
    ctx.textAlign = "right"; ctx.font = mono(22);
    ctx.fillStyle = "#7fe08a";
    ctx.fillText(`${Math.round(kwh)} kWh`, W - 26, 264);

    // 負載率條
    ctx.fillStyle = "#1d3322"; ctx.fillRect(26, 288, W - 52, 14);
    ctx.fillStyle = "#7fe08a"; ctx.fillRect(26, 288, (W - 52) * clamp01(kw / PEAK_KW), 14);

    texture.needsUpdate = true;
  }, [canvas, texture, kw, volts, amps, pf, kwh]);

  return (
    <mesh position={[0, 0, 0.11]}>
      <planeGeometry args={[2.8, 1.75]} />
      <meshBasicMaterial map={texture} toneMapped={false} />
    </mesh>
  );
}

/** 三相電流長條:高度 = 該相電流,偏離平均越多越黃 → 一眼看得出不平衡。 */
function PhaseBars({ currents }: { currents: number[] }) {
  const refs = [useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null), useRef<THREE.Mesh>(null)];
  const avg = (currents[0] + currents[1] + currents[2]) / 3 || 1;
  const maxA = 450;
  useFrame((_, delta) => {
    refs.forEach((r, i) => {
      if (!r.current) return;
      const target = Math.max(0.02, clamp01(currents[i] / maxA)) * 1.5;
      r.current.scale.y += (target - r.current.scale.y) * (1 - Math.exp(-delta / 0.3));
      r.current.position.y = r.current.scale.y / 2;
    });
  });
  return (
    <>
      {[0, 1, 2].map((i) => {
        const dev = Math.abs(currents[i] - avg) / avg;
        const col = dev > 0.04 ? FX.warn : FX.ok;
        return (
          <group key={i} position={[-0.5 + i * 0.5, 0, 0]}>
            <mesh ref={refs[i]} position={[0, 0.02, 0]}>
              <boxGeometry args={[0.3, 1, 0.06]} />
              <meshStandardMaterial color={col} emissive={col} emissiveIntensity={1.2} toneMapped={false} />
            </mesh>
            <CanvasLabel text={`L${i + 1}`} position={[0, -0.16, 0.05]} height={0.16} color="#3f7a3f" bg="none" />
          </group>
        );
      })}
    </>
  );
}

export const EnergyMeterModel = ({ motion }: MachineProps) => {
  const t = motion.tags;
  const kw = t.active_power ?? 0;
  const volts = [t.voltage_l1 ?? 0, t.voltage_l2 ?? 0, t.voltage_l3 ?? 0];
  const amps = [t.current_l1 ?? 0, t.current_l2 ?? 0, t.current_l3 ?? 0];
  const pf = t.power_factor ?? 0;
  const pulseRef = useRef<THREE.MeshStandardMaterial>(null);

  useFrame((st) => {
    // 計度脈衝燈:每 kWh 閃一次,頻率隨功率升高(L2)
    if (pulseRef.current) {
      const hz = 0.5 + 6 * clamp01(kw / PEAK_KW);
      pulseRef.current.emissiveIntensity = Math.sin(st.clock.elapsedTime * hz * Math.PI * 2) > 0 ? 2.2 : 0.05;
    }
  });

  return (
    <group position={[0, -1, 0]}>
      <Box args={[4, 6, 2]} position={[0, 3, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#cccccc" metalness={0.4} roughness={0.6} />
      </Box>
      <Box args={[4.2, 0.5, 2.2]} position={[0, 0.25, 0]} castShadow receiveShadow>
        <meshStandardMaterial color="#444444" />
      </Box>
      <Box args={[3.6, 5.6, 0.1]} position={[0, 3, 1.01]}><meshStandardMaterial color="#d4d4d4" /></Box>

      <group position={[0, 4.1, 1.05]}>
        <Box args={[3.0, 2.0, 0.2]} castShadow receiveShadow><meshStandardMaterial color="#222222" /></Box>
        <Lcd kw={kw} volts={volts} amps={amps} pf={pf} kwh={t.energy_total ?? 0} />
      </group>

      <group position={[-1.0, 2.2, 1.06]}>
        <PhaseBars currents={amps} />
      </group>

      <group position={[1.2, 2.9, 1.06]}>
        <mesh>
          <circleGeometry args={[0.1, 16]} />
          <meshStandardMaterial ref={pulseRef} color={FX.warn} emissive={FX.warn} emissiveIntensity={0} toneMapped={false} />
        </mesh>
        <mesh position={[0.4, 0, 0]}>
          <circleGeometry args={[0.1, 16]} />
          <meshStandardMaterial color={pfColor(pf)} emissive={pfColor(pf)} emissiveIntensity={1.8} toneMapped={false} />
        </mesh>
        <CanvasLabel text="PULSE · PF" position={[0.2, -0.24, 0]} height={0.16} color="#555555" bg="none" />
      </group>

      <Box args={[0.6, 0.4, 0.2]} position={[1.0, 1.5, 1.05]} castShadow><meshStandardMaterial color="#333333" /></Box>
      <Box args={[0.4, 0.8, 0.1]} position={[1.0, 1.5, 1.15]} rotation={[Math.PI / 4, 0, 0]} castShadow>
        <meshStandardMaterial color="#cc4444" />
      </Box>

      <group position={[-0.9, 1.3, 1.06]}>
        <Box args={[1.5, 0.8, 0.02]}><meshStandardMaterial color="#e6c229" /></Box>
        <CanvasLabel text="DANGER" position={[0, 0.12, 0.03]} height={0.26} color="#000000" bg="none" />
        <CanvasLabel text="HIGH VOLTAGE" position={[0, -0.16, 0.03]} height={0.18} color="#000000" bg="none" />
      </group>
    </group>
  );
};

export default function EnergyMeter3D({ motion, debug }: MachineProps) {
  return (
    <MachineScene camera={[4, 5, 9]} fov={45} target={[0, 3, 0]} groundSize={30} shadowScale={15}
                  overlay={<MeterReadout motion={motion} />}>
      <EnergyMeterModel motion={motion} />
      {debug as React.ReactNode}
    </MachineScene>
  );
}

function MeterReadout({ motion }: { motion: DeviceMotion }) {
  const t = motion.tags;
  const pf = t.power_factor ?? 1;
  const amps = [t.current_l1 ?? 0, t.current_l2 ?? 0, t.current_l3 ?? 0];
  const avg = (amps[0] + amps[1] + amps[2]) / 3 || 1;
  const imbalance = Math.max(...amps.map((a) => Math.abs(a - avg) / avg));
  const rows: Row[] = [
    ["POWER", `${(t.active_power ?? 0).toFixed(1)} kW`],
    ["V L1/L2/L3", `${(t.voltage_l1 ?? 0).toFixed(0)}/${(t.voltage_l2 ?? 0).toFixed(0)}/${(t.voltage_l3 ?? 0).toFixed(0)} V`],
    ["A L1/L2/L3", `${amps[0].toFixed(0)}/${amps[1].toFixed(0)}/${amps[2].toFixed(0)} A`],
    ["IMBALANCE", `${(imbalance * 100).toFixed(1)} %`, imbalance > 0.05],
    ["POWER FACTOR", pf.toFixed(3), pf < 0.85],
    ["ENERGY", `${Math.round(t.energy_total ?? 0)} kWh`],
  ];
  const hint = pf < 0.85 ? "⚠ 功因偏低 → capacitor_aging(電表不會 fault,只有這條線索)" : undefined;
  return <Readout rows={rows} hint={hint} />;
}
