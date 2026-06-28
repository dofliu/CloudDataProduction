import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import { Park, Company, TelemetryMsg, colorOf, worstState } from "../api";

// ── 俯瞰格狀佈局 ───────────────────────────────────────
const COLS = 6, STEP = 4, GRID = 26;
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
const ROOFS = [0x3a4a63, 0x4a4036, 0x394f4a, 0x44485a, 0x53473a, 0x35506b, 0x4d3f4a];

function isoBox(g: Graphics, gx: number, gy: number, w: number, h: number, height: number, roof: number) {
  const N = iso(gx, gy), E = iso(gx + w, gy), S = iso(gx + w, gy + h), W = iso(gx, gy + h);
  const up = (p: { x: number; y: number }) => ({ x: p.x, y: p.y - height });
  g.poly([W.x, W.y, S.x, S.y, up(S).x, up(S).y, up(W).x, up(W).y]).fill(darken(roof, 0.62));
  g.poly([S.x, S.y, E.x, E.y, up(E).x, up(E).y, up(S).x, up(S).y]).fill(darken(roof, 0.8));
  g.poly([up(N).x, up(N).y, up(E).x, up(E).y, up(S).x, up(S).y, up(W).x, up(W).y])
    .fill(roof).stroke({ width: 1, color: darken(roof, 1.15) });
}

interface DeviceVisual { container: Container; ring: Graphics; pulse: Graphics; kind: string; }
interface Station { id: string; template: string; container: Container; art: Graphics; ring: Graphics; }
interface Smoke { g: Graphics; x: number; y: number; vy: number; life: number; max: number; }

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
  const telRef = useRef(telemetry);
  const onSelectRef = useRef(onSelect); const selectedRef = useRef(selected); const predictedRef = useRef(predicted);
  telRef.current = telemetry; onSelectRef.current = onSelect; selectedRef.current = selected; predictedRef.current = predicted;

  useEffect(() => {
    let cancelled = false, ready = false;
    const host = hostRef.current!;
    const app = new Application();
    const safeDestroy = () => { try { app.destroy(true, { children: true }); } catch { /* */ } };

    (async () => {
      await app.init({ background: focus ? 0x0c1118 : 0x10151d, antialias: true,
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
      const ground = new Graphics();
      for (let gx = 0; gx < GRID; gx++) for (let gy = 0; gy < GRID; gy++) {
        const N = iso(gx, gy), E = iso(gx + 1, gy), S = iso(gx + 1, gy + 1), W = iso(gx, gy + 1);
        ground.poly([N.x, N.y, E.x, E.y, S.x, S.y, W.x, W.y])
          .fill(isRoad(gx, gy) ? 0x20242c : ((gx + gy) % 2 === 0 ? 0x1b2230 : 0x18202c));
      }
      world.addChild(ground);

      const reserved = new Set<string>();
      park.companies.forEach((_, i) => { const { gx, gy } = companyTile(i);
        for (let dx = -1; dx <= 2; dx++) for (let dy = -1; dy <= 2; dy++) reserved.add(`${gx + dx},${gy + dy}`); });
      const rnd = mulberry32(20260628);
      const props: any[] = [];
      for (let gx = 1; gx < GRID - 1; gx++) for (let gy = 1; gy < GRID - 1; gy++) {
        if (isRoad(gx, gy) || reserved.has(`${gx},${gy}`) || rnd() > 0.12) continue;
        props.push({ gx, gy, ht: 12 + Math.floor(rnd() * 30), roof: ROOFS[Math.floor(rnd() * ROOFS.length)], chimney: rnd() > 0.8 });
      }
      props.sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));
      for (const b of props) { const g = new Graphics(); isoBox(g, b.gx, b.gy, 1, 1, b.ht, b.roof); world.addChild(g);
        if (b.chimney) { const t = iso(b.gx + 0.5, b.gy + 0.5); chimneysRef.current.push({ x: t.x, y: t.y - b.ht - 3 }); } }

      const slots = [[-20, -6], [20, -6], [-20, 10], [20, 10], [0, 18]];
      park.companies.forEach((c, i) => {
        const { gx, gy } = companyTile(i); const p = iso(gx, gy);
        const g = new Graphics(); isoBox(g, gx, gy, 2, 2, 40, 0x2b3950);
        g.eventMode = "static"; g.cursor = "pointer";
        g.on("pointertap", () => { setTip(null); setFocus(c.id); });
        g.on("pointerover", (e: any) => setTip({ x: e.global.x, y: e.global.y, c }));
        g.on("pointermove", (e: any) => setTip((t) => t ? { ...t, x: e.global.x, y: e.global.y } : t));
        g.on("pointerout", () => setTip(null));
        world.addChild(g);
        chimneysRef.current.push({ x: p.x + 12, y: p.y - 44 });
        const label = new Text({ text: c.name, style: { fill: 0xc7d2e0, fontSize: 10, fontFamily: "Microsoft JhengHei", fontWeight: "600" } });
        label.anchor.set(0.5, 0); label.x = p.x; label.y = p.y + 22; world.addChild(label);
        const light = new Graphics(); light.x = p.x; light.y = p.y - 50; world.addChild(light); lightsRef.current[c.id] = light;
        (c.device_ids || []).forEach((did, j) => {
          const slot = slots[j % slots.length];
          const cont = new Container(); cont.x = p.x + slot[0]; cont.y = p.y + slot[1] + Math.floor(j / slots.length) * 12;
          cont.eventMode = "static"; cont.cursor = "pointer"; cont.on("pointertap", () => onSelectRef.current(did));
          const pulse = new Graphics(); cont.addChild(pulse);
          const ring = new Graphics(); cont.addChild(ring);
          world.addChild(cont);
          devicesRef.current[did] = { container: cont, ring, pulse, kind: "idle" };
        });
      });
    }

    function tickOverview(animT: number, dt: number) {
      for (const v of Object.values(devicesRef.current)) {
        v.pulse.clear();
        if (v.kind === "fault") { const a = 0.5 + 0.5 * Math.sin(animT * 6); v.pulse.circle(0, 0, 7 + a * 6).fill({ color: 0xe24c4c, alpha: 0.18 + 0.22 * a }); }
        else if (v.kind === "predicted") { const a = 0.5 + 0.5 * Math.sin(animT * 3); v.pulse.circle(0, 0, 7 + a * 5).fill({ color: 0xf08c2e, alpha: 0.12 + 0.16 * a }); }
        else if (v.kind === "running" || v.kind === "moving") { const a = 0.5 + 0.5 * Math.sin(animT * 2); v.pulse.circle(0, 0, 9).fill({ color: 0x37d67a, alpha: 0.05 + 0.06 * a }); }
      }
      smoke(animT, dt);
    }

    // ── 廠內 ─────────────────────────────────────────────
    function buildInterior(world: Container, cid: string) {
      const company = park.companies.find((c) => c.id === cid);
      const devIds = company?.device_ids || [];
      const FW = Math.max(9, devIds.length * 3 + 3), FH = 9;
      const fiso = (gx: number, gy: number) => ({ x: (gx - gy) * 34, y: (gx + gy) * 17 });
      const floor = new Graphics();
      for (let gx = 0; gx < FW; gx++) for (let gy = 0; gy < FH; gy++) {
        const N = fiso(gx, gy), E = fiso(gx + 1, gy), S = fiso(gx + 1, gy + 1), W = fiso(gx, gy + 1);
        floor.poly([N.x, N.y, E.x, E.y, S.x, S.y, W.x, W.y]).fill((gx + gy) % 2 ? 0x222b39 : 0x1d2532).stroke({ width: 0.5, color: 0x2a3446 });
      }
      world.addChild(floor);
      // 輸送帶 + 物件
      const bA = fiso(1, FH - 1.6), bB = fiso(FW - 1, FH - 1.6);
      const belt = new Graphics();
      belt.poly([bA.x, bA.y - 9, bB.x, bB.y - 9, bB.x, bB.y + 9, bA.x, bA.y + 9]).fill(0x2c3340).stroke({ width: 1, color: 0x3a4458 });
      world.addChild(belt);
      const beltDash = new Graphics(); world.addChild(beltDash);
      (beltDash as any)._a = bA; (beltDash as any)._b = bB; beltRef.current = beltDash;
      // 設備站
      const stations: Station[] = [];
      devIds.forEach((did, i) => {
        const tmpl = telRef.current?.devices[did]?.template || "";
        const pos = fiso(2.5 + i * 3, 3);
        const cont = new Container(); cont.x = pos.x; cont.y = pos.y;
        cont.eventMode = "static"; cont.cursor = "pointer"; cont.on("pointertap", () => onSelectRef.current(did));
        const ring = new Graphics(); cont.addChild(ring);
        const art = new Graphics(); cont.addChild(art);
        const lab = new Text({ text: did, style: { fill: 0xc7d2e0, fontSize: 11, fontFamily: "Segoe UI" } });
        lab.anchor.set(0.5, 0); lab.y = 34; cont.addChild(lab);
        (cont as any)._track = { a: fiso(2, 1), b: fiso(FW - 2, 1), c: fiso(FW - 2, FH - 3), d: fiso(2, FH - 3) }; // AGV 軌跡
        world.addChild(cont);
        stations.push({ id: did, template: tmpl, container: cont, art, ring });
      });
      stationsRef.current = stations;
    }

    function tickInterior(animT: number, dt: number) {
      const tel = telRef.current;
      const bd: any = beltRef.current;
      if (bd && bd._a) {
        bd.clear(); const a = bd._a, b = bd._b, off = (animT * 0.4) % 1;
        for (let i = 0; i < 16; i++) { const f = (i + off) / 16, x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
          bd.rect(x - 2, y - 7, 4, 14).fill({ color: 0x3c465c }); }
        for (let i = 0; i < 4; i++) { const f = ((i / 4 + animT * 0.06) % 1), x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;  // 物件
          bd.roundRect(x - 8, y - 16, 16, 12, 2).fill(0xb08948).stroke({ width: 1, color: 0x7a5d2e }); }
      }
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
        drawStation(st.art, st.template, t, running, animT, col);
      }
      smoke(animT, dt);
    }

    function drawStation(g: Graphics, tmpl: string, t: Record<string, number>, running: boolean, animT: number, col: number) {
      if (tmpl === "robot_arm_6axis") {
        // 較逼真的六軸手臂:底座 + 轉盤 + 肩/肘/腕 + 兩指夾爪
        const a1 = (t["joint_angle_1"] ?? 0), a2 = (t["joint_angle_2"] ?? 0), a3 = (t["joint_angle_3"] ?? 0);
        g.ellipse(0, 22, 20, 9).fill(0x2c3650);                       // 地座陰影
        g.roundRect(-14, 6, 28, 18, 3).fill(0x3a4862).stroke({ width: 1, color: 0x4d5e7e }); // 底座
        g.roundRect(-9, 0, 18, 9, 2).fill(0x46587a);                  // 轉盤
        const base = { x: 0, y: 2 };
        const th1 = (-72 + a1 * 0.5) * Math.PI / 180;
        const th2 = th1 + (a2 * 0.6 - 18) * Math.PI / 180;
        const th3 = th2 + (a3 * 0.4) * Math.PI / 180;
        const L = [30, 26, 14]; const ths = [th1, th2, th3];
        const pts = [base]; let x = base.x, y = base.y;
        for (let i = 0; i < 3; i++) { x += L[i] * Math.cos(ths[i]); y += L[i] * Math.sin(ths[i]); pts.push({ x, y }); }
        for (let i = 0; i < 3; i++) g.moveTo(pts[i].x, pts[i].y).lineTo(pts[i + 1].x, pts[i + 1].y).stroke({ width: 8 - i * 2, color: i === 0 ? 0xf08c2e : 0xcdd9ec, cap: "round" });
        for (let i = 0; i < 3; i++) g.circle(pts[i].x, pts[i].y, 4 - i * 0.5).fill(0x5b9bd5).stroke({ width: 1, color: 0x2c3650 });
        // 夾爪
        const e = pts[3], d = ths[2];
        const gx = Math.cos(d + Math.PI / 2) * 5, gy = Math.sin(d + Math.PI / 2) * 5;
        g.moveTo(e.x, e.y).lineTo(e.x + gx + Math.cos(d) * 6, e.y + gy + Math.sin(d) * 6).stroke({ width: 3, color: col });
        g.moveTo(e.x, e.y).lineTo(e.x - gx + Math.cos(d) * 6, e.y - gy + Math.sin(d) * 6).stroke({ width: 3, color: col });
      } else if (tmpl === "cnc_machining_center") {
        g.roundRect(-20, -4, 40, 30, 3).fill(0x37445c).stroke({ width: 1, color: 0x4a5a78 });
        g.roundRect(-14, -22, 28, 18, 3).fill(0x2c3850);              // 主軸箱
        const spin = running ? animT * 9 : 0; const sx = Math.cos(spin) * 7;
        g.moveTo(-sx, -13).lineTo(sx, -13).stroke({ width: 3, color: running ? 0xffd479 : 0x6b7488 });
        g.circle(0, -13, 2).fill(0x8a93a6);
        g.rect(-16, 20, 32, 4).fill(darken(col, 0.7));               // 護門底飾
      } else if (tmpl === "injection_molding") {
        g.roundRect(-26, 0, 22, 24, 3).fill(0x3a4a44).stroke({ width: 1, color: 0x4d6158 });   // 鎖模單元
        const clamp = running ? 3 + 3 * Math.abs(Math.sin(animT * 2)) : 6;
        g.rect(-6 - clamp, 4, 6, 16).fill(0x5b7a6e); g.rect(0, 4, 6, 16).fill(0x5b7a6e);        // 動/定模板
        g.roundRect(6, 6, 26, 12, 3).fill(0x46506a).stroke({ width: 1, color: 0x5b6b8e });      // 射出單元
        g.circle(32, 12, 3).fill(running ? 0xffd479 : 0x6b7488);                                 // 料斗
      } else if (tmpl === "air_compressor") {
        g.roundRect(-18, -4, 36, 28, 6).fill(0x3a4a44).stroke({ width: 1, color: 0x4d6158 });    // 桶
        const rot = running ? animT * 6 : 0;
        for (let i = 0; i < 4; i++) { const a = rot + i * Math.PI / 2; g.moveTo(0, 8).lineTo(Math.cos(a) * 10, 8 + Math.sin(a) * 10).stroke({ width: 3, color: running ? 0x9fe0c0 : 0x6b7488 }); }
        g.circle(0, 8, 2.5).fill(0x8a93a6);
      } else if (tmpl === "wind_turbine") {
        g.poly([-3, 26, 3, 26, 1.5, -14, -1.5, -14]).fill(0xc9d4e4);                              // 塔
        g.roundRect(-5, -18, 14, 7, 2).fill(0x9fb0c4);                                            // 機艙
        const rpm = t["rotor_rpm"] ?? 0; const rot = animT * (0.4 + rpm * 0.25);                  // 轉速 ∝ rpm
        const hub = { x: -5, y: -14 };
        for (let i = 0; i < 3; i++) { const a = rot + i * 2 * Math.PI / 3;
          g.moveTo(hub.x, hub.y).lineTo(hub.x + Math.cos(a) * 22, hub.y + Math.sin(a) * 22).stroke({ width: 3, color: 0xeef3f9, cap: "round" }); }
        g.circle(hub.x, hub.y, 3).fill(col);
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

    function recenter() { const w = worldRef.current; if (w && app.renderer) { w.x = app.screen.width / 2; w.y = app.screen.height * (focus ? 0.28 : 0.30); } }
    const onResize = () => { if (ready && app.renderer) { app.renderer.resize(host.clientWidth || 800, host.clientHeight || 600); recenter(); } };
    window.addEventListener("resize", onResize);
    return () => { cancelled = true; window.removeEventListener("resize", onResize);
      lightsRef.current = {}; devicesRef.current = {}; stationsRef.current = []; chimneysRef.current = []; smokeRef.current = [];
      worldRef.current = null; appRef.current = null; fxRef.current = null; beltRef.current = null;
      if (ready) safeDestroy(); };
  }, [park, focus]);

  useEffect(() => { update(); }, [telemetry, selected, predicted, focus]);

  function update() {
    const tel = telemetry; if (!tel || focus) return;
    for (const [did, v] of Object.entries(devicesRef.current)) {
      const snap = tel.devices[did]; if (!snap) continue;
      const isSel = did === selectedRef.current;
      const isPredicted = predictedRef.current.has(did) && snap.state !== "fault";
      v.kind = snap.state === "fault" ? "fault" : isPredicted ? "predicted" : snap.state;
      const color = isPredicted ? 0xf08c2e : colorOf(snap.state);
      v.ring.clear();
      v.ring.circle(0, 0, isSel ? 9 : 6).fill(color).stroke({ width: isSel ? 3 : 1.5, color: isSel ? 0xffffff : 0x10151d });
    }
    for (const c of park.companies) {
      const light = lightsRef.current[c.id]; if (!light) continue;
      const states = (c.device_ids || []).map((d) => { const st = tel.devices[d]?.state;
        return (st && st !== "fault" && predictedRef.current.has(d)) ? "predicted_fault" : st; }).filter(Boolean) as string[];
      light.clear(); light.circle(0, 0, 5).fill(colorOf(states.length ? worstState(states) : "idle")).stroke({ width: 2, color: 0x10151d });
    }
  }

  const fc = focus ? park.companies.find((c) => c.id === focus) : null;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      {!focus && (
        <div style={{ position: "absolute", top: 12, left: 14, color: "#8a93a6", fontSize: 13 }}>
          滑鼠移到公司看簡介 ｜ 點公司進廠內 ｜ 點設備看即時值
        </div>
      )}
      {/* 公司 hover tooltip */}
      {tip && !focus && (
        <div style={{ position: "absolute", left: Math.min(tip.x + 14, (hostRef.current?.clientWidth ?? 800) - 250),
                      top: tip.y + 14, width: 232, background: "rgba(20,27,37,0.96)", border: "1px solid #2e3a4d",
                      borderRadius: 8, padding: "8px 12px", pointerEvents: "none", boxShadow: "0 4px 16px rgba(0,0,0,0.4)" }}>
          <div style={{ fontWeight: 700, color: "#e6ecf5" }}>🏭 {tip.c.name}</div>
          {tip.c.product && <div style={{ color: "#5b9bd5", fontSize: 12, margin: "3px 0" }}>主要產品:{tip.c.product}</div>}
          <div style={{ color: "#8a93a6", fontSize: 12 }}>設備:{(tip.c.device_ids || []).join("、")}</div>
        </div>
      )}
      {/* 廠內標題 + 返回 + 公司介紹 */}
      {fc && (
        <>
          <div style={{ position: "absolute", top: 12, left: 14, display: "flex", gap: 12, alignItems: "center" }}>
            <button onClick={() => setFocus(null)} style={{ background: "#222c3c", color: "#e6ecf5", border: "1px solid #2e3a4d", borderRadius: 6, padding: "6px 14px", cursor: "pointer" }}>← 返回俯瞰</button>
            <span style={{ color: "#c7d2e0", fontWeight: 600 }}>🏭 {fc.name} · 廠內即時</span>
          </div>
          <div style={{ position: "absolute", top: 60, left: 16, width: 300, background: "rgba(20,27,37,0.9)", border: "1px solid #2e3a4d", borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: "#e6ecf5" }}>{fc.name}</div>
            {fc.product && <div style={{ color: "#5b9bd5", fontSize: 13, margin: "6px 0" }}>主要產品:{fc.product}</div>}
            {fc.intro && <div style={{ color: "#c7d2e0", fontSize: 13, lineHeight: 1.6 }}>{fc.intro}</div>}
            <div style={{ color: "#8a93a6", fontSize: 12, marginTop: 8 }}>廠內設備:{(fc.device_ids || []).join("、")}</div>
            <div style={{ color: "#f08c2e", fontSize: 11, marginTop: 6 }}>⚠ 合成數據,非真實產線</div>
          </div>
        </>
      )}
    </div>
  );
}
