import { Graphics, FillGradient } from "pixi.js";

// ── 等距金屬量體工具(由 WorldView 抽出,集中管理機台美術)──────────────
// 本模組只負責「畫一台設備」:輸入 anchor(ox,oy)=地面原點角、時間 animT、運轉/故障旗標,
// 逐幀重畫(呼叫端負責 g.clear())。所有動畫皆為 animT 的純函數,故無需保存粒子狀態。

export const MTW = 30, MTH = 15;   // 機台等距 tile(設計稿數值)
export type P2 = [number, number];

export function darken(c: number, f: number) {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return ((Math.min(255, r * f) | 0) << 16) | ((Math.min(255, g * f) | 0) << 8) | (Math.min(255, b * f) | 0);
}
function lgrad(x0: number, y0: number, x1: number, y1: number, c0: number, c1: number): FillGradient {
  return new FillGradient({ type: "linear", start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, textureSpace: "global",
    colorStops: [{ offset: 0, color: c0 }, { offset: 1, color: c1 }] });
}
function rgrad(cx: number, cy: number, r: number, core: string): FillGradient {
  return new FillGradient({ type: "radial", center: { x: cx, y: cy }, innerRadius: 0,
    outerCenter: { x: cx, y: cy }, outerRadius: r, textureSpace: "global",
    colorStops: [{ offset: 0, color: core }, { offset: 1, color: "rgba(0,0,0,0)" }] });
}

// 徑向發光(核心 + 兩層柔光暈):用於主軸 / 電漿 / 爐火 / LED 等「亮起來」的細節
function emissive(g: Graphics, cx: number, cy: number, r: number, color: number, a = 1) {
  g.circle(cx, cy, r * 2.7).fill({ color, alpha: 0.06 * a });
  g.circle(cx, cy, r * 1.7).fill({ color, alpha: 0.12 * a });
  g.circle(cx, cy, r).fill({ color, alpha: Math.min(1, 0.92 * a) });
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

// ── 粒子/特效小工具(全部由 animT 決定,無狀態)────────────────────────
// 確定性偽隨機:給粒子分佈用,同一顆 i 每幀值固定,不會閃爍。
function hsh(n: number) { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); }
// 上升霧氣/蒸汽:n 顆隨 animT 循環上升、擴散、淡出(冷卻霧 / 水氣 / 排氣)
function vapor(g: Graphics, cx: number, cy: number, t: number, n: number, color: number,
               opt?: { rise?: number; spread?: number; size?: number; alpha?: number; speed?: number }) {
  const rise = opt?.rise ?? 24, spread = opt?.spread ?? 6, size = opt?.size ?? 5, alpha = opt?.alpha ?? 0.28, speed = opt?.speed ?? 0.5;
  for (let i = 0; i < n; i++) {
    const ph = ((t * speed + hsh(i * 5.7)) % 1 + 1) % 1;
    const sway = Math.sin(hsh(i) * 6.28 + t * 1.4) * spread;
    g.circle(cx + sway * ph, cy - ph * rise, size * (0.35 + ph * 1.2)).fill({ color, alpha: alpha * (1 - ph) * (1 - ph) });
  }
}
// 火花噴濺:沿上方散開、帶重力弧,由亮黃→金→暗橘淡出(切削 / 沖壓)
function sparks(g: Graphics, cx: number, cy: number, t: number, n: number,
                opt?: { speed?: number; spread?: number; up?: number; reach?: number; grav?: number }) {
  const speed = opt?.speed ?? 1.6, spread = opt?.spread ?? 2.4, up = opt?.up ?? -1.9, reach = opt?.reach ?? 18, grav = opt?.grav ?? 18;
  for (let i = 0; i < n; i++) {
    const ph = ((t * speed + hsh(i * 3.1)) % 1 + 1) % 1;
    const ang = up + (hsh(i * 7.3) - 0.5) * spread;
    const spd = reach * (0.7 + hsh(i * 2.7) * 0.6);
    const x = cx + Math.cos(ang) * spd * ph;
    const y = cy + Math.sin(ang) * spd * ph + ph * ph * grav;
    const life = 1 - ph;
    const col = life > 0.6 ? 0xfff2cc : life > 0.3 ? 0xf0c674 : 0xd47a3f;
    g.circle(x, y, 1.5 * life + 0.4).fill({ color: col, alpha: 0.4 + 0.6 * life });
  }
}
// 旋轉殘影盤:高速旋轉件(風扇 / 葉片)疊幾層柔和同心圓,製造「轉到看不清」的動態模糊。
function blurDisc(g: Graphics, cx: number, cy: number, r: number, color: number, alpha: number) {
  for (let k = 3; k >= 1; k--) g.circle(cx, cy, r * (0.55 + k * 0.16)).fill({ color, alpha: alpha * (0.5 - k * 0.1) });
}

// ── 各機台繪法(anchor=(ox,oy) 地面原點角;t=animT 秒)────────────────
export function mCNC(g: Graphics, ox: number, oy: number, t: number, running: boolean, fault: boolean) {
  ishadow(g, ox + 0.3 * MTW, oy + 1.6 * MTH, 64, 30, 0.4);
  const pal = fault ? { top: 0xc09088, left: 0x8a5c50, right: 0xa87068 } : { top: 0xd8c6a8, left: 0xa08a6a, right: 0xc0aa88 };
  isoBox3(g, ox, oy, 2.4, 2.2, 42, pal);
  isoBox3(g, ox + 0.2 * MTW, oy + 0.2 * MTH - 42, 1.7, 1.5, 24, { top: 0xc7b592, left: 0x9a8464, right: 0xb4a082 });
  isoBox3(g, ox + 2.55 * MTW, oy + 2.4 * MTH, 0.55, 0.55, 36, { top: 0xe0cfa8, left: 0xac9674, right: 0xc9b896 });
  // 控制面板:螢幕跳動讀數 + 循環狀態燈(運轉綠慢閃 / 故障紅)
  const pcx = ox + 2.8 * MTW, pcy = oy + 2.8 * MTH - 24;
  g.rect(pcx - 7, pcy - 9, 15, 12).fill(0x33291f).stroke({ width: 0.7, color: 0x8a7658 });
  if (running) for (let i = 0; i < 3; i++)
    g.rect(pcx - 5, pcy - 6 + i * 3, 5 + 5 * Math.abs(Math.sin(t * 3 + i * 1.7)), 1.4).fill({ color: 0x8fd08a, alpha: 0.55 });
  else g.rect(pcx - 5, pcy - 1, 10, 1.4).fill({ color: 0x6f855a, alpha: 0.4 });
  const led = running ? (Math.sin(t * 2.5) > 0 ? 0x62d06a : 0x2f5a2c) : (fault ? 0xe0604a : 0x8a6b4a);
  if (running || fault) emissive(g, pcx + 10, pcy - 6, 2.1, led, 0.9); else g.circle(pcx + 10, pcy - 6, 2).fill(led);
  // 觀景窗(半透玻璃,運轉時內部微亮綠)
  g.poly([ox + 1.9 * MTW, oy + 1.9 * MTH - 8, ox + 1.0 * MTW, oy + 2.9 * MTH - 8, ox + 1.0 * MTW, oy + 2.9 * MTH - 30, ox + 1.9 * MTW, oy + 1.9 * MTH - 30])
    .fill({ color: running ? 0x9db4a2 : 0x8a7658, alpha: 0.82 }).stroke({ width: 1.2, color: 0xc9b795 });
  const cx = ox + 1.45 * MTW, cy = oy + 1.55 * MTH - 16;
  // 主軸:柔光暈 + 高速殘影 + 旋轉刀具 + 冷卻液霧 + 切削火花
  if (running) {
    iglow(g, cx, cy + 6, 22, "rgba(255,214,130,0.55)");
    blurDisc(g, cx, cy + 3, 7, 0xf0e6d4, 0.5);
  }
  const spin = running ? t * 14 : 0, off = Math.cos(spin) * 5;
  g.moveTo(cx - off, cy).lineTo(cx + off, cy + 10).stroke({ width: 3, color: running ? 0xf0c674 : 0xb8a884, cap: "round" });
  g.circle(cx, cy, 2.4).fill(running ? 0xf6dca0 : 0xc0b088);
  if (running) {
    sparks(g, cx, cy + 10, t, 7, { reach: 15, grav: 16 });
    vapor(g, cx, cy + 8, t, 4, 0xdfece9, { rise: 22, spread: 5, size: 4, alpha: 0.2, speed: 0.7 });
  }
}

export function mInjection(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.2 * MTW, oy + 1.4 * MTH, 60, 28, 0.4);
  isoBox3(g, ox, oy, 1.4, 1.8, 34, { top: 0xb4a67e, left: 0x8f8062, right: 0xa89a70 });
  // 合模節拍:快閉(0~.35)→ 保壓(.35~.62)→ 開模(.62~1)。clampF:1=完全閉合
  const cyc = running ? (t * 0.42) % 1 : 0.55;
  const clampF = !running ? 0.5 : cyc < 0.35 ? cyc / 0.35 : cyc < 0.62 ? 1 : 1 - (cyc - 0.62) / 0.38;
  const hold = running && cyc >= 0.35 && cyc < 0.62;
  isoBox3(g, ox + 1.5 * MTW, oy + 1.5 * MTH, 1.8, 0.9, 20, { top: 0xd0bd98, left: 0xa88f6c, right: 0xc0ad8a });
  isoBox3(g, ox + 2.3 * MTW, oy + 2.3 * MTH - 20, 0.5, 0.5, 14, { top: 0xd8c6a8, left: 0xc0ad8a, right: 0xcbb894 });
  // 料管噴嘴熔膠光(保壓相位最亮)
  if (running) iglow(g, ox + 2.0 * MTW, oy + 2.0 * MTH - 6, 22, `rgba(255,140,60,${hold ? 0.72 : 0.42})`);
  // 兩根導柱 + 動模板(隨合模前後移動)
  for (let i = 0; i < 2; i++)
    g.moveTo(ox + 0.5 * MTW, oy + 0.35 * MTH - 20 + i * 15).lineTo(ox + 1.15 * MTW, oy + 0.68 * MTH - 20 + i * 15).stroke({ width: 1.4, color: 0x8f8062 });
  const movx = ox + 0.62 * MTW - clampF * 11;
  g.rect(movx, oy + 0.5 * MTH - 24, 7, 20).fill(0xb0a27a).stroke({ width: 0.5, color: 0x8f8062 });
  g.rect(ox + 0.95 * MTW, oy + 0.7 * MTH - 24, 7, 20).fill(0xa89a70).stroke({ width: 0.5, color: 0x8f8062 });
  // 開模瞬間:落下成品 + 模面水氣
  if (running && cyc >= 0.72) {
    const drop = (cyc - 0.72) / 0.28;
    g.roundRect(ox + 0.62 * MTW - 4, oy + 0.9 * MTH - 20 + drop * 24, 9, 8, 2).fill(0xd9a441).stroke({ width: 1, color: 0x8a6b2e });
    vapor(g, ox + 0.75 * MTW, oy + 0.6 * MTH - 14, t, 3, 0xe8ede8, { rise: 16, spread: 5, size: 4, alpha: 0.2, speed: 1.1 });
  }
}

// 兩節手臂 IK:base→target,回傳肘關節與末端(夾爪)點,超出可達範圍時夾到邊界。
export function solveArm(bx: number, by: number, px: number, py: number, L1: number, L2: number) {
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
// 手臂末端目標(取放循環):回傳世界座標與是否夾持。抽出以便畫殘影。
function armTarget(t: number, pickup: P2, drop: P2) {
  const p = (t % 4.5) / 4.5; const es = (f: number) => f * f * (3 - 2 * f);
  let tx: number, ty: number, carry = false;
  if (p < 0.4) { const f = es(p / 0.4); tx = drop[0] + (pickup[0] - drop[0]) * f; ty = drop[1] + (pickup[1] - drop[1]) * f; }
  else if (p < 0.5) { tx = pickup[0]; ty = pickup[1]; carry = p >= 0.45; }
  else if (p < 0.92) { const f = es((p - 0.5) / 0.42); tx = pickup[0] + (drop[0] - pickup[0]) * f; ty = pickup[1] + (drop[1] - pickup[1]) * f; carry = true; }
  else { tx = drop[0]; ty = drop[1]; }
  return { tx, ty, carry };
}
export function mArm(g: Graphics, ox: number, oy: number, t: number, pickup: P2, drop: P2) {
  ishadow(g, ox, oy + 0.2 * MTH, 42, 20, 0.42);
  isoBox3(g, ox - 0.7 * MTW, oy + 0.7 * MTH, 1.4, 1.4, 16, { top: 0xd8c6a8, left: 0xb4a082, right: 0xc4b090 });
  const base: P2 = [ox, oy - 14];
  g.ellipse(base[0], base[1] + 4, 14, 7).fill(0xb09a78).stroke({ width: 1, color: 0x9a8464 });   // 旋轉底座
  g.ellipse(base[0], base[1] + 4, 8, 4).fill(darken(0xb09a78, 1.12));
  // 末端運動殘影(前兩幀微淡):強化「揮臂」的速度感
  for (let k = 2; k >= 1; k--) {
    const gt = armTarget(t - k * 0.05, pickup, drop);
    const s = solveArm(base[0], base[1], gt.tx, gt.ty, 42, 34);
    g.circle(s.end.x, s.end.y, 4).fill({ color: 0xe6d9bf, alpha: 0.12 * k });
  }
  const { tx, ty, carry } = armTarget(t, pickup, drop);
  const { joint, end } = solveArm(base[0], base[1], tx, ty, 42, 34);
  // 底座→大臂的懸垂線纜
  const midx = (base[0] + joint.x) / 2, midy = (base[1] + joint.y) / 2 + 6;
  g.moveTo(base[0], base[1]).quadraticCurveTo(midx, midy, joint.x, joint.y).stroke({ width: 1.4, color: 0x6b5842, alpha: 0.7 });
  g.moveTo(base[0], base[1]).lineTo(joint.x, joint.y).stroke({ width: 11, color: 0xd47a3f, cap: "round" });      // 大臂橘
  g.moveTo(base[0], base[1]).lineTo(joint.x, joint.y).stroke({ width: 4, color: darken(0xd47a3f, 1.25), cap: "round" });
  g.moveTo(joint.x, joint.y).lineTo(end.x, end.y).stroke({ width: 7, color: 0xe6d9bf, cap: "round" });           // 小臂銀
  g.circle(base[0], base[1], 6).fill(0xb5622e).stroke({ width: 1.5, color: 0x9a8464 });
  g.circle(joint.x, joint.y, 5).fill(0xb5622e).stroke({ width: 1.5, color: 0x9a8464 });
  g.circle(joint.x, joint.y, 1.8).fill({ color: 0x62d06a, alpha: 0.5 + 0.5 * Math.abs(Math.sin(t * 4)) });        // 伺服燈
  const d = Math.atan2(end.y - joint.y, end.x - joint.x), gap = carry ? 3 : 6;
  const nx = Math.cos(d + Math.PI / 2) * gap, ny = Math.sin(d + Math.PI / 2) * gap;
  g.moveTo(end.x, end.y).lineTo(end.x + nx + Math.cos(d) * 7, end.y + ny + Math.sin(d) * 7).stroke({ width: 3, color: 0xc0b088 });
  g.moveTo(end.x, end.y).lineTo(end.x - nx + Math.cos(d) * 7, end.y - ny + Math.sin(d) * 7).stroke({ width: 3, color: 0xc0b088 });
  if (carry) { g.rect(end.x - 5, end.y - 3, 11, 9).fill(0xd9a441); g.rect(end.x - 5, end.y - 3, 11, 3).fill(0xf0c674); }
}

export function mCompressor(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.3 * MTW, oy + 1.2 * MTH, 52, 24, 0.4);
  isoBox3(g, ox, oy, 2.2, 1.3, 26, { top: 0xb4a67e, left: 0x8f8062, right: 0xa89a70 });
  // 儲氣槽散熱鰭片(頂面幾道細線)
  for (let i = 1; i <= 4; i++) g.moveTo(ox + i * 0.4 * MTW, oy + i * 0.4 * MTH - 26).lineTo(ox + i * 0.4 * MTW + 0.9 * MTW, oy + i * 0.4 * MTH + 0.9 * MTH - 26).stroke({ width: 0.7, color: darken(0xb4a67e, 0.8), alpha: 0.6 });
  isoBox3(g, ox + 1.6 * MTW, oy + 1.6 * MTH - 26, 0.7, 0.7, 20, { top: 0xd0bd98, left: 0xa88f6c, right: 0xc0ad8a });
  // 皮帶輪罩 + 冷卻風扇(高速→殘影盤)
  const fx = ox + 0.2 * MTW, fy = oy + 0.7 * MTH - 13, rot = running ? t * 9 : 0;
  g.circle(fx, fy, 12).fill({ color: 0x8f8062, alpha: 0.35 }).stroke({ width: 1, color: 0xa2917a });
  if (running) blurDisc(g, fx, fy, 10, 0x9fc088, 0.4);
  for (let i = 0; i < 4; i++) { const a = rot + i * Math.PI / 2; g.moveTo(fx, fy).lineTo(fx + Math.cos(a) * 9, fy + Math.sin(a) * 9).stroke({ width: 2.5, color: running ? 0x8fc088 : 0xa2917a, cap: "round" }); }
  g.circle(fx, fy, 2.5).fill(0xc0b088);
  // 壓力錶:指針隨壓力循環擺動
  const gx = ox + 1.9 * MTW, gy = oy + 1.9 * MTH - 26, press = running ? 0.5 + 0.45 * Math.sin(t * 1.6) : 0.15;
  g.circle(gx, gy, 5).fill(0xf0e6d4).stroke({ width: 1, color: 0x8a7658 });
  const na = -2.4 + press * 1.9;
  g.moveTo(gx, gy).lineTo(gx + Math.cos(na) * 4, gy + Math.sin(na) * 4).stroke({ width: 1.3, color: 0xc85a4a, cap: "round" });
  g.circle(gx, gy, 1).fill(0x8a7658);
  // 洩壓閥水氣(壓力高時噴)
  if (running && press > 0.7) vapor(g, ox + 2.15 * MTW, oy + 2.15 * MTH - 22, t, 3, 0xe8ede8, { rise: 14, spread: 6, size: 3.5, alpha: 0.22, speed: 1.4 });
}

export function mTurbine(g: Graphics, ox: number, oy: number, t: number, rpm: number) {
  ishadow(g, ox, oy + 0.1 * MTH, 20, 10, 0.35);
  g.poly([ox - 3, oy, ox + 3, oy, ox + 1.5, oy - 64, ox - 1.5, oy - 64]).fill(lgrad(ox - 3, oy, ox + 3, oy, 0xd8c6a8, 0xb8a884));  // 錐形塔
  const hx = ox - 5, hy = oy - 66;
  // 機艙(nacelle)
  g.roundRect(hx - 8, hy - 4, 20, 8, 2).fill(lgrad(hx - 8, hy - 4, hx + 12, hy + 4, 0xd8c6a8, 0xb8a884)).stroke({ width: 0.8, color: 0xc9b795 });
  const spd = 0.5 + (rpm || 8) * 0.08, rot = t * spd;
  // 高速時殘影盤,讓葉片「化成一片」
  if (spd > 1.2) blurDisc(g, hx, hy, 26, 0xf0e6d4, 0.3);
  for (let i = 0; i < 3; i++) {
    const a = rot + i * 2 * Math.PI / 3, tipx = hx + Math.cos(a) * 26, tipy = hy + Math.sin(a) * 26;
    const px = Math.cos(a + Math.PI / 2), py = Math.sin(a + Math.PI / 2);   // 葉片加寬成尖錐
    g.poly([hx + px * 2.4, hy + py * 2.4, hx - px * 2.4, hy - py * 2.4, tipx, tipy]).fill({ color: 0xf0e6d4, alpha: 0.95 }).stroke({ width: 0.6, color: 0xc9b795 });
  }
  g.circle(hx, hy, 3.8).fill(0xb5622e).stroke({ width: 0.8, color: 0x8a5c2e });
  // 塔頂航空警示燈(慢閃紅)
  if (Math.sin(t * 2) > 0.4) emissive(g, hx + 12, hy - 3, 1.6, 0xe0604a, 0.9);
}

export function mChamber(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.2 * MTW, oy + 1.3 * MTH, 52, 24, 0.4);
  isoBox3(g, ox, oy, 2.0, 1.8, 34, { top: 0xac9674, left: 0x9a8464, right: 0xac9674 });
  const vx = ox + 0.5 * MTW, vy = oy + 1.3 * MTH - 14;
  const gz = running ? 0.5 + 0.4 * Math.abs(Math.sin(t * 3)) : 0.12;
  // 電漿觀察窗:色彩微循環的紫光 + 內部旋轉粒子
  if (running) {
    const hue = 0.5 + 0.5 * Math.sin(t * 1.3);
    iglow(g, vx, vy, 24, `rgba(${150 + hue * 40},${100 + hue * 30},${210 + hue * 30},${gz})`);
  }
  g.circle(vx, vy, 10).fill({ color: running ? 0x9c6bce : 0xac9674, alpha: running ? 0.9 : 1 });
  if (running) for (let i = 0; i < 6; i++) {
    const a = t * 2.2 + i * Math.PI / 3, rr = 3 + 4 * (0.5 + 0.5 * Math.sin(t * 3 + i));
    g.circle(vx + Math.cos(a) * rr, vy + Math.sin(a) * rr * 0.7, 1.3).fill({ color: 0xe6d0ff, alpha: 0.8 });
  }
  g.circle(vx, vy, 10).stroke({ width: 2.5, color: 0xc9b795 });
  // 氣管 + 流動氣體虛線(運轉時往上流)
  g.moveTo(ox + 0.5 * MTW, oy + 0.5 * MTH - 34).lineTo(ox + 0.5 * MTW, oy + 0.5 * MTH - 48).stroke({ width: 3, color: 0xc9b795 });
  if (running) for (let i = 0; i < 3; i++) { const fy = ((t * 0.8 + i / 3) % 1); g.circle(ox + 0.5 * MTW, oy + 0.5 * MTH - 34 - fy * 14, 1).fill({ color: 0xbfa0e0, alpha: 0.7 * (1 - fy) }); }
  // 真空泵(運轉微震)
  const vb = running ? Math.sin(t * 20) * 0.6 : 0;
  isoBox3(g, ox + 1.8 * MTW, oy + 1.8 * MTH - vb, 0.6, 0.6, 12, { top: 0xac9674, left: 0x968060, right: 0xa08a6a });
}

export function mMeter(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.1 * MTW, oy + 0.9 * MTH, 40, 20, 0.38);
  isoBox3(g, ox, oy, 1.5, 1.2, 40, { top: 0xa8a080, left: 0x8f8062, right: 0xa89a70 });
  const px = ox + 0.75 * MTW, py = oy + 0.4 * MTH - 26;
  // 顯示螢幕:即時波形 + 跳動長條(取代單一亮條,讀數更「活」)
  g.rect(px - 14, py - 8, 28, 16).fill(0x22301f).stroke({ width: 1, color: 0x6f855a });
  if (running) {
    let prevx = px - 12, prevy = py - 2 + Math.sin(t * 5) * 3;
    for (let i = 1; i <= 12; i++) { const xx = px - 12 + i * 2, yy = py - 2 + Math.sin(t * 5 + i * 0.7) * 3.2; g.moveTo(prevx, prevy).lineTo(xx, yy).stroke({ width: 1, color: 0x62d06a, alpha: 0.85 }); prevx = xx; prevy = yy; }
    for (let i = 0; i < 4; i++) g.rect(px - 12 + i * 3.4, py + 5 - 2 * Math.abs(Math.sin(t * 4 + i)), 2.4, 2 + 2 * Math.abs(Math.sin(t * 4 + i))).fill({ color: 0x8fd08a, alpha: 0.7 });
  } else { g.rect(px - 10, py, 20, 1.4).fill({ color: 0x3f5a37, alpha: 0.7 }); }
  // 三色狀態燈
  for (let i = 0; i < 3; i++) { const on = running && Math.sin(t * 4 + i * 2) > -0.2; const cc = [0xc85a4a, 0xf0c674, 0x5a9e5a][i];
    if (on) emissive(g, px - 8 + i * 8, py + 16, 2.6, cc, 0.9); else g.circle(px - 8 + i * 8, py + 16, 2.6).fill(0xd0bd98); }
}

export function mPress(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.1 * MTW, oy + 1.0 * MTH, 44, 22, 0.4);
  // 沖壓節拍:快速下衝→撞擊→回升(非對稱,更像真沖床)
  const cyc = running ? (t * 0.8) % 1 : 0.5;
  const press = !running ? 0.15 : cyc < 0.45 ? cyc / 0.45 : 1 - (cyc - 0.45) / 0.55;
  const impact = running && cyc >= 0.42 && cyc < 0.52;                    // 撞擊瞬間
  const shake = impact ? Math.sin(t * 60) * 1.2 : 0;                       // 撞擊機架微震
  isoBox3(g, ox, oy - shake, 0.6, 1.6, 52, { top: 0xa99372, left: 0x9a8464, right: 0xac9674 });       // 立柱
  isoBox3(g, ox, oy - 52 - shake, 2.2, 1.6, 10, { top: 0xd8c6a8, left: 0xb4a082, right: 0xc4b090 });   // 上樑
  // 側邊飛輪(旋轉,帶輻條)
  const flx = ox + 0.15 * MTW, fly = oy - 30, frot = running ? t * 4 : 0;
  g.circle(flx, fly, 9).fill({ color: 0xb4a082, alpha: 0.9 }).stroke({ width: 1.5, color: 0x8f8062 });
  for (let i = 0; i < 3; i++) { const a = frot + i * 2 * Math.PI / 3; g.moveTo(flx, fly).lineTo(flx + Math.cos(a) * 8, fly + Math.sin(a) * 8).stroke({ width: 1.2, color: 0x8a7658 }); }
  g.circle(flx, fly, 2).fill(0x6b5842);
  isoBox3(g, ox + 1.4 * MTW, oy + 1.4 * MTH, 1.0, 0.6, 12, { top: 0xc7b592, left: 0x9a8464, right: 0xb4a082 });  // 工作台
  const slx = ox + 1.55 * MTW, sly = oy + 0.4 * MTH - 40 + press * 26;
  g.rect(slx, sly, 20, 12).fill(lgrad(slx, sly, slx, sly + 12, 0xcabf9a, 0xd8c6a8)).stroke({ width: 1, color: 0xa99372 });   // 滑塊
  g.rect(slx + 3, oy + 1.0 * MTH - 6, 14, 4).fill(running ? 0xf0c674 : 0xa2917a);
  // 撞擊:白閃 + 火花四濺
  if (impact) {
    iglow(g, slx + 10, oy + 1.0 * MTH - 2, 16, "rgba(255,244,210,0.9)");
    sparks(g, slx + 10, oy + 1.0 * MTH - 2, t, 9, { up: -0.2, spread: 3.2, reach: 20, grav: 10, speed: 3 });
  } else if (running && press > 0.8) iglow(g, slx + 10, oy + 1.0 * MTH - 4, 12, "rgba(255,220,140,0.6)");
}

export function mFurnace(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  ishadow(g, ox + 0.2 * MTW, oy + 1.3 * MTH, 52, 24, 0.4);
  isoBox3(g, ox, oy, 2.0, 1.7, 34, { top: 0x8a7452, left: 0x6b5842, right: 0x7a6650 });
  const dx = ox + 0.55 * MTW, dy = oy + 1.2 * MTH - 14;
  // 爐火:多層閃動熱光(橘→黃循環)+ 爐門縫透光
  const flick = running ? 0.6 + 0.35 * Math.sin(t * 8) * Math.sin(t * 5.3) : 0.1;
  if (running) {
    iglow(g, dx, dy, 26, `rgba(255,110,40,${0.45 * flick + 0.25})`);
    iglow(g, dx, dy, 15, `rgba(255,190,90,${0.5 * flick})`);
  }
  g.rect(dx - 11, dy - 10, 22, 20).fill({ color: running ? darken(0xd47a3f, 0.9 + flick * 0.5) : 0x7a6248, alpha: running ? 0.92 : 1 }).stroke({ width: 2, color: 0x8a6b4a });  // 爐門
  if (running) { g.rect(dx - 11, dy - 10, 22, 2).fill({ color: 0xffd27a, alpha: 0.8 * flick }); g.rect(dx - 11, dy + 8, 22, 2).fill({ color: 0xffb060, alpha: 0.7 * flick }); }  // 門縫透光
  // 排氣管 + 熱煙 + 火星
  g.moveTo(ox + 1.7 * MTW, oy + 1.7 * MTH - 34).lineTo(ox + 1.7 * MTW, oy + 1.7 * MTH - 52).stroke({ width: 3.5, color: 0xc9b795 });
  if (running) {
    vapor(g, ox + 1.7 * MTW, oy + 1.7 * MTH - 52, t, 4, 0xcabfa8, { rise: 26, spread: 6, size: 4.5, alpha: 0.3, speed: 0.6 });
    for (let i = 0; i < 4; i++) { const ph = ((t * 0.8 + hsh(i * 4.4)) % 1 + 1) % 1; g.circle(dx + (hsh(i) - 0.5) * 16, dy - ph * 24, 1 * (1 - ph)).fill({ color: 0xffb060, alpha: 0.7 * (1 - ph) }); }
  }
}

export function mAGV(g: Graphics, ox: number, oy: number, t: number, running: boolean) {
  const bob = running ? Math.sin(t * 3) * 1 : 0;
  ishadow(g, ox, oy + 0.1 * MTH, 30, 15, 0.4);
  isoBox3(g, ox - 0.7 * MTW, oy + 0.7 * MTH - bob, 1.4, 1.0, 12, { top: 0x8aa06a, left: 0x6f855a, right: 0x8aa06a });
  g.rect(ox - 6, oy - 20 - bob, 12, 8).fill(0xd9a441); g.rect(ox - 6, oy - 20 - bob, 12, 2.5).fill(0xf0c674);   // 貨件
  // 前方 LiDAR 掃描扇形(往行進方向掃)
  if (running) {
    const sweep = Math.sin(t * 3) * 0.5;
    const bx = ox + 0.75 * MTW - 2, by = oy + 0.75 * MTH - 6 - bob;
    g.moveTo(bx, by).arc(bx, by, 20, -0.5 + sweep - 0.35, -0.5 + sweep + 0.35).fill({ color: 0x8fd0a0, alpha: 0.14 });
  }
  // 頂部旋轉警示燈(黃燈掃)
  const beac = 0.5 + 0.5 * Math.sin(t * 5);
  emissive(g, ox, oy - 24 - bob, 1.6 + beac * 1.2, running ? 0xf0c050 : 0xa2917a, running ? 0.8 : 0.4);
  const on = Math.sin(t * 6) > 0; g.circle(ox + 0.7 * MTW - 4, oy + 0.7 * MTH - 8 - bob, 2).fill(on ? 0x5a9e5a : 0x6f855a);   // 狀態燈
}

// 各機台的中心偏移(anchor=地面原點角,調到坐落在站位中央)
export const MOFF: Record<string, P2> = {
  cnc_machining_center: [-38, -12], injection_molding: [-30, -8], robot_arm_6axis: [2, 4],
  air_compressor: [-32, -4], wind_turbine: [8, 30], semi_process_chamber: [-30, -8],
  energy_meter: [-16, 0], stamping_press: [-18, 6], heat_treat_furnace: [-30, -8], agv_mobile_robot: [6, 2],
};
export function drawStation(g: Graphics, tmpl: string, t: Record<string, number>, running: boolean, animT: number, _col: number, fault: boolean) {
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
    default: isoBox3(g, ox, oy, 1.6, 1.4, 24, { top: 0xc8b48e, left: 0xa08a6a, right: 0xac9674 });
  }
}
