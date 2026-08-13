import { useEffect, useMemo, useRef, useState } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import { Park, Company, SupplyLinkView, TelemetryMsg, getTeacherToken, setCoil, resetDevice } from "../api";
import { darken } from "./machines";
import FactoryLine3D from "./FactoryLine3D";
import { layoutLine } from "./processFlow";

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
const ROOFS = [0xc0a878, 0xb59a6a, 0xa8a880, 0xbcac86, 0xb59a6a, 0xb0a878, 0xb89a80];
// 公司建築多彩色盤(較飽和,讓園區有大有小、多彩)
const COMPANY_COLORS = [0xc8a06a, 0x8aa06a, 0xc07a3a, 0xb08a6a, 0x8fa85a, 0xc0785a,
  0x9ab08a, 0xc0923e, 0xb8a070, 0xb56a4a, 0x9ab48a, 0xbfa080];

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
  const LIT = 0xf0c674, UNLIT = 0xcbb896;
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
  g.rect(cx - 1.3 * s, cy - 5 * s, 2.6 * s, 6 * s).fill(0x9c7b52);                                // 樹幹
  const greens = [0x6f855a, 0x8aa06a, 0x9ab06a];
  for (let k = 0; k < 3; k++) {
    const yy = cy - 5 * s - k * 3.6 * s, rr = (8.5 - k * 1.7) * s;
    g.circle(cx - 1.6 * s, yy, rr).fill(darken(greens[k], 0.78));    // 背光側(暗)
    g.circle(cx + 1.6 * s, yy, rr).fill(greens[k]);                  // 受光側
  }
  g.circle(cx + 2.4 * s, cy - 13 * s, 2.4 * s).fill({ color: 0x9fc07a, alpha: 0.55 });            // 高光
}

// 俯瞰層仍是 PixiJS(公司量體 / 燈號 / 煙囪);廠內層已全面改 3D(FactoryLine3D)。
// 先前 2D 廠內產線的 Station / Flow / Part / TendingCell 等結構已隨之移除。
interface Smoke { g: Graphics; x: number; y: number; vy: number; life: number; max: number; }
type Pt = { x: number; y: number };

export default function WorldView({
  park, telemetry, selected, onSelect, predicted,
}: {
  park: Park; telemetry: TelemetryMsg | null;
  selected: string | null; onSelect: (id: string) => void; predicted: Set<string>;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number; c: Company } | null>(null);
  const [resetMsg, setResetMsg] = useState("");
  // 說明卡預設展開(學生一進廠要先讀到這條產線在做什麼),但要能收起來 ——
  // 卡片壓在 3D 畫面上,不收就永遠擋著機台。
  const [infoOpen, setInfoOpen] = useState(true);
  const isTeacher = !!getTeacherToken();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const lightsRef = useRef<Record<string, Graphics>>({});
  const chimneysRef = useRef<{ x: number; y: number }[]>([]);
  const smokeRef = useRef<Smoke[]>([]);
  const fxRef = useRef<Container | null>(null);
  const telRef = useRef(telemetry);
  const onSelectRef = useRef(onSelect); const selectedRef = useRef(selected); const predictedRef = useRef(predicted);
  telRef.current = telemetry; onSelectRef.current = onSelect; selectedRef.current = selected; predictedRef.current = predicted;

  useEffect(() => {
    let cancelled = false, ready = false;
    const host = hostRef.current!;
    const app = new Application();
    const safeDestroy = () => { try { app.destroy(true, { children: true }); } catch { /* */ } };

    (async () => {
      await app.init({ background: focus ? 0xe6dccb : 0xefe6d6, antialias: true,
                       width: host.clientWidth || 800, height: host.clientHeight || 600 });
      if (cancelled) { safeDestroy(); return; }
      ready = true; appRef.current = app; host.appendChild(app.canvas);
      const world = new Container(); app.stage.addChild(world); worldRef.current = world;
      recenter();
      buildOverview(world);
      const fx = new Container(); world.addChild(fx); fxRef.current = fx;
      let animT = 0;
      app.ticker.add((tk) => { animT += tk.deltaMS / 1000; tickOverview(animT, tk.deltaMS / 1000); });
      update();
    })();

    // ── 俯瞰 ─────────────────────────────────────────────
    function buildOverview(world: Container) {
      // 園區外緣柔和光暈(最底層):把園區從深色虛空中托出來,加大氣氛圍
      const glow = new Graphics();
      for (let r = 6; r >= 1; r--) glow.ellipse(0, 30, 130 + r * 55, 80 + r * 32).fill({ color: 0xe6d9bf, alpha: 0.05 });
      world.addChild(glow);

      const ground = new Graphics();
      const gnd = mulberry32(99173);
      for (let gx = 0; gx < GRID; gx++) for (let gy = 0; gy < GRID; gy++) {
        const N = iso(gx, gy), E = iso(gx + 1, gy), S = iso(gx + 1, gy + 1), W = iso(gx, gy + 1);
        const road = isRoad(gx, gy);
        const cross = (gx - 1) % STEP === 0 && (gy - 1) % STEP === 0;
        let base = road ? (cross ? 0xcfbc96 : 0xd8c6a3) : ((gx + gy) % 2 === 0 ? 0xe6d9bf : 0xddceb0);
        if (!road) base = darken(base, 0.9 + gnd() * 0.2);        // 輕微亮度雜訊 → 地面不再死板棋盤
        ground.poly([N.x, N.y, E.x, E.y, S.x, S.y, W.x, W.y]).fill(base);
        if (road && !cross) {                                     // 道路中線虛線(每格一小段拼成)
          const c = iso(gx + 0.5, gy + 0.5), horiz = (gy - 1) % STEP === 0;
          const dx = (horiz ? HW : -HW) * 0.4, dy = HH * 0.4;
          ground.moveTo(c.x - dx, c.y - dy).lineTo(c.x + dx, c.y + dy).stroke({ width: 1, color: 0xa99372, alpha: 0.55 });
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
        const label = new Text({ text: c.name, style: { fill: 0x453a29, fontSize: 10, fontFamily: "Noto Sans TC", fontWeight: "600" } });
        label.anchor.set(0.5, 0.5);
        const ly = p.y + fh * 7 + 12;
        const pw = label.width + 22, ph = 17;
        const plate = new Graphics();
        plate.roundRect(p.x - pw / 2, ly - ph / 2, pw, ph, 8.5).fill({ color: 0xfffaf0, alpha: 0.82 }).stroke({ width: 1, color: 0xd8c6a8 });
        plate.circle(p.x - pw / 2 + 9, ly, 3).fill(0x5a9e5a);   // 狀態點(即時狀態看屋頂燈)
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
        light.moveTo(0, 6).lineTo(0, 15).stroke({ width: 1.5, color: 0xa99372 });      // 燈桿(接屋頂)
        light.circle(0, 15, 2).fill(0xd8c6a8);                                          // 桿座
        if (kind === "fault") {
          const a = 0.5 + 0.5 * Math.sin(animT * 5);
          light.circle(0, 0, 13 + a * 6).fill({ color: 0xc85a4a, alpha: 0.12 + 0.18 * a });
          light.circle(0, 0, 7).fill(0xc85a4a).stroke({ width: 2, color: 0x8a7c63 });
        } else if (kind === "predicted") {
          const a = 0.5 + 0.5 * Math.sin(animT * 3);
          light.circle(0, 0, 12 + a * 4).fill({ color: 0xd47a3f, alpha: 0.1 + 0.14 * a });
          light.circle(0, 0, 7).fill(0xd47a3f).stroke({ width: 2, color: 0x8a7c63 });
        } else {
          // 正常:小而沉靜,讓紅(故障)/橘(預測)在滿屏時仍一眼跳出
          light.circle(0, 0, 5).fill(0x5a9e5a).stroke({ width: 1.6, color: 0x8a7c63 });
        }
      }
      smoke(animT, dt);
    }

    function smoke(animT: number, dt: number) {
      const fxc = fxRef.current; if (!fxc) return;
      if (!focus && Math.sin(animT * 9) > 0.6) for (const ch of chimneysRef.current) if (Math.random() < 0.4) {
        const g = new Graphics(); fxc.addChild(g);
        smokeRef.current.push({ g, x: ch.x + (Math.random() - 0.5) * 4, y: ch.y, vy: 6 + Math.random() * 6, life: 0, max: 1.3 + Math.random() });
      }
      for (const s of smokeRef.current) { s.life += dt; s.y -= s.vy * dt; const tt = s.life / s.max;
        s.g.clear(); s.g.circle(s.x, s.y, 2 + tt * 6).fill({ color: 0xc0b088, alpha: Math.max(0, 0.32 * (1 - tt)) }); }
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
      lightsRef.current = {}; chimneysRef.current = []; smokeRef.current = [];
      worldRef.current = null; appRef.current = null; fxRef.current = null;
      if (ready) safeDestroy(); };
  }, [park]);

  useEffect(() => { update(); }, [telemetry, selected, predicted, focus]);
  useEffect(() => { setInfoOpen(true); }, [focus]);   // 換一間廠 → 說明卡重新展開

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
  // 製程流向由「廠內實際有哪些設備」推出來,而不是寫死在場景檔 —— 設備換了說明就跟著換
  const fcFlow = fc ? layoutLine(fc.device_ids.map((did) => ({
    id: did, template: telemetry?.devices[did]?.template || "unknown",
  }))) : null;
  // 供應鏈上下游(engine/supply.py 隨 snapshot 廣播):滑到 / 點進公司時顯示
  // 「進料來自誰、出貨給誰」,缺料 / 阻塞即時標記 —— 學生一眼看出自己卡在鏈的哪一節
  const nameById = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of park.companies) m[c.id] = c.name;
    return m;
  }, [park]);
  const supplyOf = useMemo(() => {
    const m: Record<string, { inb: SupplyLinkView[]; outb: SupplyLinkView[] }> = {};
    for (const l of telemetry?.supply ?? []) {
      (m[l.to] ??= { inb: [], outb: [] }).inb.push(l);
      (m[l.from] ??= { inb: [], outb: [] }).outb.push(l);
    }
    return m;
  }, [telemetry?.supply]);
  const SupplyLines = ({ cid, size = 11.5 }: { cid: string; size?: number }) => {
    const s = supplyOf[cid];
    if (!s) return null;
    return (
      <div style={{ fontSize: size, lineHeight: 1.65, marginTop: 4 }}>
        {s.inb.map((l) => (
          <div key={`i${l.from}`} style={{ color: "var(--text-2, var(--muted))" }}>
            ⬅ 進料:{nameById[l.from] ?? l.from} 的 {l.part}
            {l.starving && <b style={{ color: "var(--bad, #b0483a)" }}>(缺料中)</b>}
          </div>
        ))}
        {s.outb.map((l) => (
          <div key={`o${l.to}`} style={{ color: "var(--text-2, var(--muted))" }}>
            ➡ 出貨:{l.part} 給 {nameById[l.to] ?? l.to}
            {l.blocking && <b style={{ color: "var(--bad, #b0483a)" }}>(下游滿,阻塞)</b>}
          </div>
        ))}
      </div>
    );
  };
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
          {tip.c.product && <div style={{ color: "var(--accent)", fontSize: 12, margin: "3px 0" }}>
            主要產品:{tip.c.product_icon ? `${tip.c.product_icon} ` : ""}{tip.c.product}</div>}
          <div className="mono" style={{ color: "var(--muted)", fontSize: 11 }}>設備:{(tip.c.device_ids || []).join("、")}</div>
          <SupplyLines cid={tip.c.id} size={11} />
        </div>
      )}
      {/* 廠內 3D 動畫 - 保持掛載以避免 WebGL Context Lost，僅透過 CSS 顯示/隱藏 */}
      <div style={{ position: "absolute", inset: 0, zIndex: 1, pointerEvents: fc ? "auto" : "none", opacity: fc ? 1 : 0, visibility: fc ? "visible" : "hidden", transition: "opacity 0.3s, visibility 0.3s" }}>
        <FactoryLine3D
          devices={fc ? fc.device_ids.map((did) => ({ id: did, template: telemetry?.devices[did]?.template || "unknown" })) : []}
          snapshots={telemetry?.devices || {}}
          multiplier={telemetry?.multiplier ?? 1}
          line={fc ? telemetry?.lines?.find((l) => l.company === fc.id) : undefined}
          onDeviceClick={onSelect}
        />
      </div>

      {/* 廠內標題 + 返回 + 公司介紹 */}
      {fc && (
        <>
          <div style={{ position: "absolute", top: 12, left: 14, display: "flex", gap: 12, alignItems: "center", zIndex: 10 }}>
            <button className="btn ghost" style={{ background: "rgba(255,255,255,0.8)" }} onClick={() => setFocus(null)}>← 返回俯瞰</button>
            <span style={{ color: "white", fontWeight: 600, textShadow: "0px 1px 3px rgba(0,0,0,0.8)" }}>🏭 {fc.name} · 廠內即時</span>
          </div>
          <div className="card float" style={{ position: "absolute", top: 58, right: 16, width: infoOpen ? 300 : 210,
                        padding: "12px 14px", zIndex: 10, transition: "width .18s" }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)", flex: 1 }}>{fc.name}</div>
              <button className="btn ghost" title={infoOpen ? "收起說明(卡片會擋到機台)" : "展開說明"}
                      style={{ padding: "0 7px", fontSize: 13, lineHeight: "20px", borderRadius: 6 }}
                      onClick={() => setInfoOpen((v) => !v)}>{infoOpen ? "▾" : "▸"}</button>
            </div>
            {infoOpen && <>
              {fc.product && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "8px 0",
                              padding: "8px 10px", borderRadius: 8, background: "rgba(200,112,58,.10)" }}>
                  {/* 成品示意:emoji 用系統字型渲染,校內 LAN 離線也不會缺圖 */}
                  <span style={{ fontSize: 30, lineHeight: 1 }} aria-hidden>{fc.product_icon ?? "📦"}</span>
                  <div>
                    <div style={{ fontSize: 11, color: "var(--muted)", letterSpacing: ".06em" }}>主要產品(成品示意)</div>
                    <div style={{ color: "var(--accent)", fontSize: 13.5, fontWeight: 700 }}>{fc.product}</div>
                  </div>
                </div>
              )}
              {fc.intro && <div style={{ color: "var(--text-2)", fontSize: 12.5, lineHeight: 1.6 }}>{fc.intro}</div>}
              {fcFlow?.flowText && (
                <div style={{ marginTop: 9, padding: "7px 9px", borderRadius: 7,
                              background: "rgba(90,158,90,.13)", color: "#3f6b3f", fontSize: 12.5, fontWeight: 600 }}>
                  製程流向:{fcFlow.flowText}
                </div>
              )}
              {fcFlow?.utilityText && (
                <div style={{ color: "var(--muted)", fontSize: 11.5, marginTop: 5 }}>{fcFlow.utilityText}</div>
              )}
              <SupplyLines cid={fc.id} size={12} />
              <div className="mono" style={{ color: "var(--muted)", fontSize: 11, marginTop: 8 }}>廠內設備:{(fc.device_ids || []).join("、")}</div>
              <div style={{ color: "var(--pred)", fontSize: 11, marginTop: 6 }}>⚠ 合成數據,非真實產線</div>
            </>}
            
            {/* 廠內全部設備控制 (教師權限) */}
            {isTeacher && (
              <div style={{ marginTop: 16, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
                <div style={{ fontFamily: "var(--font-serif)", fontSize: 11, letterSpacing: ".4px", color: "var(--dim)", marginBottom: 10, fontWeight: 600 }}>廠內設備控制 (教師權限)</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {fc.device_ids.map(did => {
                    const snap = telemetry?.devices[did];
                    const runEnabled = snap?.coils?.run_enable !== false;
                    return (
                      <div key={did} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                        <span className="mono" style={{ fontSize: 12, color: "var(--text)" }}>{did}</span>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button className="btn" style={{ background: runEnabled ? "var(--warn)" : "var(--ok)", color: "#fffaf0", padding: "4px 8px", fontSize: 11, borderRadius: 4, border: "none", cursor: "pointer", fontWeight: "bold" }}
                            onClick={async () => {
                              try { await setCoil(did, "run_enable", !runEnabled); setResetMsg(`已寫 run_enable=${!runEnabled}:${did}`); }
                              catch (e: any) { setResetMsg(`寫入失敗:${e.message}`); }
                            }}>{runEnabled ? "⏸" : "▶"}</button>
                          <button className="btn" style={{ background: "var(--ok)", color: "#fffaf0", padding: "4px 8px", fontSize: 11, borderRadius: 4, border: "none", cursor: "pointer", fontWeight: "bold" }}
                            onClick={async () => {
                              try { await setCoil(did, "reset_fault", true); setResetMsg(`已重置:${did}`); }
                              catch { try { await resetDevice(did); setResetMsg(`已清故障:${did}`); }
                                      catch (e2: any) { setResetMsg(`失敗:${e2.message}`); } }
                            }}>↺</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                {resetMsg && <div style={{ color: "var(--accent)", fontSize: 11, marginTop: 8 }}>{resetMsg}</div>}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
