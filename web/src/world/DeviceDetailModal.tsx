/**
 * 設備詳情彈窗:放大的 3D 動畫 + 即時訊號 / 點位。
 *
 * 動畫一律走 3D model(11 種 template 全覆蓋),資料經 buildMotion 正規化後傳入
 * —— 契約見 docs/animation_binding.md。先前殘留的 Canvas 2D 等距畫法已移除
 * (改 3D 後只剩腔體 / 熱處理爐在用,現在兩者都有 3D 模型了)。
 */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { DeviceSnapshot, getTeacherToken, setCoil, resetDevice } from "../api";
import { DeviceMotion, MachineProps, buildMotion } from "./deviceMotion";
import CncMachine3D from "./CncMachine3D";
import RobotArm3D from "./RobotArm3D";
import InjectionMolding3D from "./InjectionMolding3D";
import AgvMobileRobot3D from "./AgvMobileRobot3D";
import Conveyor3D from "./Conveyor3D";
import StampingPress3D from "./StampingPress3D";
import WindTurbine3D from "./WindTurbine3D";
import AirCompressor3D from "./AirCompressor3D";
import EnergyMeter3D from "./EnergyMeter3D";
import ProcessChamber3D from "./ProcessChamber3D";
import HeatTreatFurnace3D from "./HeatTreatFurnace3D";

const SCENES: Record<string, React.ComponentType<MachineProps>> = {
  cnc_machining_center: CncMachine3D,
  robot_arm_6axis: RobotArm3D,
  injection_molding: InjectionMolding3D,
  agv_mobile_robot: AgvMobileRobot3D,
  conveyor: Conveyor3D,
  stamping_press: StampingPress3D,
  wind_turbine: WindTurbine3D,
  air_compressor: AirCompressor3D,
  energy_meter: EnergyMeter3D,
  semi_process_chamber: ProcessChamber3D,
  heat_treat_furnace: HeatTreatFurnace3D,
};

const KIND_NAME: Record<string, string> = {
  cnc_machining_center: "CNC 加工中心", robot_arm_6axis: "六軸機械手臂", conveyor: "輸送帶",
  semi_process_chamber: "製程腔體", heat_treat_furnace: "熱處理爐", wind_turbine: "風力發電機",
  agv_mobile_robot: "AGV 搬運車", air_compressor: "空壓機", stamping_press: "沖壓機",
  injection_molding: "射出成型機", energy_meter: "智慧電表",
};
const KIND_DESC: Record<string, string> = {
  cnc_machining_center: "三軸位置接 pos_x/y/z · 主軸轉速接 spindle_speed · 火花密度接 tool_wear",
  robot_arm_6axis: "六軸姿態接 joint_angle_1..6 · 取放站由正運動學定位",
  conveyor: "皮帶與工件速度接 belt_speed · 抖動接 vibration_rms",
  semi_process_chamber: "電漿輝光接 rf_power · 腔內微粒接 particle_count · 泵轉動接 vacuum_pump_current",
  heat_treat_furnace: "爐膛火光接 furnace_temp · 熱斑接 temp_uniformity · 殘氧燈接 oxygen_ppm",
  wind_turbine: "轉速接 rotor_rpm · 葉片順槳接 pitch_angle",
  agv_mobile_robot: "車體位置接 pos_x/pos_y · 朝向接 heading · 載貨接 payload",
  air_compressor: "壓力錶接 outlet_pressure · 紅線為 pressure_setpoint · 氣流接 flow",
  stamping_press: "滑塊高度接 ram_position · 工件毛邊接 burr_rate · 潤滑燈接 lubrication_pressure",
  injection_molding: "循環相位接 injection_pressure · 料管顏色接 barrel_temp_1..4",
  energy_meter: "三相電壓 / 電流分相顯示 · 功因為唯一退化指標",
};
const TH = { ok: "#5a9e5a", warn: "#d9a441", pred: "#d47a3f", fault: "#c85a4a" };

function stateLabel(m: DeviceMotion) {
  if (m.fault) return "fault";
  if (m.stopped) return "stopped";
  return m.raw;
}
function stateColor(m: DeviceMotion) {
  if (m.fault) return TH.fault;
  if (m.stopped) return "#8a7c63";
  return m.running ? TH.ok : TH.warn;
}

// ── 訊號規格:從 telemetry tag 挑值 ────────────────────────
const SIG_SPECS: { label: string; unit: string; cands: string[]; thr: number }[] = [
  { label: "振動 RMS", unit: "mm/s", cands: ["vibration_rms"], thr: 6 },
  { label: "主軸/馬達電流", unit: "A", cands: ["spindle_current", "motor_current", "vacuum_pump_current", "element_current"], thr: 14 },
  { label: "溫度", unit: "°C", cands: ["spindle_temp", "motor_temp", "chamber_temp", "die_temp", "oil_temp", "pump_temp", "furnace_temp"], thr: 90 },
];
function pickTag(tags: Record<string, number>, cands: string[]): [string, number] | null {
  for (const c of cands) if (c in tags) return [c, tags[c]];
  return null;
}

export default function DeviceDetailModal({ deviceId, snapshot, multiplier = 1, onClose }:
  { deviceId: string; snapshot: DeviceSnapshot; multiplier?: number; onClose: () => void }) {
  const kind = snapshot.template;
  const histRef = useRef<number[]>([]);
  const [, forceTick] = useState(0);
  const isTeacher = !!getTeacherToken();
  const runEnabled = snapshot.coils?.run_enable !== false;
  const [resetMsg, setResetMsg] = useState("");

  const motion = useMemo(() => buildMotion(snapshot, multiplier), [snapshot, multiplier]);
  const Scene = SCENES[kind];

  // 累積振動趨勢(接真實 telemetry;每次 snapshot 變動追加一點)
  const vib = snapshot.tags?.vibration_rms;
  useEffect(() => {
    if (typeof vib !== "number") return;
    const h = histRef.current;
    h.push(vib);
    if (h.length > 60) h.splice(0, h.length - 60);
    forceTick((n) => n + 1);
  }, [vib]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tags = snapshot.tags || {};
  const signals = SIG_SPECS.map((sp) => {
    const hit = pickTag(tags, sp.cands);
    if (!hit) return null;
    const [, val] = hit;
    const over = val > sp.thr;
    const col = sp.label.startsWith("振動") ? (over ? TH.fault : TH.ok) : (over ? TH.pred : "#5a4c36");
    return { label: sp.label, val, unit: sp.unit, color: col, pct: Math.max(4, Math.min(96, (val / (sp.thr * 1.4)) * 100)) };
  }).filter(Boolean) as { label: string; val: number; unit: string; color: string; pct: number }[];

  const regs = Object.entries(tags).filter(([k]) => k !== "state").slice(0, 10);
  const discretes = Object.entries(snapshot.discretes || {});

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(50,38,22,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: "3vh 2vw", animation: "fadeIn .18s ease" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(1120px,96vw)", height: "min(680px,92vh)", background: "var(--panel)", borderRadius: 20, boxShadow: "var(--shadow-modal)", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--line)" }}>
        {/* 頭列 */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
          <span className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--text)" }}>{deviceId}</span>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>{KIND_NAME[kind] || kind}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: stateColor(motion), padding: "3px 12px", borderRadius: 20 }}>
            {stateLabel(motion)}
          </span>
          {motion.severity > 0.5 && !motion.fault && (
            <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: TH.pred, padding: "3px 12px", borderRadius: 20 }}>
              退化中 {(motion.severity * 100).toFixed(0)}%
            </span>
          )}
          <div style={{ flex: 1 }} />
          <span onClick={onClose} title="關閉 (Esc)" style={{ width: 34, height: 34, borderRadius: 9, background: "var(--accent-tint)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 600, color: "var(--muted)", cursor: "pointer" }}>✕</span>
        </div>
        {/* 主體 */}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ flex: 1, position: "relative", minWidth: 0, background: "radial-gradient(120% 90% at 50% 20%,#faf4e8,#efe4d0)" }}>
            {Scene
              ? <Scene motion={motion} />
              : <div className="muted" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>
                  此設備型別({kind})尚無 3D 模型
                </div>}
            <VibTrend hist={histRef.current} />
            <div style={{ position: "absolute", right: 16, bottom: 16, maxWidth: "62%", fontSize: 11.5, color: "var(--dim)", background: "rgba(255,250,240,.78)", padding: "6px 12px", borderRadius: 8, lineHeight: 1.5 }}>
              {KIND_DESC[kind] || "合成數據 · 詳細動畫"}
            </div>
          </div>
          {/* 右側面板 */}
          <aside style={{ width: 340, flex: "0 0 340px", background: "var(--panel)", borderLeft: "1px solid var(--line)", padding: 20, overflowY: "auto" }}>
            {isTeacher && (
              <div style={{ marginBottom: 20 }}>
                <SecLabel>設備控制 (教師權限)</SecLabel>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  <button className="btn" style={{ background: runEnabled ? "var(--warn)" : "var(--ok)", color: "#fffaf0", padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontWeight: "bold" }}
                    onClick={async () => {
                      try { await setCoil(deviceId, "run_enable", !runEnabled); setResetMsg(`已寫 run_enable=${!runEnabled}`); }
                      catch (e: any) { setResetMsg(`寫入失敗:${e.message}`); }
                    }}>{runEnabled ? "⏸ 停機" : "▶ 復機"}</button>
                  <button className="btn" style={{ background: "var(--ok)", color: "#fffaf0", padding: "6px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontWeight: "bold" }}
                    onClick={async () => {
                      try { await setCoil(deviceId, "reset_fault", true); setResetMsg(`已重置`); }
                      catch { try { await resetDevice(deviceId); setResetMsg(`已清除故障`); }
                              catch (e2: any) { setResetMsg(`重置失敗:${e2.message}`); } }
                    }}>↺ 重置 / 清故障</button>
                </div>
                {resetMsg && <div style={{ color: "var(--accent)", fontSize: 12, marginTop: 6 }}>{resetMsg}</div>}
              </div>
            )}
            <SecLabel>即時訊號</SecLabel>
            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 20 }}>
              {signals.length === 0 && <div className="muted" style={{ fontSize: 12 }}>此設備無對應訊號 tag。</div>}
              {signals.map((s) => (
                <div key={s.label}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
                    <span style={{ fontSize: 12.5, color: "var(--text-2)" }}>{s.label}</span>
                    <span className="mono" style={{ fontSize: 16, fontWeight: 700, color: s.color }}>{s.val.toFixed(1)}<span style={{ fontSize: 11, color: "var(--dim)", fontWeight: 400 }}> {s.unit}</span></span>
                  </div>
                  <div style={{ height: 7, borderRadius: 4, background: "var(--line)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${s.pct}%`, background: s.color, borderRadius: 4, transition: "width .5s ease" }} />
                  </div>
                </div>
              ))}
            </div>
            {Object.keys(snapshot.setpoints || {}).length > 0 && (
              <>
                <SecLabel>設定點 · SETPOINT FC03/FC06</SecLabel>
                <div className="mono" style={{ fontSize: 12.5, color: "var(--text-2)", marginBottom: 18 }}>
                  {Object.entries(snapshot.setpoints || {}).map(([k, v]) => (
                    <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
                      <span style={{ color: "var(--dim)" }}>{k}</span><span>{typeof v === "number" ? v.toFixed(2) : String(v)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
            <SecLabel>保持暫存器 · HOLDING FC03</SecLabel>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--text-2)", marginBottom: 18 }}>
              {regs.map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "5px 0", borderBottom: "1px solid var(--line)" }}>
                  <span style={{ color: "var(--dim)" }}>{k}</span><span>{typeof v === "number" ? v.toFixed(2) : String(v)}</span>
                </div>
              ))}
            </div>
            {discretes.length > 0 && (
              <>
                <SecLabel>離散輸入 · DISCRETE FC02</SecLabel>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
                  {discretes.map(([k, on]) => (
                    <span key={k} className="mono" style={{ fontSize: 11.5, padding: "3px 10px", borderRadius: 12,
                      background: on ? "#eef4e8" : "var(--panel-2)", color: on ? "var(--ok)" : "var(--dim)", border: `1px solid ${on ? "#d3e2c4" : "var(--line-2)"}` }}>
                      {on ? "● " : "○ "}{k}
                    </span>
                  ))}
                </div>
              </>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

/** 振動 RMS 趨勢(接真實 telemetry,每筆 snapshot 追加一點)。 */
function VibTrend({ hist }: { hist: number[] }) {
  if (hist.length < 2) return null;
  const W = 210, H = 52;
  const mn = Math.min(...hist) - 0.3, mx = Math.max(...hist) + 0.3;
  const rng = Math.max(0.5, mx - mn);
  const d = hist.map((v, i) => `${i ? "L" : "M"}${(i / (hist.length - 1)) * W},${H - ((v - mn) / rng) * H}`).join(" ");
  return (
    <div style={{ position: "absolute", left: 14, bottom: 14, background: "rgba(255,250,240,.8)", border: "1px solid var(--line)",
                  borderRadius: 10, padding: "8px 10px 4px", pointerEvents: "none" }}>
      <div className="mono" style={{ fontSize: 10.5, color: "var(--dim)", marginBottom: 3 }}>
        振動 RMS 趨勢 · 現值 {hist[hist.length - 1].toFixed(2)} mm/s
      </div>
      <svg width={W} height={H} style={{ display: "block" }}>
        <path d={d} fill="none" stroke="#c8703a" strokeWidth={2} strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function SecLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: "var(--font-serif)", fontSize: 11, letterSpacing: ".4px", color: "var(--dim)", marginBottom: 10, fontWeight: 600 }}>{children}</div>;
}
