import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Text, FillGradient } from "pixi.js";
import { Park, Company, TelemetryMsg, colorOf, worstState } from "../api";

// ── 俯瞰格狀佈局 ───────────────────────────────────────
// STEP 拉大 → 公司間距更寬、道路更寬敞;GRID 隨之放大,俯瞰縮放在 recenter 自動配合。
const COLS = 6, STEP = 5, GRID = 32;
const HW = 18, HH = 9, CX = GRID / 2, CY = GRID / 2;

function iso(gx: number, gy: number) {
  const rx = gx - CX, ry = gy - CY;
  return { x: (rx - ry) * HW, y: (rx + ry) * HH };
}
function companyTile(i: number) { return { gx: 3 + (i % COLS) * STEP, gy: 3 + Math.floor(i / COLS) * STEP }; }
function isRoad(gx: number, gy: number) { return (gx - 1) % STEP === 0 || (gy - 1) % STEP === 0; }
function mulberry32(seed: number) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function darken(c: number, f: number) {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return ((Math.min(255, r * f) | 0) << 16) | ((Math.min(255, g * f) | 0) << 8) | (Math.min(255, b * f) | 0);
}
// 徑向發光(核心 + 兩層柔光暈):用於主軸 / 電漿 / 爐火 / LED 等「亮起來」的細節
function emissive(g: Graphics, cx: number, cy: number, r: number, color: number, a = 1) {
  g.circle(cx, cy, r * 2.7).fill({ color, alpha: 0.06 * a });
  g.circle(cx, cy, r * 1.7).fill({ color, alpha: 0.12 * a });
  g.circle(cx, cy, r).fill({ color, alpha: Math.min(1, 0.92 * a) });
}

// ── 等距金屬量體(移植設計稿 box():三面線性漸層 + 頂面亮邊)────────────
const MTW = 30, MTH = 15;   // 機台等距 tile(設計稿數值)
type P2 = [number, number];
function lgrad(x0: number, y0: number, x1: number, y1: number, c0: number, c1: number): FillGradient {
  return new FillGradient({ type: "linear", start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, textureSpace: "global",
    colorStops: [{ offset: 0, color: c0 }, { offset: 1, color: c1 }] });
}
function rgrad(cx: number, cy: number, r: number, core: string): FillGradient {
  return new FillGradient({ type: "radial", center: { x: cx, y: cy }, innerRadius: 0,
    outerCenter: { x: cx, y: cy }, outerRadius: r, textureSpace: "global",
    colorStops: [{ offset: 0, color: core }, { offset: 1, color: "rgba(0,0,0,0)" }] });
}
// 等距立方體:anchor=(ox,oy) 為地面原點角;w/d/h 為寬/深/高。三面各一漸層。
function isoBox3(g: Graphics, ox: number, oy: number, w: number, d: number, h: number, pal: { top: number; left: number; right: number }) {
  const A: P2 = [ox, oy], B: P2 = [ox + w * MTW, oy + w * MTH], C: P2 = [ox + w * MTW - d * MTW, oy + w * MTH + d * MTH], D: P2 = [ox - d * MTW, oy + d * MTH];
  const up = (p: P2): P2 => [p[0], p[1] - h];
  const Au = up(A), Bu = up(B), Cu = up(C), Du = up(D);
  g.poly([D[0], D[1], C[0], C[1], Cu[0], Cu[1], Du[0], Du[1]]).fill(lgrad(Du[0], Du[1], C[0], C[1], darken(pal.left, 1.18), darken(pal.left, 0.82)));   // 左面
  g.poly([C[0], C[1], B[0], B[1], Bu[0], Bu[1], Cu[0], Cu[1]]).fill(lgrad(Cu[0], Cu[1], B[0], B[1], darken(pal.right, 1.12), darken(pal.right, 0.88))); // 右面
  g.poly([Au[0], Au[1], Bu[0], Bu[1], Cu[0], Cu[1], Du[0], Du[1]]).fill(lgrad(Au[0], Au[1], Cu[0], Cu[1], darken(pal.top, 1.1), darken(pal.top, 0.95)))
    .stroke({ width: 1, color: darken(pal.top, 1.4) });                                                                                                // 頂面 + 亮邊
  return { A, B, C, D, Au, Bu, Cu, Du };
}
function ishadow(g: Graphics, cx: number, cy: number, rx: number, ry: number, a: number) {
  g.ellipse(cx, cy, rx, ry).fill(rgrad(cx, cy, rx, `rgba(0,0,0,${a})`));
}
function iglow(g: Graphics, cx: number, cy: number, r: number, core: string) {
  g.ellipse(cx, cy, r, r).fill(rgrad(cx, cy, r, core));
}

// ── 各機台繪法(移植設計稿 mCNC/mArm/… anchor=(ox,oy) 地面原點)──────────
function mCNC(g: Graphics, ox: number, oy: number, t: number, running: boolean, fault: boolean) {
  ishadow(g, ox + 0.3 * MTW, oy + 1.6 * MTH, 64, 30, 0.4);
  const pal = fault ? { top: 0x5a4750, left: 0x33232a, right: 0x3f2c34 } : { top: 0x3d4d66, left: 0x232d3d, right: 0x2f3b50 };
  isoBox3(g, ox, oy, 2.4, 2.2, 42, pal);
  isoBox3(g, ox + 0.2 * MTW, oy + 0.2 * MTH - 42, 1.7, 1.5, 24, { top: 0x324058, left: 0x1c2432, right: 0x28324a });
  isoBox3(g, ox + 2.55 * MTW, oy + 2.4 * MTH, 0.55, 0.55, 36, { top: 0x4a5c7e, left: 0x2b3648, right: 0x39465e });
  const pcx = ox + 2.8 * MTW, pcy = oy + 2.8 * MTH - 24;
  g.rect(pcx - 6, pcy - 8, 13, 10).fill(running ? 0x123a28 : 0x241a1a);
  g.rect(pcx - 4, pcy - 5, 9, 2).fill(running ? 0x4fd08a : 0xe0503f);
  g.poly([ox + 1.9 * MTW, oy + 1.9 * MTH - 8, ox + 1.0 * MTW, oy + 2.9 * MTH - 8, ox + 1.0 * MTW, oy + 2.9 * MTH - 30, ox + 1.9 * MTW, oy + 1.9 * MTH - 30])
    .fill({ color: 0x14283a, alpha: 0.85 }).stroke({ width: 1.2, color: 0x4a6078 });   // 觀景窗
  const cx = ox + 1.45 * MTW, cy = oy + 1.55 * MTH - 16;
  if (running) iglow(g, cx, cy + 6, 20, "rgba(255,212,120,0.5)");
  const spin = running ? t * 10 : 0, off = Math.cos(spin) * 5;
  g.moveTo(cx - off, cy).lineTo(cx + off, cy + 10).stroke({ width: 3, color: running ? 0xffd479 : 0x7a8598, cap: "round" });
  if (running) for (let i = 0; i < 5; i++) { const a = (t * 8 + i * 0.2) % 1; g.rect(cx + (i - 2) * 2, cy + 10 + a * 10, 1.5, 1.5).fill({ color: 0xbfe6ff, alpha: 1 - a }); }
}
function mInjection(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.2 * MTW, oy + 1.4 * MTH, 60, 28, 0.4);
  isoBox3(g, ox, oy, 1.4, 1.8, 34, { top: 0x3f5147, left: 0x212c26, right: 0x2c3a33 });
  const clamp = running ? (0.5 + 0.5 * Math.sin(t * 2.2)) : 1;
  isoBox3(g, ox + 1.5 * MTW, oy + 1.5 * MTH, 1.8, 0.9, 20, { top: 0x46506a, left: 0x262d3d, right: 0x333c52 });
  isoBox3(g, ox + 2.3 * MTW, oy + 2.3 * MTH - 20, 0.5, 0.5, 14, { top: 0x5b6b8e, left: 0x333c52, right: 0x414d68 });
  if (running) iglow(g, ox + 2.0 * MTW, oy + 2.0 * MTH - 6, 22, "rgba(255,140,60,0.55)");
  g.rect(ox + 0.6 * MTW - clamp * 10, oy + 0.5 * MTH - 24, 7, 20).fill(0x6a8073);
  g.rect(ox + 0.9 * MTW, oy + 0.7 * MTH - 24, 7, 20).fill(0x54685c);
  if (running && clamp > 0.8) iglow(g, ox + 0.6 * MTW, oy + 0.9 * MTH - 6, 10, "rgba(255,200,120,0.6)");
}
function mArm(g: Graphics, ox: number, oy: number, t: number, pickup: P2, drop: P2) {
  ishadow(g, ox, oy + 0.2 * MTH, 42, 20, 0.42);
  isoBox3(g, ox - 0.7 * MTW, oy + 0.7 * MTH, 1.4, 1.4, 16, { top: 0x46587a, left: 0x28324a, right: 0x35435e });
  const base: P2 = [ox, oy - 14];
  g.ellipse(base[0], base[1] + 4, 14, 7).fill(0x3a4660);
  const p = (t % 4.5) / 4.5; let tx: number, ty: number, carry = false;
  const es = (f: number) => f * f * (3 - 2 * f);
  if (p < 0.4) { const f = es(p / 0.4); tx = drop[0] + (pickup[0] - drop[0]) * f; ty = drop[1] + (pickup[1] - drop[1]) * f; }
  else if (p < 0.5) { tx = pickup[0]; ty = pickup[1]; carry = p >= 0.45; }
  else if (p < 0.92) { const f = es((p - 0.5) / 0.42); tx = pickup[0] + (drop[0] - pickup[0]) * f; ty = pickup[1] + (drop[1] - pickup[1]) * f; carry = true; }
  else { tx = drop[0]; ty = drop[1]; }
  const { joint, end } = solveArm(base[0], base[1], tx, ty, 42, 34);
  g.moveTo(base[0], base[1]).lineTo(joint.x, joint.y).stroke({ width: 11, color: 0xf0883c, cap: "round" });      // 大臂橘
  g.moveTo(base[0], base[1]).lineTo(joint.x, joint.y).stroke({ width: 4, color: darken(0xf0883c, 1.25), cap: "round" });
  g.moveTo(joint.x, joint.y).lineTo(end.x, end.y).stroke({ width: 7, color: 0xcdd9ec, cap: "round" });           // 小臂銀
  g.circle(base[0], base[1], 6).fill(0x5b9bd5).stroke({ width: 1.5, color: 0x1c2432 });
  g.circle(joint.x, joint.y, 5).fill(0x5b9bd5).stroke({ width: 1.5, color: 0x1c2432 });
  const d = Math.atan2(end.y - joint.y, end.x - joint.x), gap = carry ? 3 : 6;
  const nx = Math.cos(d + Math.PI / 2) * gap, ny = Math.sin(d + Math.PI / 2) * gap;
  g.moveTo(end.x, end.y).lineTo(end.x + nx + Math.cos(d) * 7, end.y + ny + Math.sin(d) * 7).stroke({ width: 3, color: 0x8a93a6 });
  g.moveTo(end.x, end.y).lineTo(end.x - nx + Math.cos(d) * 7, end.y - ny + Math.sin(d) * 7).stroke({ width: 3, color: 0x8a93a6 });
  if (carry) { g.rect(end.x - 5, end.y - 3, 11, 9).fill(0xd9a441); g.rect(end.x - 5, end.y - 3, 11, 3).fill(0xf0c674); }
}
function mCompressor(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.3 * MTW, oy + 1.2 * MTH, 52, 24, 0.4);
  isoBox3(g, ox, oy, 2.2, 1.3, 26, { top: 0x3f5147, left: 0x212c26, right: 0x2c3a33 });
  isoBox3(g, ox + 1.6 * MTW, oy + 1.6 * MTH - 26, 0.7, 0.7, 20, { top: 0x46506a, left: 0x262d3d, right: 0x333c52 });
  const fx = ox + 0.2 * MTW, fy = oy + 0.7 * MTH - 13, rot = running ? t * 6 : 0;
  for (let i = 0; i < 4; i++) { const a = rot + i * Math.PI / 2; g.moveTo(fx, fy).lineTo(fx + Math.cos(a) * 9, fy + Math.sin(a) * 9).stroke({ width: 2.5, color: running ? 0x9fe0c0 : 0x6b7488, cap: "round" }); }
  g.circle(fx, fy, 2.5).fill(0x8a93a6);
  const gz = running ? 0.5 + 0.4 * Math.abs(Math.sin(t * 3)) : 0.2;
  g.circle(ox + 1.9 * MTW, oy + 1.9 * MTH - 26, 3).fill({ color: running ? 0x6cf0a0 : 0x3a6b50, alpha: gz });
}
function mTurbine(g: Graphics, ox: number, oy: number, t: number, rpm: number) {
  ishadow(g, ox, oy + 0.1 * MTH, 20, 10, 0.35);
  g.poly([ox - 3, oy, ox + 3, oy, ox + 1.5, oy - 64, ox - 1.5, oy - 64]).fill(lgrad(ox - 3, oy, ox + 3, oy, 0xaeb9c8, 0x7f8b9c));  // 塔
  g.rect(ox - 5, oy - 70, 15, 7).fill(0x9fb0c4);
  const hx = ox - 5, hy = oy - 66, rot = t * (0.5 + (rpm || 8) * 0.08);
  for (let i = 0; i < 3; i++) { const a = rot + i * 2 * Math.PI / 3; g.moveTo(hx, hy).lineTo(hx + Math.cos(a) * 26, hy + Math.sin(a) * 26).stroke({ width: 3.5, color: 0xeef3f9, cap: "round" }); }
  g.circle(hx, hy, 3.5).fill(0x5b9bd5);
}
function mChamber(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.2 * MTW, oy + 1.3 * MTH, 52, 24, 0.4);
  isoBox3(g, ox, oy, 2.0, 1.8, 34, { top: 0x37425c, left: 0x1f2838, right: 0x2b344a });
  const vx = ox + 0.5 * MTW, vy = oy + 1.3 * MTH - 14;
  const gz = running ? 0.5 + 0.4 * Math.abs(Math.sin(t * 3)) : 0.12;
  if (running) iglow(g, vx, vy, 22, `rgba(150,110,220,${gz})`);
  g.circle(vx, vy, 10).fill({ color: running ? 0x8f6bd6 : 0x2f3a52, alpha: running ? 0.85 : 1 });
  g.circle(vx, vy, 10).stroke({ width: 2.5, color: 0x6b7da0 });
  g.moveTo(ox + 0.5 * MTW, oy + 0.5 * MTH - 34).lineTo(ox + 0.5 * MTW, oy + 0.5 * MTH - 48).stroke({ width: 3, color: 0x9fb0c4 });   // 氣管
  isoBox3(g, ox + 1.8 * MTW, oy + 1.8 * MTH, 0.6, 0.6, 12, { top: 0x2b3648, left: 0x1a2230, right: 0x232d3d });   // 真空泵
}
function mMeter(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.1 * MTW, oy + 0.9 * MTH, 40, 20, 0.38);
  isoBox3(g, ox, oy, 1.5, 1.2, 40, { top: 0x394a40, left: 0x1e2a24, right: 0x28362f });
  const px = ox + 0.75 * MTW, py = oy + 0.4 * MTH - 26;
  g.rect(px - 13, py - 2, 26, 12).fill(0x0c2a18).stroke({ width: 1, color: 0x1e4230 });
  g.rect(px - 10, py + 2, running ? 18 : 6, 2).fill(running ? 0x6cf0a0 : 0x3a6b50);   // 讀數(以亮條代文字)
  for (let i = 0; i < 3; i++) { const on = running && Math.sin(t * 4 + i * 2) > -0.2; const cc = [0xff6b6b, 0xffd479, 0x6cf0a0][i];
    if (on) emissive(g, px - 8 + i * 8, py + 16, 2.6, cc, 0.9); else g.circle(px - 8 + i * 8, py + 16, 2.6).fill(0x46506a); }
}
function mPress(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.1 * MTW, oy + 1.0 * MTH, 44, 22, 0.4);
  isoBox3(g, ox, oy, 0.6, 1.6, 52, { top: 0x3a4658, left: 0x212a38, right: 0x2c3648 });       // 立柱
  isoBox3(g, ox, oy - 52, 2.2, 1.6, 10, { top: 0x46587a, left: 0x28324a, right: 0x35435e });   // 上樑
  isoBox3(g, ox + 1.4 * MTW, oy + 1.4 * MTH, 1.0, 0.6, 12, { top: 0x324058, left: 0x1c2432, right: 0x28324a });  // 工作台
  const press = running ? Math.abs(Math.sin(t * 5)) : 0.15;
  const slx = ox + 1.55 * MTW, sly = oy + 0.4 * MTH - 40 + press * 26;
  g.rect(slx, sly, 20, 12).fill(lgrad(slx, sly, slx, sly + 12, 0x9aa4b6, 0x5b6b8e)).stroke({ width: 1, color: 0x3a4658 });   // 滑塊
  g.rect(slx + 3, oy + 1.0 * MTH - 6, 14, 4).fill(running ? 0xffd479 : 0x6b7488);
  if (running && press > 0.85) iglow(g, slx + 10, oy + 1.0 * MTH - 4, 12, "rgba(255,220,140,0.7)");
}
function mFurnace(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.2 * MTW, oy + 1.3 * MTH, 52, 24, 0.4);
  isoBox3(g, ox, oy, 2.0, 1.7, 34, { top: 0x4a4034, left: 0x2a231b, right: 0x372e24 });
  const dx = ox + 0.55 * MTW, dy = oy + 1.2 * MTH - 14;
  const heat = running ? 0.5 + 0.4 * Math.abs(Math.sin(t * 2)) : 0.1;
  if (running) iglow(g, dx, dy, 24, `rgba(255,120,50,${heat})`);
  g.rect(dx - 11, dy - 10, 22, 20).fill({ color: running ? 0xff7a3a : 0x3a2a22, alpha: running ? 0.9 : 1 }).stroke({ width: 2, color: 0x6b5036 });  // 爐門
  g.moveTo(ox + 1.7 * MTW, oy + 1.7 * MTH - 34).lineTo(ox + 1.7 * MTW, oy + 1.7 * MTH - 52).stroke({ width: 3.5, color: 0x9fb0c4 });   // 排氣管
  if (running) { const sy = (t * 20) % 30; g.circle(ox + 1.7 * MTW, oy + 1.7 * MTH - 52 - sy, 3 + sy * 0.1).fill({ color: 0xc9b8a0, alpha: 0.3 * (1 - sy / 30) }); }
}
function mAGV(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  const bob = running ? Math.sin(t * 3) * 1 : 0;
  ishadow(g, ox, oy + 0.1 * MTH, 30, 15, 0.4);
  isoBox3(g, ox - 0.7 * MTW, oy + 0.7 * MTH - bob, 1.4, 1.0, 12, { top: 0x4a8a7b, left: 0x274a42, right: 0x356156 });
  g.rect(ox - 6, oy - 20 - bob, 12, 8).fill(0xd9a441); g.rect(ox - 6, oy - 20 - bob, 12, 2.5).fill(0xf0c674);   // 貨件
  const on = Math.sin(t * 6) > 0; g.circle(ox + 0.7 * MTW - 4, oy + 0.7 * MTH - 8 - bob, 2).fill(on ? 0x6cf0a0 : 0x2a4a3a);   // 狀態燈
}
const ROOFS = [0x3a4a63, 0x4a4036, 0x394f4a, 0x44485a, 0x53473a, 0x35506b, 0x4d3f4a];
// 公司建築多彩色盤(較飽和,讓園區有大有小、多彩)
const COMPANY_COLORS = [0x3f6ea5, 0x4a8a7b, 0xb5743a, 0x7a5ca8, 0x4f9d5b, 0xa85a6a,
  0x3a8fb0, 0xb0883e, 0x5a6bb0, 0x9a5040, 0x4aa0a0, 0x8e6fb5];

function isoBox(g: Graphics, gx: number, gy: number, w: number, h: number, height: number, roof: number) {
  const N = iso(gx, gy), E = iso(gx + w, gy), S = iso(gx + w, gy + h), W = iso(gx, gy + h);
  const up = (p: Pt, f = 1) => ({ x: p.x, y: p.y - height * f });
  const lerp2 = (a: Pt, b: Pt, f: number) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
  // 接地陰影:footprint 往右下位移(光源固定左上),長度隨高度 → 建築坐在地上、有量體感
  const sdx = Math.min(height * 0.14, 9), sdy = Math.min(height * 0.08, 5);
  g.poly([N.x + sdx, N.y + sdy, E.x + sdx, E.y + sdy, S.x + sdx, S.y + sdy, W.x + sdx, W.y + sdy])
    .fill({ color: 0x000000, alpha: 0.16 });
  // 平面牆(左前暗、右前受光),乾淨立面靠窗格網做細節
  g.poly([W.x, W.y, S.x, S.y, up(S).x, up(S).y, up(W).x, up(W).y]).fill(darken(roof, 0.5));   // 左前牆
  g.poly([S.x, S.y, E.x, E.y, up(E).x, up(E).y, up(S).x, up(S).y]).fill(darken(roof, 0.72));  // 右前牆
  // 窗格:兩面各 3 欄 × N 列,部分點亮(冷藍),其餘暗窗 → 整齊夜間廠房立面
  const rows = Math.max(2, Math.floor(height / 26));
  const rng = mulberry32((gx * 73 + gy * 131 + w * 17 + h * 29) | 0);
  const LIT = 0x7fd0e6, UNLIT = 0x20303f;
  for (let r = 0; r < rows; r++) {
    const fy0 = (r + 0.28) / rows, fy1 = (r + 0.72) / rows;
    for (let cN = 0; cN < 3; cN++) {
      const cx0 = (cN + 0.22) / 3, cx1 = (cN + 0.78) / 3;
      const a0 = lerp2(W, S, cx0), a1 = lerp2(W, S, cx1);         // 左牆(W→S)
      const litL = rng() > 0.45;
      g.poly([a0.x, a0.y - height * fy0, a1.x, a1.y - height * fy0, a1.x, a1.y - height * fy1, a0.x, a0.y - height * fy1])
        .fill({ color: litL ? LIT : UNLIT, alpha: litL ? 0.5 : 0.82 });
      const b0 = lerp2(S, E, cx0), b1 = lerp2(S, E, cx1);         // 右牆(S→E)
      const litR = rng() > 0.5;
      g.poly([b0.x, b0.y - height * fy0, b1.x, b1.y - height * fy0, b1.x, b1.y - height * fy1, b0.x, b0.y - height * fy1])
        .fill({ color: litR ? LIT : UNLIT, alpha: litR ? 0.38 : 0.72 });
    }
  }
  g.poly([up(N).x, up(N).y, up(E).x, up(E).y, up(S).x, up(S).y, up(W).x, up(W).y])
    .fill(darken(roof, 1.12)).stroke({ width: 1, color: darken(roof, 1.4) });                 // 屋頂
  const hi = darken(roof, 1.6);
  g.moveTo(up(N).x, up(N).y).lineTo(up(W).x, up(W).y).stroke({ width: 1.5, color: hi, alpha: 0.6 });   // 受光邊高光
  g.moveTo(up(N).x, up(N).y).lineTo(up(E).x, up(E).y).stroke({ width: 1.2, color: hi, alpha: 0.4 });
  if (height > 50) {
    const cx = (up(N).x + up(S).x) / 2, cy = (up(N).y + up(S).y) / 2;
    g.rect(cx - 9, cy - 8, 18, 10).fill(darken(roof, 0.66)).stroke({ width: 0.6, color: hi, alpha: 0.5 });  // 空調機
    g.rect(cx - 14, cy + 3, 10, 6).fill(darken(roof, 0.6));
  }
}

// 等距樹木:影 + 樹幹 + 三層樹冠(受光/背光雙色)+ 高光。替園區加色彩與生命。
function drawTree(g: Graphics, cx: number, cy: number, s: number) {
  g.ellipse(cx + 2.5 * s, cy + 2 * s, 8 * s, 3.2 * s).fill({ color: 0x000000, alpha: 0.18 });   // 影
  g.rect(cx - 1.3 * s, cy - 5 * s, 2.6 * s, 6 * s).fill(0x5a4632);                                // 樹幹
  const greens = [0x3e6b3a, 0x4f8a48, 0x5fa356];
  for (let k = 0; k < 3; k++) {
    const yy = cy - 5 * s - k * 3.6 * s, rr = (8.5 - k * 1.7) * s;
    g.circle(cx - 1.6 * s, yy, rr).fill(darken(greens[k], 0.78));    // 背光側(暗)
    g.circle(cx + 1.6 * s, yy, rr).fill(greens[k]);                  // 受光側
  }
  g.circle(cx + 2.4 * s, cy - 13 * s, 2.4 * s).fill({ color: 0x9fd08a, alpha: 0.55 });            // 高光
}

interface DeviceVisual { container: Container; ring: Graphics; pulse: Graphics; kind: string; }
interface Station { id: string; template: string; container: Container; art: Graphics; ring: Graphics; }
interface Smoke { g: Graphics; x: number; y: number; vy: number; life: number; max: number; }
type Pt = { x: number; y: number };
// 產線工件:沿 waypoints 走的小方塊(feed=機台→手臂 pickup;belt=輸送帶→出口)
interface Part { g: Graphics; pts: Pt[]; seg: number; t: number; speed: number; kind: "feed" | "belt"; done?: boolean; }
// 產線編排:機台輸出 → (手臂夾取) → 輸送帶 → 出口。純視覺,走 animT(實時),與遙測節流脫鉤。
interface Flow {
  beltA: Pt; beltB: Pt; pickup: Pt; drop: Pt;
  machines: { id: string; output: Pt }[];
  pickerId: string | null;         // 擔任搬運的手臂(有產出機台時才指派)
  parts: Part[]; layer: Container;
  lastFeed: number; feedInterval: number; dropCycle: number;
}
const ARM_CYCLE = 4.5;             // 搬運手臂一個夾取-放置循環秒數(實時)
const ease = (x: number) => x * x * (3 - 2 * x);
const lerpPt = (a: Pt, b: Pt, f: number): Pt => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
// 兩節手臂 IK:base→target,回傳肘關節與末端(夾爪)點,超出可達範圍時夾到邊界。
function solveArm(bx: number, by: number, px: number, py: number, L1: number, L2: number) {
  const dx = px - bx, dy = py - by; let d = Math.hypot(dx, dy) || 0.01;
  const a = Math.atan2(dy, dx);
  d = Math.max(Math.abs(L1 - L2) + 0.5, Math.min(L1 + L2 - 0.5, d));
  const cosA = (d * d + L1 * L1 - L2 * L2) / (2 * L1 * d);
  const sh = a - Math.acos(Math.max(-1, Math.min(1, cosA)));
  return {
    joint: { x: bx + L1 * Math.cos(sh), y: by + L1 * Math.sin(sh) },
    end: { x: bx + Math.cos(a) * d, y: by + Math.sin(a) * d },
  };
}

export default function WorldView({
  park, telemetry, selected, onSelect, predicted,
}: {
  park: Park; telemetry: TelemetryMsg | null;
  selected: string | null; onSelect: (id: string) => void; predicted: Set<string>;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; c: Company } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const lightsRef = useRef<Record<string, Graphics>>({});
  const devicesRef = useRef<Record<string, DeviceVisual>>({});
  const stationsRef = useRef<Station[]>([]);
  const chimneysRef = useRef<{ x: number; y: number }[]>([]);
  const smokeRef = useRef<Smoke[]>([]);
  const fxRef = useRef<Container | null>(null);
  const beltRef = useRef<Graphics | null>(null);
  const flowRef = useRef<Flow | null>(null);
  const peopleRef = useRef<{ g: Graphics; pts: Pt[]; t: number; speed: number; color: number; work: boolean }[]>([]);
  const telRef = useRef(telemetry);
  const onSelectRef = useRef(onSelect); const selectedRef = useRef(selected); const predictedRef = useRef(predicted);
  telRef.current = telemetry; onSelectRef.current = onSelect; selectedRef.current = selected; predictedRef.current = predicted;

  useEffect(() => {
    let cancelled = false, ready = false;
    const host = hostRef.current!;
    const app = new Application();
    const safeDestroy = () => { try { app.destroy(true, { children: true }); } catch { /* */ } };

    (async () => {
      await app.init({ background: focus ? 0x0a0e14 : 0x0b0f15, antialias: true,
                       width: host.clientWidth || 800, height: host.clientHeight || 600 });
      if (cancelled) { safeDestroy(); return; }
      ready = true; appRef.current = app; host.appendChild(app.canvas);
      const world = new Container(); app.stage.addChild(world); worldRef.current = world;
      recenter();
      if (focus) buildInterior(world, focus); else buildOverview(world);
      const fx = new Container(); world.addChild(fx); fxRef.current = fx;
      let animT = 0;
      app.ticker.add((tk) => { animT += tk.deltaMS / 1000; focus ? tickInterior(animT, tk.deltaMS / 1000) : tickOverview(animT, tk.deltaMS / 1000); });
      update();
    })();

    // ── 俯瞰 ─────────────────────────────────────────────
    function buildOverview(world: Container) {
      // 園區外緣柔和光暈(最底層):把園區從深色虛空中托出來,加大氣氛圍
      const glow = new Graphics();
      for (let r = 6; r >= 1; r--) glow.ellipse(0, 30, 130 + r * 55, 80 + r * 32).fill({ color: 0x1a2740, alpha: 0.05 });
      world.addChild(glow);

      const ground = new Graphics();
      const gnd = mulberry32(99173);
      for (let gx = 0; gx < GRID; gx++) for (let gy = 0; gy < GRID; gy++) {
        const N = iso(gx, gy), E = iso(gx + 1, gy), S = iso(gx + 1, gy + 1), W = iso(gx, gy + 1);
        const road = isRoad(gx, gy);
        const cross = (gx - 1) % STEP === 0 && (gy - 1) % STEP === 0;
        let base = road ? (cross ? 0x262c36 : 0x22272f) : ((gx + gy) % 2 === 0 ? 0x1b2230 : 0x18202c);
        if (!road) base = darken(base, 0.9 + gnd() * 0.2);        // 輕微亮度雜訊 → 地面不再死板棋盤
        ground.poly([N.x, N.y, E.x, E.y, S.x, S.y, W.x, W.y]).fill(base);
        if (road && !cross) {                                     // 道路中線虛線(每格一小段拼成)
          const c = iso(gx + 0.5, gy + 0.5), horiz = (gy - 1) % STEP === 0;
          const dx = (horiz ? HW : -HW) * 0.4, dy = HH * 0.4;
          ground.moveTo(c.x - dx, c.y - dy).lineTo(c.x + dx, c.y + dy).stroke({ width: 1, color: 0x3a4658, alpha: 0.55 });
        }
      }
      world.addChild(ground);

      const reserved = new Set<string>();
      park.companies.forEach((_, i) => { const { gx, gy } = companyTile(i);
        for (let dx = -1; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) reserved.add(`${gx + dx},${gy + dy}`); });
      const rnd = mulberry32(20260628);
      const props: any[] = [];
      for (let gx = 1; gx < GRID - 1; gx++) for (let gy = 1; gy < GRID - 1; gy++) {
        if (isRoad(gx, gy) || reserved.has(`${gx},${gy}`) || rnd() > 0.15) continue;
        if (rnd() < 0.45) { props.push({ gx, gy, tree: true, s: 0.8 + rnd() * 0.7 }); continue; }   // 空地多為植栽
        const roof = rnd() > 0.6 ? COMPANY_COLORS[Math.floor(rnd() * COMPANY_COLORS.length)] : ROOFS[Math.floor(rnd() * ROOFS.length)];
        props.push({ gx, gy, ht: 10 + Math.floor(rnd() * 48), roof, chimney: rnd() > 0.82 });
      }
      props.sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));   // 由後往前畫,遮擋正確
      for (const b of props) {
        const g = new Graphics();
        if (b.tree) { const t = iso(b.gx + 0.5, b.gy + 0.5); drawTree(g, t.x, t.y, b.s); world.addChild(g); continue; }
        isoBox(g, b.gx, b.gy, 1, 1, b.ht, b.roof); world.addChild(g);
        if (b.chimney) { const t = iso(b.gx + 0.5, b.gy + 0.5); chimneysRef.current.push({ x: t.x, y: t.y - b.ht - 3 }); }
      }

      park.companies.forEach((c, i) => {
        const { gx, gy } = companyTile(i); const p = iso(gx, gy);
        // 每間公司:確定性的多彩、高低、大小
        const rc = mulberry32(7000 + i * 13);
        const roof = COMPANY_COLORS[Math.floor(rc() * COMPANY_COLORS.length)];
        const ht = 20 + Math.floor(rc() * 70);                 // 高低差更大
        const sz = () => { const r = rc(); return r > 0.82 ? 4 : r > 0.45 ? 3 : 2; };
        const fw = sz(), fh = sz();                            // 大小更多樣(2~4)
        const g = new Graphics(); isoBox(g, gx, gy, fw, fh, ht, roof);
        g.eventMode = "static"; g.cursor = "pointer";
        g.on("pointertap", () => { setTip(null); setFocus(c.id); });
        g.on("pointerover", (e: any) => setTip({ x: e.global.x, y: e.global.y, c }));
        g.on("pointermove", (e: any) => setTip((t) => t ? { ...t, x: e.global.x, y: e.global.y } : t));
        g.on("pointerout", () => setTip(null));
        world.addChild(g);
        chimneysRef.current.push({ x: p.x + fw * 6, y: p.y - ht - 4 });
        const label = new Text({ text: c.name, style: { fill: 0xd7dfea, fontSize: 10, fontFamily: "IBM Plex Sans TC", fontWeight: "600" } });
        label.anchor.set(0.5, 0.5);
        const ly = p.y + fh * 7 + 12;
        const pw = label.width + 22, ph = 17;
        const plate = new Graphics();
        plate.roundRect(p.x - pw / 2, ly - ph / 2, pw, ph, 8.5).fill({ color: 0x0c1017, alpha: 0.82 }).stroke({ width: 1, color: 0x202836 });
        plate.circle(p.x - pw / 2 + 9, ly, 3).fill(0x35d07a);   // 狀態點(即時狀態看屋頂燈)
        world.addChild(plate);
        label.x = p.x + 5; label.y = ly; world.addChild(label);
        // 一公司一燈號(屋頂上方),點燈也能進廠內
        const light = new Graphics(); light.x = p.x; light.y = p.y - ht - 14;
        light.eventMode = "static"; light.cursor = "pointer"; light.on("pointertap", () => { setTip(null); setFocus(c.id); });
        world.addChild(light); lightsRef.current[c.id] = light;
      });
    }

    function tickOverview(animT: number, dt: number) {
      // 一公司一燈號:紅(有設備故障)閃 / 橘(有預測)脈 / 綠(正常)
      for (const light of Object.values(lightsRef.current)) {
        const kind = (light as any)._kind || "ok";
        light.clear();
        light.moveTo(0, 6).lineTo(0, 15).stroke({ width: 1.5, color: 0x3a4658 });      // 燈桿(接屋頂)
        light.circle(0, 15, 2).fill(0x2a3446);                                          // 桿座
        if (kind === "fault") {
          const a = 0.5 + 0.5 * Math.sin(animT * 5);
          light.circle(0, 0, 13 + a * 6).fill({ color: 0xe0503f, alpha: 0.12 + 0.18 * a });
          light.circle(0, 0, 7).fill(0xe0503f).stroke({ width: 2, color: 0x10151d });
        } else if (kind === "predicted") {
          const a = 0.5 + 0.5 * Math.sin(animT * 3);
          light.circle(0, 0, 12 + a * 4).fill({ color: 0xf0883c, alpha: 0.1 + 0.14 * a });
          light.circle(0, 0, 7).fill(0xf0883c).stroke({ width: 2, color: 0x10151d });
        } else {
          // 正常:小而沉靜,讓紅(故障)/橘(預測)在滿屏時仍一眼跳出
          light.circle(0, 0, 5).fill(0x2ba869).stroke({ width: 1.6, color: 0x10151d });
        }
      }
      smoke(animT, dt);
    }

    // ── 廠內 ─────────────────────────────────────────────
    function buildInterior(world: Container, cid: string) {
      const company = park.companies.find((c) => c.id === cid);
      const devIds = company?.device_ids || [];
      const PRODUCING = new Set(["cnc_machining_center", "injection_molding"]);
      // 先取得各設備 template,決定誰是產出機台、哪支手臂擔任搬運
      const items = devIds.map((did) => ({ did, tmpl: telRef.current?.devices[did]?.template || "" }));
      const hasMachine = items.some((it) => PRODUCING.has(it.tmpl));
      const picker = hasMachine ? items.find((it) => it.tmpl === "robot_arm_6axis") : undefined;
      const topItems = items.filter((it) => it !== picker);        // 上排:機台與其他設備
      const FW = Math.max(9, topItems.length * 3 + 3), FH = 9;
      const fiso = (gx: number, gy: number) => ({ x: (gx - gy) * 34, y: (gx + gy) * 17 });

      const floor = new Graphics();
      for (let gx = 0; gx < FW; gx++) for (let gy = 0; gy < FH; gy++) {
        const N = fiso(gx, gy), E = fiso(gx + 1, gy), S = fiso(gx + 1, gy + 1), W = fiso(gx, gy + 1);
        floor.poly([N.x, N.y, E.x, E.y, S.x, S.y, W.x, W.y]).fill((gx + gy) % 2 ? 0x222b39 : 0x1d2532).stroke({ width: 0.5, color: 0x2a3446 });
      }
      world.addChild(floor);
      // 輸送帶(底排,左→右出口)
      const bA = fiso(1, FH - 1.6), bB = fiso(FW - 1, FH - 1.6);
      const belt = new Graphics();
      belt.poly([bA.x, bA.y - 9, bB.x, bB.y - 9, bB.x, bB.y + 9, bA.x, bA.y + 9]).fill(0x2c3340).stroke({ width: 1, color: 0x3a4458 });
      world.addChild(belt);
      const beltDash = new Graphics(); world.addChild(beltDash);
      (beltDash as any)._a = bA; (beltDash as any)._b = bB; beltRef.current = beltDash;
      // 出口標記
      const exit = new Graphics();
      exit.poly([bB.x, bB.y - 9, bB.x + 16, bB.y - 9, bB.x + 16, bB.y + 9, bB.x, bB.y + 9]).fill({ color: 0x1a212c, alpha: 0.9 });
      world.addChild(exit);
      const exitLab = new Text({ text: "出貨 →", style: { fill: 0x6b7488, fontSize: 10, fontFamily: "IBM Plex Sans TC" } });
      exitLab.x = bB.x + 2; exitLab.y = bB.y + 10; world.addChild(exitLab);

      const partsLayer = new Container(); world.addChild(partsLayer);  // 工件畫在輸送帶之上

      // 設備站
      const stations: Station[] = [];
      const machines: { id: string; output: Pt }[] = [];
      const armGX = 2.2;                                              // 搬運手臂(橋接機台與輸送帶)位置
      const armPos = fiso(armGX, FH - 2.6);
      let topCol = 0;
      items.forEach((it) => {
        const { did, tmpl } = it;
        const isPicker = picker && it === picker;
        const pos = isPicker ? armPos : fiso(2.5 + topCol * 3, 2.6);
        if (!isPicker) topCol++;
        const cont = new Container(); cont.x = pos.x; cont.y = pos.y;
        cont.eventMode = "static"; cont.cursor = "pointer"; cont.on("pointertap", () => onSelectRef.current(did));
        const ring = new Graphics(); cont.addChild(ring);
        const art = new Graphics(); cont.addChild(art);
        const lab = new Text({ text: did, style: { fill: 0xc7d2e0, fontSize: 11, fontFamily: "IBM Plex Sans TC" } });
        lab.anchor.set(0.5, 0); lab.y = 34; cont.addChild(lab);
        (cont as any)._track = { a: fiso(2, 1), b: fiso(FW - 2, 1), c: fiso(FW - 2, FH - 3), d: fiso(2, FH - 3) }; // AGV 軌跡
        world.addChild(cont);
        stations.push({ id: did, template: tmpl, container: cont, art, ring });
        if (PRODUCING.has(tmpl)) machines.push({ id: did, output: { x: pos.x, y: pos.y + 30 } });
      });
      stationsRef.current = stations;

      flowRef.current = {
        beltA: bA, beltB: bB,
        pickup: fiso(armGX, FH - 4.0),     // 手臂上方:工件送達夾取點
        drop: fiso(armGX, FH - 1.6),       // 手臂下方:放上輸送帶
        machines,
        pickerId: picker ? picker.did : null,
        parts: [], layer: partsLayer,
        lastFeed: 0, feedInterval: 2.6, dropCycle: -1,
      };

      // 廠內人員:沿走道巡走 + 機台旁作業(純視覺,animT 驅動)
      const peopleLayer = new Container(); world.addChild(peopleLayer);
      const SHIRTS = [0x4f9d5b, 0x3f6ea5, 0xb5743a, 0xa85a6a, 0x7a5ca8];
      const aisle = [fiso(1.6, FH - 2.3), fiso(FW - 1.6, FH - 2.3), fiso(FW - 1.6, 1.4), fiso(1.6, 1.4)];
      const people: { g: Graphics; pts: Pt[]; t: number; speed: number; color: number; work: boolean }[] = [];
      for (let i = 0; i < 3; i++) {       // 巡走的人(沿走道矩形)
        const g = new Graphics(); peopleLayer.addChild(g);
        people.push({ g, pts: aisle, t: i * 1.33, speed: 0.5 + i * 0.12, color: SHIRTS[i % SHIRTS.length], work: false });
      }
      stations.slice(0, 2).forEach((st, i) => {   // 站在前兩台設備旁「作業」的人
        const g = new Graphics(); peopleLayer.addChild(g);
        const here = { x: st.container.x - 22, y: st.container.y + 14 };
        people.push({ g, pts: [here, here], t: i * 0.7, speed: 0, color: SHIRTS[(i + 2) % SHIRTS.length], work: true });
      });
      peopleRef.current = people;
    }

    function drawPerson(g: Graphics, x: number, y: number, color: number, bob: number, arm: number) {
      g.ellipse(x, y + 2, 5, 2.2).fill({ color: 0x000000, alpha: 0.22 });        // 影
      g.roundRect(x - 3, y - 11 + bob, 6, 11, 2).fill(color);                    // 身體
      g.moveTo(x - 3, y - 8 + bob).lineTo(x - 6, y - 8 + bob + arm).stroke({ width: 2, color, cap: "round" }); // 手臂
      g.moveTo(x + 3, y - 8 + bob).lineTo(x + 6, y - 8 + bob - arm).stroke({ width: 2, color, cap: "round" });
      g.circle(x, y - 14 + bob, 3).fill(0xe7c9a8).stroke({ width: 0.8, color: 0x6b5036 }); // 頭
    }

    function tickInterior(animT: number, dt: number) {
      const tel = telRef.current;
      const bd: any = beltRef.current;
      if (bd && bd._a) {
        bd.clear(); const a = bd._a, b = bd._b, off = (animT * 0.4) % 1;
        for (let i = 0; i < 16; i++) { const f = (i + off) / 16, x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
          bd.rect(x - 2, y - 7, 4, 14).fill({ color: 0x3c465c }); }
      }
      updateFlow(animT, dt);
      for (const st of stationsRef.current) {
        const snap = tel?.devices[st.id]; const t = snap?.tags || {}; const state = snap?.state || "idle";
        const running = state === "running" || state === "moving";
        const isPred = predictedRef.current.has(st.id) && state !== "fault";
        const col = isPred ? 0xf08c2e : colorOf(state);
        st.ring.clear();
        const selW = st.id === selectedRef.current ? 3 : 1.5;
        st.ring.ellipse(0, 26, 28, 13).fill({ color: col, alpha: 0.12 }).stroke({ width: selW, color: col });
        if (state === "fault") { const p = 0.5 + 0.5 * Math.sin(animT * 6); st.ring.ellipse(0, 26, 32 + p * 6, 15 + p * 3).stroke({ width: 1.5, color: 0xe24c4c }); }
        st.art.clear(); st.art.position.set(0, 0);
        if (st.template === "agv_mobile_robot") {
          // 慢速沿固定矩形軌跡
          const tr = (st.container as any)._track;
          if (tr) { const segs = [tr.a, tr.b, tr.c, tr.d]; const peri = 4; const pp = (animT * 0.08) % 1 * peri;
            const i0 = Math.floor(pp), f = pp - i0; const A = segs[i0], B = segs[(i0 + 1) % 4];
            st.container.x += ((A.x + (B.x - A.x) * f) - st.container.x) * 0.1;
            st.container.y += ((A.y + (B.y - A.y) * f) - st.container.y) * 0.1; }
        }
        drawStation(st.art, st.template, t, running, animT, col, state === "fault");
      }
      // 廠內人員:巡走的沿走道矩形移動;作業的站定做手部動作
      for (const pr of peopleRef.current) {
        pr.g.clear();
        if (pr.work) {
          const here = pr.pts[0];
          drawPerson(pr.g, here.x, here.y, pr.color, 0, 2.5 * Math.sin(animT * 3 + pr.t));
        } else {
          pr.t += dt * pr.speed * 0.25;
          const P = pr.pts.length, pp = ((pr.t % P) + P) % P;
          const i0 = Math.floor(pp), f = pp - i0;
          const A = pr.pts[i0], B = pr.pts[(i0 + 1) % P];
          drawPerson(pr.g, A.x + (B.x - A.x) * f, A.y + (B.y - A.y) * f, pr.color, Math.sin(pr.t * 9) * 1.1, 1.2 * Math.sin(pr.t * 9));
        }
      }
      smoke(animT, dt);
    }

    function updateFlow(animT: number, dt: number) {
      const flow = flowRef.current; if (!flow) return; const tel = telRef.current;
      const hasArm = !!flow.pickerId;
      // 機台輸出工件(僅運轉中的機台會出件)
      if (flow.machines.length && animT - flow.lastFeed >= flow.feedInterval) {
        flow.lastFeed = animT;
        for (const m of flow.machines) {
          const stt = tel?.devices[m.id]?.state;
          if (stt && stt !== "running") continue;
          const g = new Graphics(); flow.layer.addChild(g);
          const pts: Pt[] = hasArm ? [m.output, flow.pickup] : [m.output, flow.beltA, flow.beltB];
          flow.parts.push({ g, pts, seg: 0, t: 0, speed: hasArm ? 40 : 34, kind: hasArm ? "feed" : "belt" });
        }
      }
      // 搬運手臂每個循環在放件相位於輸送帶生出一個工件(隨帶外送)
      if (hasArm && flow.machines.length) {
        const cyc = Math.floor(animT / ARM_CYCLE);
        if (flow.dropCycle < 0) flow.dropCycle = cyc;
        else if (cyc > flow.dropCycle) {
          flow.dropCycle = cyc;
          const g = new Graphics(); flow.layer.addChild(g);
          flow.parts.push({ g, pts: [flow.drop, flow.beltB], seg: 0, t: 0, speed: 30, kind: "belt" });
        }
      }
      for (const pt of flow.parts) {
        const a = pt.pts[pt.seg], b = pt.pts[pt.seg + 1];
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        pt.t += (pt.speed * dt) / len;
        if (pt.t >= 1) { pt.t = 0; pt.seg++; if (pt.seg >= pt.pts.length - 1) pt.done = true; }
        const aa = pt.pts[Math.min(pt.seg, pt.pts.length - 1)], bb = pt.pts[Math.min(pt.seg + 1, pt.pts.length - 1)];
        const x = aa.x + (bb.x - aa.x) * pt.t, y = aa.y + (bb.y - aa.y) * pt.t;
        pt.g.clear();
        pt.g.roundRect(x - 7, y - 7, 14, 12, 2).fill(0xd9a441).stroke({ width: 1, color: 0x8a6b2e });
        pt.g.rect(x - 7, y - 7, 14, 3).fill({ color: 0xf0c674, alpha: 0.7 });
      }
      for (let i = flow.parts.length - 1; i >= 0; i--)
        if (flow.parts[i].done) { flow.parts[i].g.destroy(); flow.parts.splice(i, 1); }
    }

    // 各機台的中心偏移(anchor=地面原點角,調到坐落在站位中央)
    const MOFF: Record<string, P2> = {
      cnc_machining_center: [-38, -12], injection_molding: [-30, -8], robot_arm_6axis: [2, 4],
      air_compressor: [-32, -4], wind_turbine: [8, 30], semi_process_chamber: [-30, -8],
      energy_meter: [-16, 0], stamping_press: [-18, 6], heat_treat_furnace: [-30, -8], agv_mobile_robot: [6, 2],
    };
    function drawStation(g: Graphics, tmpl: string, t: Record<string, number>, running: boolean, animT: number, _col: number, fault: boolean) {
      const [ox, oy] = MOFF[tmpl] ?? [-20, 0];
      switch (tmpl) {
        case "cnc_machining_center": mCNC(g, ox, oy, animT, running, fault); break;
        case "injection_molding": mInjection(g, ox, oy, animT, running); break;
        case "robot_arm_6axis": mArm(g, ox, oy, animT, [ox - 46, oy - 14], [ox + 34, oy + 40]); break;
        case "air_compressor": mCompressor(g, ox, oy, animT, running); break;
        case "wind_turbine": mTurbine(g, ox, oy, animT, running ? (t["rotor_rpm"] || 12) : 3); break;
        case "semi_process_chamber": mChamber(g, ox, oy, animT, running); break;
        case "energy_meter": mMeter(g, ox, oy, animT, running); break;
        case "stamping_press": mPress(g, ox, oy, animT, running); break;
        case "heat_treat_furnace": mFurnace(g, ox, oy, animT, running); break;
        case "agv_mobile_robot": mAGV(g, ox, oy, animT, running); break;
        default: isoBox3(g, ox, oy, 1.6, 1.4, 24, { top: 0x3a4356, left: 0x232d3d, right: 0x2c3648 });
      }
    }

    function smoke(animT: number, dt: number) {
      const fxc = fxRef.current; if (!fxc) return;
      if (!focus && Math.sin(animT * 9) > 0.6) for (const ch of chimneysRef.current) if (Math.random() < 0.4) {
        const g = new Graphics(); fxc.addChild(g);
        smokeRef.current.push({ g, x: ch.x + (Math.random() - 0.5) * 4, y: ch.y, vy: 6 + Math.random() * 6, life: 0, max: 1.3 + Math.random() });
      }
      for (const s of smokeRef.current) { s.life += dt; s.y -= s.vy * dt; const tt = s.life / s.max;
        s.g.clear(); s.g.circle(s.x, s.y, 2 + tt * 6).fill({ color: 0x8a93a6, alpha: Math.max(0, 0.32 * (1 - tt)) }); }
      for (let i = smokeRef.current.length - 1; i >= 0; i--)
        if (smokeRef.current[i].life >= smokeRef.current[i].max) { smokeRef.current[i].g.destroy(); smokeRef.current.splice(i, 1); }
    }

    function recenter() {
      const w = worldRef.current;
      if (w && app.renderer) {
        w.scale.set(focus ? 1 : 0.7);                  // 俯瞰縮小(GRID 放大後整座園區仍進畫面)
        w.x = app.screen.width / 2;
        w.y = app.screen.height * (focus ? 0.28 : 0.5); // 俯瞰往下移,上方不被頂列切到
      }
    }
    const onResize = () => { if (ready && app.renderer) { app.renderer.resize(host.clientWidth || 800, host.clientHeight || 600); recenter(); } };
    window.addEventListener("resize", onResize);
    return () => { cancelled = true; window.removeEventListener("resize", onResize);
      lightsRef.current = {}; devicesRef.current = {}; stationsRef.current = []; chimneysRef.current = []; smokeRef.current = []; peopleRef.current = [];
      worldRef.current = null; appRef.current = null; fxRef.current = null; beltRef.current = null; flowRef.current = null;
      if (ready) safeDestroy(); };
  }, [park, focus]);

  useEffect(() => { update(); }, [telemetry, selected, predicted, focus]);

  function update() {
    const tel = telemetry; if (!tel || focus) return;
    // 一公司一燈號:紅=任一設備故障、橘=任一預測中、否則綠(正常)
    for (const c of park.companies) {
      const light = lightsRef.current[c.id]; if (!light) continue;
      const devs = c.device_ids || [];
      const hasFault = devs.some((d) => tel.devices[d]?.state === "fault");
      const hasPred = devs.some((d) => tel.devices[d]?.state !== "fault" && predictedRef.current.has(d));
      (light as any)._kind = hasFault ? "fault" : hasPred ? "predicted" : "ok";
    }
  }

  const fc = focus ? park.companies.find((c) => c.id === focus) : null;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      {!focus && (
        <div className="pill" style={{ position: "absolute", top: 12, left: 14, fontSize: 12 }}>
          滑鼠移到公司看簡介 · 點公司進廠內 · 點設備看即時值
        </div>
      )}
      {/* 公司 hover tooltip */}
      {tip && !focus && (
        <div className="card float" style={{ position: "absolute", left: Math.min(tip.x + 14, (hostRef.current?.clientWidth ?? 800) - 250),
                      top: tip.y + 14, width: 232, padding: "9px 12px", pointerEvents: "none" }}>
          <div style={{ fontWeight: 700, color: "var(--text)" }}>🏭 {tip.c.name}</div>
          {tip.c.product && <div style={{ color: "var(--accent)", fontSize: 12, margin: "3px 0" }}>主要產品:{tip.c.product}</div>}
          <div className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>設備:{(tip.c.device_ids || []).join("、")}</div>
        </div>
      )}
      {/* 廠內標題 + 返回 + 公司介紹 */}
      {fc && (
        <>
          <div style={{ position: "absolute", top: 12, left: 14, display: "flex", gap: 12, alignItems: "center" }}>
            <button className="btn ghost" onClick={() => setFocus(null)}>← 返回俯瞰</button>
            <span style={{ color: "var(--text-2)", fontWeight: 600 }}>🏭 {fc.name} · 廠內即時</span>
          </div>
          <div className="card float" style={{ position: "absolute", top: 58, left: 16, width: 300, padding: "14px 16px" }}>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>{fc.name}</div>
            {fc.product && <div style={{ color: "var(--accent)", fontSize: 12.5, margin: "6px 0" }}>主要產品:{fc.product}</div>}
            {fc.intro && <div style={{ color: "var(--text-2)", fontSize: 12.5, lineHeight: 1.6 }}>{fc.intro}</div>}
            <div className="mono" style={{ color: "var(--muted)", fontSize: 11, marginTop: 8 }}>廠內設備:{(fc.device_ids || []).join("、")}</div>
            <div style={{ color: "var(--pred)", fontSize: 11, marginTop: 6 }}>⚠ 合成數據,非真實產線</div>
          </div>
        </>
      )}
    </div>
  );
}
