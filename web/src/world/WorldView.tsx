import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
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
  const cL = darken(roof, 0.62), cR = darken(roof, 0.8);
  g.poly([W.x, W.y, S.x, S.y, up(S).x, up(S).y, up(W).x, up(W).y]).fill(cL);                  // 左牆(暗)
  g.poly([S.x, S.y, E.x, E.y, up(E).x, up(E).y, up(S).x, up(S).y]).fill(cR);                  // 右牆
  // 牆面紋路:樓層橫線 + 窗格直線(低 alpha,做出建築立面質感)
  const floors = Math.max(2, Math.floor(height / 13));
  for (let k = 1; k < floors; k++) {
    const f = k / floors;
    g.moveTo(up(W, f).x, up(W, f).y).lineTo(up(S, f).x, up(S, f).y).stroke({ width: 1, color: darken(roof, 0.45), alpha: 0.45 });
    g.moveTo(up(S, f).x, up(S, f).y).lineTo(up(E, f).x, up(E, f).y).stroke({ width: 1, color: darken(roof, 0.6), alpha: 0.4 });
  }
  const colsL = Math.max(2, Math.round(h * 1.4));
  for (let c = 1; c < colsL; c++) {
    const b = lerp2(W, S, c / colsL);
    g.moveTo(b.x, b.y).lineTo(b.x, b.y - height).stroke({ width: 1, color: darken(roof, 0.5), alpha: 0.3 });
  }
  const colsR = Math.max(2, Math.round(w * 1.4));
  for (let c = 1; c < colsR; c++) {
    const b = lerp2(S, E, c / colsR);
    g.moveTo(b.x, b.y).lineTo(b.x, b.y - height).stroke({ width: 1, color: darken(roof, 0.66), alpha: 0.28 });
  }
  // 窗光:右牆(受光面)部分窗格點亮 → 夜間廠房感(冷藍 / 暖黃,確定性)
  const wseed = (gx * 73 + gy * 131) | 0;
  for (let c = 1; c < colsR; c++) for (let k = 1; k < floors; k++) {
    if (((wseed + c * 17 + k * 7) % 5) !== 0) continue;
    const b = lerp2(S, E, (c - 0.5) / colsR);
    const y = b.y - height * ((k - 0.35) / floors);
    const warm = ((wseed + c + k) % 2) === 0;
    g.rect(b.x - 1.4, y - 2.2, 2.8, 3.2).fill({ color: warm ? 0xe2b24e : 0x7fd0e6, alpha: 0.5 });
  }
  g.poly([up(N).x, up(N).y, up(E).x, up(E).y, up(S).x, up(S).y, up(W).x, up(W).y])
    .fill(roof).stroke({ width: 1, color: darken(roof, 1.15) });                              // 屋頂
  // 屋頂受光邊 rim 高光(左上兩邊)+ 較大建築放空調機/天窗,屋頂不再是死平面
  const hi = darken(roof, 1.4);
  g.moveTo(up(N).x, up(N).y).lineTo(up(W).x, up(W).y).stroke({ width: 1.5, color: hi, alpha: 0.6 });
  g.moveTo(up(N).x, up(N).y).lineTo(up(E).x, up(E).y).stroke({ width: 1.2, color: hi, alpha: 0.4 });
  if (height > 26) {
    const cx = (up(N).x + up(S).x) / 2, cy = (up(N).y + up(S).y) / 2;
    g.rect(cx - 5, cy - 6, 10, 6).fill(darken(roof, 0.72)).stroke({ width: 0.6, color: hi, alpha: 0.5 });  // 空調機
    g.rect(cx - 3, cy - 5, 6, 1.5).fill({ color: hi, alpha: 0.45 });                                       // 天窗反光
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
          light.circle(0, 0, 10).fill({ color: 0x35d07a, alpha: 0.09 });
          light.circle(0, 0, 6.5).fill(0x35d07a).stroke({ width: 2, color: 0x10151d });
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
        const armCtx = st.template === "robot_arm_6axis" ? computeArmCtx(st, animT, running) : null;
        drawStation(st.art, st.template, t, running, animT, col, armCtx);
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

    // 手臂目標(local 座標)+ 是否夾著工件:搬運手臂走產線編排,其餘手臂自走 pick-place
    function computeArmCtx(st: Station, animT: number, running: boolean) {
      const flow = flowRef.current; const cont = st.container;
      if (flow && flow.pickerId === st.id) {
        const p = (animT % ARM_CYCLE) / ARM_CYCLE;
        let wt: Pt, carrying = false;
        if (p < 0.40) wt = lerpPt(flow.drop, flow.pickup, ease(p / 0.40));           // 空手上行取件
        else if (p < 0.50) { wt = flow.pickup; carrying = p >= 0.45; }                // 夾取
        else if (p < 0.92) { wt = lerpPt(flow.pickup, flow.drop, ease((p - 0.50) / 0.42)); carrying = true; } // 搬下放帶
        else wt = flow.drop;                                                          // 放開
        return { tx: wt.x - cont.x, ty: wt.y - cont.y, carrying };
      }
      // 非搬運手臂:左右擺動的 pick-place,僅當運轉時夾著工件
      const off = st.id.length * 0.7;
      const s = (Math.sin(animT * 1.05 + off) + 1) / 2;
      return { tx: -24 + 48 * s, ty: 16 - 12 * Math.sin(Math.PI * s), carrying: running && Math.cos(animT * 1.05 + off) > 0 };
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

    function drawStation(g: Graphics, tmpl: string, t: Record<string, number>, running: boolean, animT: number, col: number,
                         armCtx?: { tx: number; ty: number; carrying: boolean } | null) {
      // 接地徑向陰影(讓每台機台坐在地上、有量體感)
      g.ellipse(1, 27, 27, 11).fill({ color: 0x000000, alpha: 0.13 });
      g.ellipse(0, 26, 22, 9).fill({ color: 0x000000, alpha: 0.14 });
      if (tmpl === "robot_arm_6axis") {
        // 六軸手臂:底座 + 轉盤 + 兩節臂 IK 伸向目標 + 夾爪(編排驅動,平滑不跳動)
        g.ellipse(0, 22, 20, 9).fill(0x2c3650);                       // 地座陰影
        g.roundRect(-14, 6, 28, 18, 3).fill(0x3a4862).stroke({ width: 1, color: 0x4d5e7e }); // 底座
        g.roundRect(-9, 0, 18, 9, 2).fill(0x46587a);                  // 轉盤
        const base = { x: 0, y: 2 };
        const tx = armCtx?.tx ?? 28, ty = armCtx?.ty ?? 6;            // 預設略向右伸
        const { joint, end } = solveArm(base.x, base.y, tx, ty, 28, 22);
        g.moveTo(base.x, base.y).lineTo(joint.x, joint.y).stroke({ width: 8, color: 0xf08c2e, cap: "round" }); // 大臂
        g.moveTo(joint.x, joint.y).lineTo(end.x, end.y).stroke({ width: 5, color: 0xcdd9ec, cap: "round" });   // 小臂
        g.circle(base.x, base.y, 4).fill(0x5b9bd5).stroke({ width: 1, color: 0x2c3650 });
        g.circle(joint.x, joint.y, 3.4).fill(0x5b9bd5).stroke({ width: 1, color: 0x2c3650 });
        // 夾爪(夾著工件時收合)
        const d = Math.atan2(end.y - joint.y, end.x - joint.x);
        const gap = armCtx?.carrying ? 3 : 5.5;
        const nx = Math.cos(d + Math.PI / 2) * gap, ny = Math.sin(d + Math.PI / 2) * gap;
        g.moveTo(end.x, end.y).lineTo(end.x + nx + Math.cos(d) * 6, end.y + ny + Math.sin(d) * 6).stroke({ width: 3, color: col });
        g.moveTo(end.x, end.y).lineTo(end.x - nx + Math.cos(d) * 6, end.y - ny + Math.sin(d) * 6).stroke({ width: 3, color: col });
        if (armCtx?.carrying) g.roundRect(end.x - 5, end.y - 4, 10, 9, 1.5).fill(0xd9a441).stroke({ width: 1, color: 0x8a6b2e }); // 夾持工件
      } else if (tmpl === "cnc_machining_center") {
        g.roundRect(-20, -4, 40, 30, 3).fill(0x37445c).stroke({ width: 1, color: 0x4a5a78 });
        g.rect(-20, -4, 40, 7).fill({ color: 0x4c6088, alpha: 0.45 });           // 頂部受光高光
        g.roundRect(-14, -22, 28, 18, 3).fill(0x2c3850).stroke({ width: 1, color: 0x3d4c66 }); // 主軸箱
        g.roundRect(8, -1, 10, 8, 1.5).fill(running ? 0x0f2e1e : 0x1c1414);      // HMI 螢幕
        g.rect(9.5, 1.5, 7, 1.4).fill(running ? 0x6cf0a0 : 0x5a2a2a);
        const spin = running ? animT * 9 : 0; const sx = Math.cos(spin) * 7;
        if (running) emissive(g, 0, -13, 3.2, 0xffd479, 0.55 + 0.45 * Math.abs(Math.sin(animT * 4))); // 主軸暖黃發光
        g.moveTo(-sx, -13).lineTo(sx, -13).stroke({ width: 3, color: running ? 0xffe6a0 : 0x6b7488 });
        g.circle(0, -13, 2).fill(0x8a93a6);
        g.rect(-16, 20, 32, 4).fill(darken(col, 0.7));               // 護門底飾
      } else if (tmpl === "injection_molding") {
        g.roundRect(-26, 0, 22, 24, 3).fill(0x3a4a44).stroke({ width: 1, color: 0x4d6158 });   // 鎖模單元
        g.rect(-26, 0, 22, 6).fill({ color: 0x51695f, alpha: 0.45 });                            // 頂高光
        const clamp = running ? 3 + 3 * Math.abs(Math.sin(animT * 2)) : 6;
        g.rect(-6 - clamp, 4, 6, 16).fill(0x5b7a6e); g.rect(0, 4, 6, 16).fill(0x5b7a6e);        // 動/定模板
        g.roundRect(6, 6, 26, 12, 3).fill(0x46506a).stroke({ width: 1, color: 0x5b6b8e });      // 射出單元
        if (running) emissive(g, 14, 12, 3, 0xff8c3c, 0.6);                                      // 加熱段橘光
        g.circle(32, 12, 3).fill(running ? 0xffd479 : 0x6b7488);                                 // 料斗
      } else if (tmpl === "air_compressor") {
        g.roundRect(-18, -4, 36, 28, 6).fill(0x3a4a44).stroke({ width: 1, color: 0x4d6158 });    // 桶
        g.rect(-18, -4, 36, 7).fill({ color: 0x51695f, alpha: 0.4 });                            // 頂高光
        const rot = running ? animT * 6 : 0;
        for (let i = 0; i < 4; i++) { const a = rot + i * Math.PI / 2; g.moveTo(0, 8).lineTo(Math.cos(a) * 10, 8 + Math.sin(a) * 10).stroke({ width: 3, color: running ? 0x9fe0c0 : 0x6b7488 }); }
        g.circle(0, 8, 2.5).fill(0x8a93a6);
        const pl = running && Math.sin(animT * 3) > 0;
        g.circle(13, -0, 2).fill(pl ? 0x35d07a : 0x2a4a38);                                       // 壓力綠燈脈動
      } else if (tmpl === "wind_turbine") {
        g.poly([-3, 26, 3, 26, 1.5, -14, -1.5, -14]).fill(0xc9d4e4);                              // 塔
        g.roundRect(-5, -18, 14, 7, 2).fill(0x9fb0c4);                                            // 機艙
        const rpm = t["rotor_rpm"] ?? 0; const rot = animT * (0.4 + rpm * 0.25);                  // 轉速 ∝ rpm
        const hub = { x: -5, y: -14 };
        for (let i = 0; i < 3; i++) { const a = rot + i * 2 * Math.PI / 3;
          g.moveTo(hub.x, hub.y).lineTo(hub.x + Math.cos(a) * 22, hub.y + Math.sin(a) * 22).stroke({ width: 3, color: 0xeef3f9, cap: "round" }); }
        g.circle(hub.x, hub.y, 3).fill(col);
      } else if (tmpl === "semi_process_chamber") {
        // 製程腔體:腔身 + 觀景窗(運轉時電漿輝光脈動)+ 上方氣管 + 下方真空泵
        g.roundRect(-18, -6, 34, 30, 6).fill(0x2f3a52).stroke({ width: 1, color: 0x4a5a78 });     // 腔身
        g.rect(-18, -6, 34, 7).fill({ color: 0x445273, alpha: 0.45 });                             // 頂高光
        if (running) emissive(g, -1, 8, 8, 0x8f6bd6, 0.5 + 0.4 * Math.abs(Math.sin(animT * 3)));   // 電漿輝光
        else g.circle(-1, 8, 8).fill({ color: 0x3a4660, alpha: 0.25 });
        g.circle(-1, 8, 9).stroke({ width: 2, color: 0x6b7da0 });                                 // 觀景窗框
        g.rect(-12, -12, 4, 7).fill(0x9fb0c4); g.rect(6, -12, 4, 7).fill(0x9fb0c4);               // 兩支氣管
        g.roundRect(-10, 22, 22, 8, 2).fill(darken(col, 0.7)).stroke({ width: 1, color: 0x4a5a78 }); // 真空泵
      } else if (tmpl === "energy_meter") {
        // 配電 / 電表箱:箱體 + 數字面板 + 三相指示燈 + 電力 LED(運轉時脈動)
        g.roundRect(-15, -10, 30, 34, 3).fill(0x394a40).stroke({ width: 1, color: 0x4d6158 });    // 箱體
        g.rect(-15, -10, 30, 7).fill({ color: 0x51695f, alpha: 0.4 });                             // 頂高光
        g.roundRect(-11, -6, 22, 9, 1.5).fill(0x0c2417);                                          // 數字面板
        g.rect(-9, -1, 18, 2).fill(running ? 0x6cf0a0 : 0x3a6b50);                                // 面板讀數
        for (let i = 0; i < 3; i++) { const on = running && Math.sin(animT * 4 + i * 2) > -0.2;
          const cc = [0xff6b6b, 0xffd479, 0x6cf0a0][i];
          if (on) emissive(g, -7 + i * 7, 12, 2.4, cc, 0.9); else g.circle(-7 + i * 7, 12, 2.4).fill(0x46506a); } // L1/L2/L3
        g.circle(10, -6, 2).fill(running ? 0xffe08a : 0x6b7488);                                  // 電力 LED
      } else if (tmpl === "stamping_press") {
        // 沖壓機:C 型機架 + 上下往復滑塊(運轉時衝壓)
        g.roundRect(-16, -18, 10, 44, 2).fill(0x3a4658).stroke({ width: 1, color: 0x4d5e7e });    // 立柱
        g.roundRect(-16, -18, 34, 8, 2).fill(0x46587a);                                           // 上樑
        g.roundRect(-16, 20, 34, 8, 2).fill(darken(col, 0.7));                                     // 工作台
        const pr = running ? Math.abs(Math.sin(animT * 6)) : 0.2;
        if (running && pr > 0.9) emissive(g, 8, 23, 4, 0xffe6a0, 1.2 * (pr - 0.9) * 10);           // 衝壓瞬間亮點
        g.roundRect(0, -8 + pr * 16, 16, 8, 1.5).fill(0x9aa6ba).stroke({ width: 1, color: 0x5b6b8e }); // 滑塊
        g.rect(2, 24, 12, 3).fill(running ? 0xffd479 : 0x6b7488);                                  // 工件
      } else if (tmpl === "heat_treat_furnace") {
        // 熱處理爐:爐體 + 爐門(運轉時橘紅輝光脈動)+ 排氣管
        g.roundRect(-18, -8, 36, 34, 4).fill(0x40382f).stroke({ width: 1, color: 0x5a4d3e });      // 爐體(耐火磚色)
        g.rect(-18, -8, 36, 7).fill({ color: 0x55483a, alpha: 0.5 });                              // 頂高光
        if (running) { emissive(g, 0, 9, 10, 0xff7a3a, 0.5 + 0.35 * Math.abs(Math.sin(animT * 2))); // 爐門橘紅火光
          g.roundRect(-11, 0, 22, 18, 2).stroke({ width: 1.5, color: 0xffb072 }); }
        else { g.roundRect(-11, 0, 22, 18, 2).fill(0x2a1e18).stroke({ width: 1.5, color: 0x6b5036 }); }
        g.rect(10, -16, 5, 10).fill(0x9fb0c4);                                                      // 排氣管
      } else {
        g.roundRect(-16, -4, 32, 26, 3).fill(0x3a4356).stroke({ width: 1, color: col });
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
