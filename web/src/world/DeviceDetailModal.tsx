import { useEffect, useRef } from "react";
import { DeviceSnapshot } from "../api";

// 設備詳情彈窗:放大的「詳細版」Canvas 動畫 + 即時訊號/趨勢/HOLDING/DISCRETE。
// Canvas 繪法移植自 4D 原型的 machine(ctx,...,detail=true);訊號/點位一律接真實 telemetry。

type Pt = { x: number; y: number };
type Th = typeof TH;
const TH = {
  ok: "#5a9e5a", warn: "#d9a441", pred: "#d47a3f", fault: "#c85a4a",
  st: 1.08, sr: 0.86, sl: 0.72, outline: "#d8c6a8", outlineW: 1,
  floor: "#efe6d3", steel: "#d8c6a8", work: "#d9a441", spark: "#f0c674",
  plasma: "#9c6bce", fire: "#d47a3f", screen: "#5a9e5a", glass: "#b8a884",
  arm1: "#c8703a", arm2: "#c9b795", joint: "#b5622e", shadow: "rgba(90,70,40,0.15)",
};

const KIND_NAME: Record<string, string> = {
  cnc_machining_center: "CNC 加工中心", robot_arm_6axis: "六軸機械手臂", conveyor: "輸送帶",
  semi_process_chamber: "製程腔體", heat_treat_furnace: "熱處理爐", wind_turbine: "風力發電機",
  agv_mobile_robot: "AGV 搬運車", air_compressor: "空壓機", stamping_press: "沖壓機",
  injection_molding: "射出成型機", energy_meter: "智慧電表",
};
const KIND_DESC: Record<string, string> = {
  cnc_machining_center: "主軸高速旋轉切削 · 冷卻噴淋 · 切屑飛濺", robot_arm_6axis: "六軸連桿 pick-place · 夾取工件搬運",
  conveyor: "皮帶連續輸送 · 光電感測 · 工件流向下一站", semi_process_chamber: "電漿製程腔 · 氣體流入 · 真空泵運轉",
  heat_treat_furnace: "爐門熱輻射 · 熱氣上升 · 工件退火", wind_turbine: "三葉輪隨風速旋轉 · 機艙發電",
  agv_mobile_robot: "自走搬運 · 光達掃描 · 沿路徑巡走", air_compressor: "馬達帶動 · 儲氣桶蓄壓 · 壓力調節",
  stamping_press: "滑塊上下往復 · 衝壓成形", injection_molding: "鎖模開合 · 料桶加熱射出",
  energy_meter: "三相電量計量 · 即時功率",
};
const STATE_LABEL: Record<string, string> = { running: "running", moving: "running", idle: "idle", fault: "fault" };
function stateColor(s: string) { return s === "fault" ? TH.fault : (s === "idle" ? TH.warn : TH.ok); }

// ── Canvas 繪圖 helpers(移植原型)────────────────────────
function shade(col: string, f: number): string {
  let r: number, g: number, b: number;
  if (col[0] === "#") {                       // #rrggbb
    const n = parseInt(col.slice(1), 16); r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
  } else {                                     // rgb(r,g,b) —— box() 會把已上色的面再次 shade
    const m = col.match(/\d+/g)!; r = +m[0]; g = +m[1]; b = +m[2];
  }
  r = Math.min(255, r * f) | 0; g = Math.min(255, g * f) | 0; b = Math.min(255, b * f) | 0;
  return `rgb(${r},${g},${b})`;
}
function pth(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}
function face(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string) {
  pth(ctx, pts); ctx.fillStyle = fill; ctx.fill();
  ctx.lineJoin = "round"; ctx.strokeStyle = TH.outline; ctx.lineWidth = TH.outlineW; ctx.stroke();
}
type Proj = (x: number, y: number, z: number) => Pt;
function box(ctx: CanvasRenderingContext2D, P: Proj, x0: number, y0: number, sx: number, sy: number, sz: number, base: string, z0 = 0) {
  const zt = z0 + sz;
  const A = P(x0, y0, zt), B = P(x0 + sx, y0, zt), C = P(x0 + sx, y0 + sy, zt), Dd = P(x0, y0 + sy, zt);
  const Bb = P(x0 + sx, y0, z0), Cb = P(x0 + sx, y0 + sy, z0), Db = P(x0, y0 + sy, z0);
  face(ctx, [Dd, Db, Cb, C], shade(base, TH.sl));
  face(ctx, [B, Bb, Cb, C], shade(base, TH.sr));
  face(ctx, [A, B, C, Dd], shade(base, TH.st));
}
function csh(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number) {
  ctx.save(); ctx.fillStyle = TH.shadow; ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, 7); ctx.fill(); ctx.restore();
}
function glow(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, col: string, a: number) {
  ctx.save(); const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, col); g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.globalAlpha = a; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill(); ctx.restore();
}

// ── 通用機台繪法(detail=true 加料:網格 / 更多粒子 / 子部件)──
function machine(ctx: CanvasRenderingContext2D, ox: number, oy: number, s: number, t: number, kind: string, detail: boolean) {
  const P: Proj = (x, y, z) => ({ x: ox + (x - y) * s, y: oy + (x + y) * s * 0.5 - z * s });
  csh(ctx, ox, oy + s * 0.2, s * 2.0, s * 1.0);
  if (detail) {
    ctx.save(); ctx.globalAlpha = .5;
    for (let i = -3; i <= 3; i++) {
      const a = P(i * 0.7, -2.4, 0), b = P(i * 0.7, 2.4, 0);
      ctx.strokeStyle = shade(TH.floor, 0.94); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.restore();
  }
  if (kind === "cnc_machining_center") {
    box(ctx, P, -1.1, -1.1, 2.2, 2.2, 1.5, TH.steel);
    const gx = -0.95, gy = 1.1;
    face(ctx, [P(gx, gy, 1.15), P(gx + 2.0, gy, 1.15), P(gx + 2.0, gy, 0.25), P(gx, gy, 0.25)], TH.glass);
    const wc = P(0.5, 1.1, 0.7); const br = 0.55 + 0.45 * Math.sin(t * 7);
    glow(ctx, wc.x, wc.y, s * 0.85, TH.work, 0.45 + 0.4 * br);
    ctx.fillStyle = TH.work; ctx.globalAlpha = 0.55 + 0.45 * br; ctx.beginPath(); ctx.arc(wc.x, wc.y, s * 0.2, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    const nsp = detail ? 12 : 5;
    for (let i = 0; i < nsp; i++) { const pp = (t * 2 + i / nsp) % 1; ctx.fillStyle = TH.spark; ctx.globalAlpha = 1 - pp; ctx.beginPath(); ctx.arc(wc.x + Math.sin(i * 2 + t) * s * 0.5, wc.y + pp * s * 0.6, 1.6, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
    box(ctx, P, 1.15, -0.6, 0.5, 0.6, 1.9, shade(TH.steel, 0.85));
    const sc = P(1.4, -0.3, 1.55); ctx.fillStyle = TH.screen; ctx.fillRect(sc.x - s * 0.25, sc.y - 14, s * 0.5, s * 0.34);
    if (detail) box(ctx, P, -0.7 + Math.sin(t * 1.5) * 0.5, 0.1, 0.2, 0.2, 0.25, TH.joint, 1.5);
  } else if (kind === "robot_arm_6axis") {
    box(ctx, P, -0.55, -0.55, 1.1, 1.1, 0.5, TH.steel);
    box(ctx, P, -0.3, -0.3, 0.6, 0.6, 0.2, shade(TH.steel, 0.9), 0.5);
    const piv = P(0, 0, 0.72); const ph = (t * 0.4) % 1;
    const sh = -1.15 + 0.42 * Math.sin(ph * 6.283), el = 1.2 + 0.55 * Math.cos(ph * 6.283);
    const L1 = s * 1.7, L2 = s * 1.35;
    const j1 = { x: piv.x + Math.cos(sh) * L1, y: piv.y + Math.sin(sh) * L1 };
    const end = { x: j1.x + Math.cos(sh + el) * L2, y: j1.y + Math.sin(sh + el) * L2 };
    box(ctx, P, -0.28, -0.28, 0.56, 0.56, 0.9, shade(TH.steel, 0.92));
    if (detail) { box(ctx, P, 1.0, 0.5, 0.8, 0.8, 0.15, shade(TH.steel, 0.8)); box(ctx, P, -1.8, -0.4, 0.9, 0.5, 0.2, TH.work); }
    ctx.lineCap = "round"; ctx.strokeStyle = TH.outline; ctx.lineWidth = 13; ctx.beginPath(); ctx.moveTo(piv.x, piv.y); ctx.lineTo(j1.x, j1.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    ctx.strokeStyle = TH.arm1; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(piv.x, piv.y); ctx.lineTo(j1.x, j1.y); ctx.stroke();
    ctx.strokeStyle = TH.arm2; ctx.lineWidth = 7; ctx.beginPath(); ctx.moveTo(j1.x, j1.y); ctx.lineTo(end.x, end.y); ctx.stroke();
    [piv, j1].forEach((j) => { ctx.fillStyle = TH.joint; ctx.strokeStyle = TH.outline; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(j.x, j.y, 6, 0, 7); ctx.fill(); ctx.stroke(); });
    const grab = (ph > 0.42 && ph < 0.9); const gw = grab ? 4 : 9;
    ctx.strokeStyle = TH.arm2; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(end.x - gw, end.y - 6); ctx.lineTo(end.x - gw, end.y + 6); ctx.moveTo(end.x + gw, end.y - 6); ctx.lineTo(end.x + gw, end.y + 6); ctx.stroke();
    if (grab) { ctx.fillStyle = TH.work; ctx.strokeStyle = TH.outline; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(end.x - 6, end.y - 4, 12, 13, 2); ctx.fill(); ctx.stroke(); }
  } else if (kind === "conveyor") {
    box(ctx, P, -1.7, -0.35, 3.4, 0.7, 0.45, TH.steel);
    const TL = P(-1.7, -0.35, 0.48), TR = P(1.7, -0.35, 0.48), BL = P(-1.7, 0.35, 0.48), BR = P(1.7, 0.35, 0.48);
    const p = (u: number, v: number) => ({ x: (TL.x + (TR.x - TL.x) * u) + ((BL.x + (BR.x - BL.x) * u) - (TL.x + (TR.x - TL.x) * u)) * v, y: (TL.y + (TR.y - TL.y) * u) + ((BL.y + (BR.y - BL.y) * u) - (TL.y + (TR.y - TL.y) * u)) * v });
    for (let i = 0; i < 12; i++) { const u = ((i / 12) + (t * 0.14)) % 1; ctx.strokeStyle = shade(TH.steel, 0.72); ctx.lineWidth = 2; const a = p(u, 0.25), b = p(u, 0.75), c = p((u + 0.04) % 1, 0.5); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(c.x, c.y); ctx.lineTo(b.x, b.y); ctx.stroke(); }
    const nP = detail ? 4 : 3;
    for (let i = 0; i < nP; i++) { const u = ((t * 0.16) + i / nP) % 1; const c = p(u, 0.5); glow(ctx, c.x, c.y - 6, s * 0.4, TH.fire, 0.35); ctx.fillStyle = TH.work; ctx.strokeStyle = TH.outline; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(c.x - 7, c.y - 16, 14, 14, 2); ctx.fill(); ctx.stroke(); }
  } else if (kind === "semi_process_chamber") {
    box(ctx, P, -0.9, -0.9, 1.8, 1.8, 1.7, TH.steel);
    const wc = P(0, -0.9, 1.0); const br = 0.5 + 0.5 * Math.sin(t * 3);
    glow(ctx, wc.x, wc.y, s * 1.0, TH.plasma, 0.5 * br + 0.2);
    ctx.fillStyle = shade(TH.glass, 0.85); ctx.strokeStyle = TH.outline; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(wc.x, wc.y, s * 0.52, 0, 7); ctx.fill(); ctx.stroke();
    const nd = detail ? 14 : 6;
    for (let i = 0; i < nd; i++) { const a = t * 1.5 + i * (6.283 / nd); const rr = s * 0.32 * (0.5 + 0.5 * Math.sin(t * 2 + i)); ctx.fillStyle = TH.plasma; ctx.globalAlpha = 0.5 + 0.4 * br; ctx.beginPath(); ctx.arc(wc.x + Math.cos(a) * rr, wc.y + Math.sin(a) * rr, 2.4, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
    box(ctx, P, 0.95, -0.4, 0.45, 0.45, 0.7, shade(TH.steel, 0.85));
  } else if (kind === "heat_treat_furnace") {
    box(ctx, P, -1.0, -1.0, 2.0, 2.0, 1.7, shade(TH.steel, 0.95));
    const dc = P(0, -1.0, 0.85); const br = 0.55 + 0.45 * Math.sin(t * 2.5);
    glow(ctx, dc.x, dc.y, s * 1.1, TH.fire, 0.5 * br + 0.2);
    ctx.fillStyle = TH.fire; ctx.globalAlpha = 0.5 + 0.5 * br; ctx.beginPath(); ctx.roundRect(dc.x - s * 0.42, dc.y - s * 0.42, s * 0.84, s * 0.84, 4); ctx.fill(); ctx.globalAlpha = 1;
    if (detail) for (let i = 0; i < 7; i++) { const fl = 0.5 + 0.5 * Math.sin(t * 6 + i); ctx.fillStyle = i % 2 ? "#f0a03c" : TH.fire; ctx.globalAlpha = 0.6; const fx = dc.x - s * 0.3 + i * s * 0.1; ctx.beginPath(); ctx.moveTo(fx, dc.y + s * 0.3); ctx.quadraticCurveTo(fx - 4, dc.y - fl * s * 0.2, fx, dc.y - s * 0.15 - fl * s * 0.2); ctx.quadraticCurveTo(fx + 4, dc.y - fl * s * 0.2, fx, dc.y + s * 0.3); ctx.fill(); }
    ctx.globalAlpha = 1;
    const nh = detail ? 10 : 6;
    for (let i = 0; i < nh; i++) { const pp = (t * 0.6 + i / nh) % 1; const tp = P(0.9, -0.7, 1.7); ctx.fillStyle = TH.fire; ctx.globalAlpha = (1 - pp) * 0.35; ctx.beginPath(); ctx.arc(tp.x + Math.sin(i + t) * 6, tp.y - pp * s * 1.3, 3 + pp * 3, 0, 7); ctx.fill(); }
    ctx.globalAlpha = 1;
  } else if (kind === "wind_turbine") {
    box(ctx, P, -0.16, -0.16, 0.32, 0.32, 3.2, shade(TH.steel, 1.05));
    const hub = P(0, 0, 3.3); box(ctx, P, -0.3, -0.16, 0.6, 0.32, 0.4, shade(TH.steel, 0.9), 3.1);
    ctx.save(); ctx.translate(hub.x, hub.y);
    for (let i = 0; i < 3; i++) { const a = t * 1.8 + i * 2.094; ctx.strokeStyle = TH.outline; ctx.lineCap = "round"; ctx.lineWidth = 8; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * s * 1.6, Math.sin(a) * s * 1.6); ctx.stroke(); ctx.strokeStyle = shade(TH.steel, 1.15); ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * s * 1.6, Math.sin(a) * s * 1.6); ctx.stroke(); }
    ctx.fillStyle = TH.joint; ctx.beginPath(); ctx.arc(0, 0, 6, 0, 7); ctx.fill(); ctx.restore();
  } else if (kind === "agv_mobile_robot") {
    const bob = Math.sin(t * 2) * 0.05;
    box(ctx, P, -0.9, -0.6, 1.8, 1.2, 0.4 + bob, TH.steel);
    box(ctx, P, -0.55, -0.35, 1.1, 0.7, 0.7 + bob, TH.work, 0.4 + bob);
    const lt = P(0.9, 0, 0.5 + bob); glow(ctx, lt.x, lt.y, s * 0.4, TH.screen, 0.6); ctx.fillStyle = TH.screen; ctx.beginPath(); ctx.arc(lt.x, lt.y, s * 0.09, 0, 7); ctx.fill();
    if (detail) { const sc = P(0, -0.6, 0.5); ctx.save(); ctx.strokeStyle = TH.screen; const sweep = (t * 2) % 6.283; ctx.beginPath(); ctx.moveTo(sc.x, sc.y); ctx.arc(sc.x, sc.y, s * 1.4, sweep, sweep + 0.5); ctx.closePath(); ctx.fillStyle = TH.screen; ctx.globalAlpha = 0.14; ctx.fill(); ctx.globalAlpha = 1; ctx.restore(); }
  } else if (kind === "air_compressor") {
    box(ctx, P, -1.1, -0.5, 1.5, 1.0, 1.0, TH.steel);
    box(ctx, P, 0.4, -0.45, 0.55, 0.9, 1.0, shade(TH.steel, 0.88)); const fc = P(0.67, 0, 0.6);
    ctx.save(); ctx.translate(fc.x, fc.y - 4); for (let i = 0; i < 4; i++) { const a = t * 8 + i * 1.5708; ctx.strokeStyle = TH.outline; ctx.lineCap = "round"; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * s * 0.42, Math.sin(a) * s * 0.26); ctx.stroke(); } ctx.restore();
    const pl = P(-1.0, 0, 1.1); const br = 0.5 + 0.5 * Math.sin(t * 4); glow(ctx, pl.x, pl.y, s * 0.3, TH.screen, 0.5 * br); ctx.fillStyle = TH.screen; ctx.globalAlpha = 0.5 + 0.5 * br; ctx.beginPath(); ctx.arc(pl.x, pl.y, s * 0.08, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
  } else if (kind === "stamping_press") {
    box(ctx, P, -1.0, -0.7, 0.35, 1.4, 2.4, shade(TH.steel, 0.95)); box(ctx, P, 0.65, -0.7, 0.35, 1.4, 2.4, shade(TH.steel, 0.95));
    box(ctx, P, -1.0, -0.7, 2.0, 1.4, 0.35, TH.steel, 2.4);
    const sl = Math.abs(Math.sin(t * 2));
    box(ctx, P, -0.5, -0.4, 1.0, 0.8, 0.4, shade(TH.steel, 0.82), 0.4 + sl * 1.2);
    box(ctx, P, -0.7, -0.5, 1.4, 1.0, 0.4, TH.steel);
    if (sl < 0.12) { const ic = P(0, 0, 0.7); glow(ctx, ic.x, ic.y, s * 0.7, TH.spark, 0.6); }
  } else if (kind === "injection_molding") {
    box(ctx, P, -1.4, -0.5, 0.9, 1.0, 1.2, TH.steel); const op = Math.abs(Math.sin(t * 1.6)) * 0.5;
    box(ctx, P, -0.4 - op, -0.5, 0.35, 1.0, 1.1, shade(TH.steel, 0.9)); box(ctx, P, 0.1 + op, -0.5, 0.35, 1.0, 1.1, shade(TH.steel, 0.9));
    box(ctx, P, 0.5, -0.3, 1.0, 0.6, 0.6, shade(TH.steel, 0.86), 0.4);
    const hz = P(1.0, 0, 0.7); glow(ctx, hz.x, hz.y, s * 0.5, TH.fire, 0.4 + 0.3 * Math.sin(t * 4));
    box(ctx, P, 1.2, -0.2, 0.4, 0.4, 0.5, TH.work, 0.9);
  } else if (kind === "energy_meter") {
    box(ctx, P, -0.7, -0.5, 1.4, 1.0, 1.6, TH.steel);
    const pc = P(0, -0.5, 1.0); ctx.fillStyle = shade(TH.screen, 0.4); ctx.fillRect(pc.x - s * 0.4, pc.y - s * 0.3, s * 0.8, s * 0.5);
    ctx.fillStyle = TH.screen; ctx.font = `600 ${s * 0.28}px 'JetBrains Mono',monospace`; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText((3.2 + Math.sin(t * 2) * 0.3).toFixed(1) + "kW", pc.x, pc.y - s * 0.05); ctx.textAlign = "left";
    ["#c85a4a", "#d9a441", "#5a9e5a"].forEach((c, i) => { const b = 0.5 + 0.5 * Math.sin(t * 4 + i * 2); const dp = P(-0.4 + i * 0.4, -0.5, 0.5); ctx.fillStyle = c; ctx.globalAlpha = 0.4 + 0.6 * b; ctx.beginPath(); ctx.arc(dp.x, dp.y, s * 0.07, 0, 7); ctx.fill(); }); ctx.globalAlpha = 1;
  } else {
    box(ctx, P, -0.8, -0.8, 1.6, 1.6, 1.4, TH.steel);
  }
}

// ── 訊號規格:從 telemetry tag 挑值 ────────────────────────
const SIG_SPECS: { label: string; unit: string; cands: string[]; thr: number }[] = [
  { label: "振動 RMS", unit: "mm/s", cands: ["vibration_rms"], thr: 6 },
  { label: "主軸/馬達電流", unit: "A", cands: ["spindle_current", "motor_current", "vacuum_pump_current", "element_current"], thr: 14 },
  { label: "溫度", unit: "°C", cands: ["spindle_temp", "motor_temp", "chamber_temp", "die_temp", "oil_temp", "pump_temp", "temp_uniformity"], thr: 90 },
];
function pickTag(tags: Record<string, number>, cands: string[]): [string, number] | null {
  for (const c of cands) if (c in tags) return [c, tags[c]];
  return null;
}

export default function DeviceDetailModal({ deviceId, snapshot, company, onClose }:
  { deviceId: string; snapshot: DeviceSnapshot; company?: string; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number>(0);
  const kind = snapshot.template;
  const histRef = useRef<number[]>([]);

  // 累積振動趨勢(接真實 telemetry;每次 snapshot 變動追加一點)
  const vib = snapshot.tags?.vibration_rms;
  useEffect(() => {
    if (typeof vib === "number") { const h = histRef.current; h.push(vib); if (h.length > 48) h.splice(0, h.length - 48); }
  }, [vib]);

  // Canvas 動畫(僅開啟時 mount/ticker)
  useEffect(() => {
    const cv = canvasRef.current; if (!cv) return;
    const ctx = cv.getContext("2d"); if (!ctx) return;
    let w = 0, h = 0;
    const dpr = Math.min(1.75, window.devicePixelRatio || 1);
    const resize = () => { const r = cv.getBoundingClientRect(); if (!r.width) return; w = r.width; h = r.height; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); };
    resize(); window.addEventListener("resize", resize);
    const t0 = performance.now();
    const frame = (now: number) => {
      const t = (now - t0) / 1000;
      ctx.clearRect(0, 0, w, h);
      // 詳細動畫(detail=true)+ 右下角趨勢
      machine(ctx, w / 2, h * 0.60, Math.min(w, h) / 6.2, t, kind, true);
      // 趨勢:振動 RMS 折線(左下)
      const hist = histRef.current;
      if (hist.length > 1) {
        const gw = Math.min(220, w * 0.42), gh = 52, gx = 18, gy = h - gh - 16;
        ctx.fillStyle = "rgba(255,250,240,.7)"; ctx.strokeStyle = TH.outline; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(gx - 8, gy - 20, gw + 16, gh + 28, 10); ctx.fill(); ctx.stroke();
        ctx.fillStyle = "#a2917a"; ctx.font = "11px 'JetBrains Mono',monospace"; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillText("振動 RMS 趨勢", gx, gy - 6);
        const mn = Math.min(...hist) - 0.3, mx = Math.max(...hist) + 0.3, rng = Math.max(0.5, mx - mn);
        ctx.strokeStyle = TH.arm1; ctx.lineWidth = 2; ctx.lineJoin = "round"; ctx.beginPath();
        hist.forEach((v, i) => { const x = gx + i / (hist.length - 1) * gw; const y = gy + gh - ((v - mn) / rng) * gh; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
        ctx.stroke();
      }
    };
    const loop = (now: number) => { frame(now); rafRef.current = requestAnimationFrame(loop); };
    rafRef.current = requestAnimationFrame(loop);
    return () => { cancelAnimationFrame(rafRef.current); window.removeEventListener("resize", resize); };
  }, [kind]);

  // Esc 關閉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const tags = snapshot.tags || {};
  const signals = SIG_SPECS.map((sp) => {
    const hit = pickTag(tags, sp.cands); if (!hit) return null;
    const [, val] = hit; const over = val > sp.thr;
    const col = sp.label.startsWith("振動") ? (over ? TH.fault : TH.ok) : (over ? TH.pred : "#5a4c36");
    return { label: sp.label, val, unit: sp.unit, color: col, pct: Math.max(4, Math.min(96, (val / (sp.thr * 1.4)) * 100)) };
  }).filter(Boolean) as { label: string; val: number; unit: string; color: string; pct: number }[];

  const regs = Object.entries(tags).filter(([k]) => k !== "state").slice(0, 8);
  const discretes = Object.entries(snapshot.discretes || {});
  const stColor = stateColor(snapshot.state);

  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 90, background: "rgba(50,38,22,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: "3vh 2vw", animation: "fadeIn .18s ease" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(1120px,96vw)", height: "min(680px,92vh)", background: "var(--panel)", borderRadius: 20, boxShadow: "var(--shadow-modal)", display: "flex", flexDirection: "column", overflow: "hidden", border: "1px solid var(--line)" }}>
        {/* 頭列 */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "16px 20px", borderBottom: "1px solid var(--line)" }}>
          <span className="mono" style={{ fontSize: 20, fontWeight: 700, color: "var(--text)" }}>{deviceId}</span>
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>{KIND_NAME[kind] || kind}</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: stColor, padding: "3px 12px", borderRadius: 20 }}>{STATE_LABEL[snapshot.state] || snapshot.state}</span>
          {company && <span style={{ fontSize: 12, color: "var(--dim)" }}>· {company}</span>}
          <div style={{ flex: 1 }} />
          <span onClick={onClose} title="關閉 (Esc)" style={{ width: 34, height: 34, borderRadius: 9, background: "var(--accent-tint)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 17, fontWeight: 600, color: "var(--muted)", cursor: "pointer" }}>✕</span>
        </div>
        {/* 主體 */}
        <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
          <div style={{ flex: 1, position: "relative", minWidth: 0, background: "radial-gradient(120% 90% at 50% 20%,#faf4e8,#efe4d0)" }}>
            <canvas ref={canvasRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }} />
            <div style={{ position: "absolute", right: 16, bottom: 16, fontSize: 12, color: "var(--dim)", background: "rgba(255,250,240,.7)", padding: "6px 12px", borderRadius: 8 }}>{KIND_DESC[kind] || "合成數據 · 詳細動畫"}</div>
          </div>
          {/* 右側面板 */}
          <aside style={{ width: 340, flex: "0 0 340px", background: "var(--panel)", borderLeft: "1px solid var(--line)", padding: 20, overflowY: "auto" }}>
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

function SecLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontFamily: "var(--font-serif)", fontSize: 11, letterSpacing: ".4px", color: "var(--dim)", marginBottom: 10, fontWeight: 600 }}>{children}</div>;
}
