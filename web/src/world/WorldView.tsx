import { useEffect, useRef, useState } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import { Park, TelemetryMsg, colorOf, worstState } from "../api";

// ── 等距投影(俯瞰)─────────────────────────────────────
const GRID = 22;
const HW = 22, HH = 11;
const CX = GRID / 2, CY = GRID / 2;
const AGV_SCALE = 2.4;

function iso(gx: number, gy: number) {
  const rx = gx - CX, ry = gy - CY;
  return { x: (rx - ry) * HW, y: (rx + ry) * HH };
}
function isRoad(gx: number, gy: number) { return gx === 7 || gx === 15 || gy === 7 || gy === 15; }
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function darken(c: number, f: number) {
  const r = (c >> 16) & 255, g = (c >> 8) & 255, b = c & 255;
  return ((Math.min(255, r * f) | 0) << 16) | ((Math.min(255, g * f) | 0) << 8) | (Math.min(255, b * f) | 0);
}
const ROOFS = [0x3a4a63, 0x4a4036, 0x394f4a, 0x44485a, 0x53473a, 0x35506b, 0x4d3f4a];

function drawIsoBox(g: Graphics, gx: number, gy: number, w: number, h: number, height: number, roof: number) {
  const N = iso(gx, gy), E = iso(gx + w, gy), S = iso(gx + w, gy + h), W = iso(gx, gy + h);
  const up = (p: { x: number; y: number }) => ({ x: p.x, y: p.y - height });
  g.poly([W.x, W.y, S.x, S.y, up(S).x, up(S).y, up(W).x, up(W).y]).fill(darken(roof, 0.62));
  g.poly([S.x, S.y, E.x, E.y, up(E).x, up(E).y, up(S).x, up(S).y]).fill(darken(roof, 0.8));
  g.poly([up(N).x, up(N).y, up(E).x, up(E).y, up(S).x, up(S).y, up(W).x, up(W).y])
    .fill(roof).stroke({ width: 1, color: darken(roof, 1.15) });
}

interface DeviceVisual {
  container: Container; ring: Graphics; pulse: Graphics;
  base: { x: number; y: number }; target: { x: number; y: number }; kind: string;
}
interface Station { id: string; template: string; container: Container; art: Graphics; ring: Graphics; base: { x: number; y: number }; }
interface Smoke { g: Graphics; x: number; y: number; vy: number; life: number; max: number; }

export default function WorldView({
  park, telemetry, selected, onSelect, predicted,
}: {
  park: Park; telemetry: TelemetryMsg | null;
  selected: string | null; onSelect: (id: string) => void; predicted: Set<string>;
}) {
  const [focus, setFocus] = useState<string | null>(null);   // 鑽入的公司 id
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const lightsRef = useRef<Record<string, Graphics>>({});
  const devicesRef = useRef<Record<string, DeviceVisual>>({});
  const stationsRef = useRef<Station[]>([]);
  const chimneysRef = useRef<{ x: number; y: number }[]>([]);
  const smokeRef = useRef<Smoke[]>([]);
  const fxRef = useRef<Container | null>(null);
  const telRef = useRef(telemetry);
  const onSelectRef = useRef(onSelect);
  const selectedRef = useRef(selected);
  const predictedRef = useRef(predicted);
  telRef.current = telemetry; onSelectRef.current = onSelect;
  selectedRef.current = selected; predictedRef.current = predicted;

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

      if (focus) buildInterior(world, focus);
      else buildOverview(world);

      const fx = new Container(); world.addChild(fx); fxRef.current = fx;
      let animT = 0;
      app.ticker.add((tk) => {
        animT += tk.deltaMS / 1000;
        if (focus) tickInterior(animT, tk.deltaMS / 1000);
        else tickOverview(animT, tk.deltaMS / 1000);
      });
      update();
    })();

    // ── 俯瞰場景 ──────────────────────────────────────────
    function buildOverview(world: Container) {
      const ground = new Graphics();
      for (let gx = 0; gx < GRID; gx++) for (let gy = 0; gy < GRID; gy++) {
        const N = iso(gx, gy), E = iso(gx + 1, gy), S = iso(gx + 1, gy + 1), W = iso(gx, gy + 1);
        const road = isRoad(gx, gy);
        ground.poly([N.x, N.y, E.x, E.y, S.x, S.y, W.x, W.y])
          .fill(road ? 0x20242c : ((gx + gy) % 2 === 0 ? 0x1b2230 : 0x18202c));
      }
      world.addChild(ground);

      const reserved = new Set<string>();
      for (const c of park.companies) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
        reserved.add(`${c.map_pos.x + dx},${c.map_pos.y + dy}`);
      const occ = new Set<string>(); const rnd = mulberry32(20260627);
      const props: any[] = [];
      for (let gx = 1; gx < GRID - 1; gx++) for (let gy = 1; gy < GRID - 1; gy++) {
        if (isRoad(gx, gy) || reserved.has(`${gx},${gy}`) || occ.has(`${gx},${gy}`) || rnd() > 0.22) continue;
        const w = rnd() > 0.7 ? 2 : 1, h = rnd() > 0.7 ? 2 : 1; let clash = false;
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++)
          if (isRoad(gx + dx, gy + dy) || reserved.has(`${gx + dx},${gy + dy}`) || occ.has(`${gx + dx},${gy + dy}`)) clash = true;
        if (clash) continue;
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) occ.add(`${gx + dx},${gy + dy}`);
        props.push({ gx, gy, w, h, ht: 14 + Math.floor(rnd() * 42), roof: ROOFS[Math.floor(rnd() * ROOFS.length)], chimney: rnd() > 0.78 });
      }
      props.sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));
      for (const b of props) {
        const g = new Graphics(); drawIsoBox(g, b.gx, b.gy, b.w, b.h, b.ht, b.roof); world.addChild(g);
        if (b.chimney) { const t = iso(b.gx + b.w * 0.5, b.gy + b.h * 0.5); chimneysRef.current.push({ x: t.x, y: t.y - b.ht - 4 }); }
      }

      const slots = [[-30, -8], [30, -8], [-30, 14], [30, 14], [0, 26]];
      const companies = [...park.companies].sort((a, b) => (a.map_pos.x + a.map_pos.y) - (b.map_pos.x + b.map_pos.y));
      for (const c of companies) {
        const p = iso(c.map_pos.x, c.map_pos.y);
        const g = new Graphics(); drawIsoBox(g, c.map_pos.x, c.map_pos.y, 2, 2, 46, 0x2b3950);
        g.eventMode = "static"; g.cursor = "pointer"; g.on("pointertap", () => setFocus(c.id));
        world.addChild(g);
        chimneysRef.current.push({ x: p.x + 16, y: p.y - 50 });
        const label = new Text({ text: c.name, style: { fill: 0xc7d2e0, fontSize: 12, fontFamily: "Segoe UI", fontWeight: "600" } });
        label.anchor.set(0.5, 0); label.x = p.x; label.y = p.y + 30; world.addChild(label);
        const light = new Graphics(); light.x = p.x; light.y = p.y - 58; world.addChild(light);
        lightsRef.current[c.id] = light;
        (c.device_ids || []).forEach((did, i) => {
          const slot = slots[i % slots.length];
          const base = { x: p.x + slot[0], y: p.y + slot[1] + Math.floor(i / slots.length) * 16 };
          const cont = new Container(); cont.x = base.x; cont.y = base.y;
          cont.eventMode = "static"; cont.cursor = "pointer"; cont.on("pointertap", () => onSelectRef.current(did));
          const pulse = new Graphics(); cont.addChild(pulse);
          const ring = new Graphics(); cont.addChild(ring);
          const dl = new Text({ text: did, style: { fill: 0x9fb0c4, fontSize: 9, fontFamily: "Segoe UI" } });
          dl.anchor.set(0.5, 0); dl.y = 9; cont.addChild(dl);
          world.addChild(cont);
          devicesRef.current[did] = { container: cont, ring, pulse, base, target: { ...base }, kind: "idle" };
        });
      }
    }

    function tickOverview(animT: number, _dt: number) {
      for (const v of Object.values(devicesRef.current)) {
        v.container.x += (v.target.x - v.container.x) * 0.18;
        v.container.y += (v.target.y - v.container.y) * 0.18;
        v.pulse.clear();
        if (v.kind === "fault") { const a = 0.5 + 0.5 * Math.sin(animT * 6); v.pulse.circle(0, 0, 9 + a * 7).fill({ color: 0xe24c4c, alpha: 0.18 + 0.22 * a }); }
        else if (v.kind === "predicted") { const a = 0.5 + 0.5 * Math.sin(animT * 3); v.pulse.circle(0, 0, 9 + a * 6).fill({ color: 0xf08c2e, alpha: 0.12 + 0.16 * a }); }
        else if (v.kind === "running" || v.kind === "moving") { const a = 0.5 + 0.5 * Math.sin(animT * 2); v.pulse.circle(0, 0, 11).fill({ color: 0x37d67a, alpha: 0.05 + 0.06 * a }); }
      }
      smoke(animT, _dt);
    }

    // ── 公司內部場景 ──────────────────────────────────────
    function buildInterior(world: Container, cid: string) {
      const company = park.companies.find((c) => c.id === cid);
      const devIds = company?.device_ids || [];
      const FW = Math.max(8, devIds.length * 3 + 2), FH = 8;
      const fiso = (gx: number, gy: number) => ({ x: (gx - gy) * 34, y: (gx + gy) * 17 });
      // 廠房地坪
      const floor = new Graphics();
      for (let gx = 0; gx < FW; gx++) for (let gy = 0; gy < FH; gy++) {
        const N = fiso(gx, gy), E = fiso(gx + 1, gy), S = fiso(gx + 1, gy + 1), W = fiso(gx, gy + 1);
        floor.poly([N.x, N.y, E.x, E.y, S.x, S.y, W.x, W.y]).fill((gx + gy) % 2 ? 0x222b39 : 0x1d2532).stroke({ width: 0.5, color: 0x2a3446 });
      }
      world.addChild(floor);
      // 輸送帶(沿 gy=FH-2 橫貫)
      const beltY = FH - 1.5;
      const beltA = fiso(1, beltY), beltB = fiso(FW - 1, beltY);
      const belt = new Graphics();
      belt.poly([beltA.x, beltA.y - 8, beltB.x, beltB.y - 8, beltB.x, beltB.y + 8, beltA.x, beltA.y + 8]).fill(0x2c3340);
      world.addChild(belt);
      const beltDash = new Graphics(); world.addChild(beltDash);
      (beltDash as any)._a = beltA; (beltDash as any)._b = beltB;
      // 設備站
      const stations: Station[] = [];
      devIds.forEach((did, i) => {
        const tmpl = telRef.current?.devices[did]?.template || "";
        const pos = fiso(2 + i * 3, 2.5);
        const cont = new Container(); cont.x = pos.x; cont.y = pos.y;
        cont.eventMode = "static"; cont.cursor = "pointer"; cont.on("pointertap", () => onSelectRef.current(did));
        const ring = new Graphics(); cont.addChild(ring);
        const art = new Graphics(); cont.addChild(art);
        const lab = new Text({ text: did, style: { fill: 0xc7d2e0, fontSize: 11, fontFamily: "Segoe UI" } });
        lab.anchor.set(0.5, 0); lab.y = 30; cont.addChild(lab);
        world.addChild(cont);
        stations.push({ id: did, template: tmpl, container: cont, art, ring, base: pos });
      });
      stationsRef.current = stations;
      (fxRef as any)._belt = beltDash;
    }

    function tickInterior(animT: number, _dt: number) {
      const tel = telRef.current;
      // 輸送帶滾動
      const bd: any = (fxRef as any)._belt;
      if (bd && bd._a) {
        bd.clear();
        const a = bd._a, b = bd._b, n = 14;
        const off = (animT * 0.5) % 1;
        for (let i = 0; i < n; i++) {
          const f = (i + off) / n;
          const x = a.x + (b.x - a.x) * f, y = a.y + (b.y - a.y) * f;
          bd.rect(x - 3, y - 6, 6, 12).fill({ color: 0x44506a, alpha: 0.9 });
        }
      }
      for (const st of stationsRef.current) {
        const snap = tel?.devices[st.id];
        const t = snap?.tags || {};
        const state = snap?.state || "idle";
        const running = state === "running" || state === "moving";
        const isPred = predictedRef.current.has(st.id) && state !== "fault";
        const col = isPred ? 0xf08c2e : colorOf(state);
        // 狀態環
        st.ring.clear();
        const selW = st.id === selectedRef.current ? 3 : 1.5;
        st.ring.ellipse(0, 24, 26, 12).fill({ color: col, alpha: 0.12 }).stroke({ width: selW, color: col });
        if (state === "fault") { const p = 0.5 + 0.5 * Math.sin(animT * 6); st.ring.ellipse(0, 24, 30 + p * 6, 14 + p * 3).stroke({ width: 1.5, color: 0xe24c4c }); }
        // 設備本體動畫
        st.art.clear();
        st.art.position.set(0, 0);
        drawStation(st.art, st.template, t, running, animT, col);
      }
      smoke(animT, _dt);
    }

    function drawStation(g: Graphics, tmpl: string, t: Record<string, number>, running: boolean, animT: number, col: number) {
      if (tmpl === "robot_arm_6axis") {
        // 三段關節手臂(角度取自 joint_angle_1..3)
        const a1 = (t["joint_angle_1"] ?? 0), a2 = (t["joint_angle_2"] ?? 0), a3 = (t["joint_angle_3"] ?? 0);
        g.rect(-12, 8, 24, 14).fill(0x39465e);                       // 底座
        const L = [30, 24, 16]; let x = 0, y = 6, th = (-90 + a1 * 0.5) * Math.PI / 180;
        const pts = [{ x, y }];
        const ths = [th, th + a2 * 0.6 * Math.PI / 180, th + (a2 * 0.6 + a3 * 0.4) * Math.PI / 180];
        for (let i = 0; i < 3; i++) { x += L[i] * Math.cos(ths[i]); y += L[i] * Math.sin(ths[i]); pts.push({ x, y }); }
        for (let i = 0; i < 3; i++) g.moveTo(pts[i].x, pts[i].y).lineTo(pts[i + 1].x, pts[i + 1].y).stroke({ width: 6 - i, color: 0x9fb4d4 });
        for (const p of pts) g.circle(p.x, p.y, 3).fill(0x5b9bd5);
        g.circle(pts[3].x, pts[3].y, 4).fill(col);                   // 末端
      } else if (tmpl === "cnc_machining_center") {
        g.rect(-18, -6, 36, 30).fill(0x37445c).stroke({ width: 1, color: 0x4a5a78 }); // 機身
        g.rect(-12, -22, 24, 16).fill(0x2c3850);                     // 主軸箱
        const spin = running ? animT * 8 : 0;                        // 主軸旋轉
        const sx = Math.cos(spin) * 6;
        g.moveTo(-sx, -14).lineTo(sx, -14).stroke({ width: 3, color: running ? 0xffd479 : 0x6b7488 });
        g.circle(0, -14, 2).fill(0x8a93a6);
      } else if (tmpl === "agv_mobile_robot") {
        // 車體沿 pos_x/y 在地坪內移動(此處用相對位移呈現)
        const px = (t["pos_x"] ?? 10) - 10, py = (t["pos_y"] ?? 7) - 7;
        const ox = (px - py) * 5, oy = (px + py) * 2.5;
        g.position.set(ox, oy);
        g.roundRect(-12, -6, 24, 16, 3).fill(0x46586f).stroke({ width: 1, color: col });
        g.circle(-7, 10, 3).fill(0x222c3c); g.circle(7, 10, 3).fill(0x222c3c);
        g.rect(-9, -10, 18, 5).fill(0x5b9bd5);
      } else if (tmpl === "air_compressor") {
        g.roundRect(-16, -4, 32, 26, 5).fill(0x3a4a44).stroke({ width: 1, color: 0x4d6158 }); // 桶
        const rot = running ? animT * 6 : 0;                         // 風扇
        for (let i = 0; i < 4; i++) {
          const a = rot + i * Math.PI / 2;
          g.moveTo(0, 6).lineTo(Math.cos(a) * 9, 6 + Math.sin(a) * 9).stroke({ width: 3, color: running ? 0x9fe0c0 : 0x6b7488 });
        }
        g.circle(0, 6, 2.5).fill(0x8a93a6);
      } else {
        g.rect(-14, -4, 28, 24).fill(0x3a4356).stroke({ width: 1, color: col });
      }
    }

    function smoke(animT: number, dt: number) {
      const fxc = fxRef.current; if (!fxc) return;
      if (!focus && Math.sin(animT * 9) > 0.6) {
        for (const ch of chimneysRef.current) if (Math.random() < 0.5) {
          const g = new Graphics(); fxc.addChild(g);
          smokeRef.current.push({ g, x: ch.x + (Math.random() - 0.5) * 4, y: ch.y, vy: 6 + Math.random() * 6, life: 0, max: 1.4 + Math.random() });
        }
      }
      for (const s of smokeRef.current) {
        s.life += dt; s.y -= s.vy * dt; const tt = s.life / s.max;
        s.g.clear(); s.g.circle(s.x, s.y, 2 + tt * 6).fill({ color: 0x8a93a6, alpha: Math.max(0, 0.35 * (1 - tt)) });
      }
      for (let i = smokeRef.current.length - 1; i >= 0; i--)
        if (smokeRef.current[i].life >= smokeRef.current[i].max) { smokeRef.current[i].g.destroy(); smokeRef.current.splice(i, 1); }
    }

    function recenter() {
      const w = worldRef.current;
      if (w && app.renderer) { w.x = app.screen.width / 2; w.y = app.screen.height * (focus ? 0.28 : 0.32); }
    }
    const onResize = () => { if (ready && app.renderer) { app.renderer.resize(host.clientWidth || 800, host.clientHeight || 600); recenter(); } };
    window.addEventListener("resize", onResize);
    return () => {
      cancelled = true; window.removeEventListener("resize", onResize);
      lightsRef.current = {}; devicesRef.current = {}; stationsRef.current = [];
      chimneysRef.current = []; smokeRef.current = [];
      worldRef.current = null; appRef.current = null; fxRef.current = null;
      if (ready) safeDestroy();
    };
  }, [park, focus]);

  useEffect(() => { update(); }, [telemetry, selected, predicted, focus]);

  function update() {
    const tel = telemetry; if (!tel || focus) return;   // 內部場景由 ticker 即時上色
    for (const [did, v] of Object.entries(devicesRef.current)) {
      const snap = tel.devices[did]; if (!snap) continue;
      const isSel = did === selectedRef.current;
      const isPredicted = predictedRef.current.has(did) && snap.state !== "fault";
      v.kind = snap.state === "fault" ? "fault" : isPredicted ? "predicted" : snap.state;
      const color = isPredicted ? 0xf08c2e : colorOf(snap.state);
      const r = isSel ? 10 : 7;
      v.ring.clear();
      v.ring.circle(0, 0, r).fill(color).stroke({ width: isSel ? 3 : 1.5, color: isSel ? 0xffffff : 0x10151d });
      if (snap.template === "agv_mobile_robot" && "pos_x" in snap.tags) {
        v.target.x = v.base.x + (snap.tags["pos_x"] - 10) * AGV_SCALE;
        v.target.y = v.base.y + (snap.tags["pos_y"] - 7) * AGV_SCALE;
      }
    }
    for (const c of park.companies) {
      const light = lightsRef.current[c.id]; if (!light) continue;
      const states = (c.device_ids || []).map((d) => {
        const st = tel.devices[d]?.state;
        if (st && st !== "fault" && predictedRef.current.has(d)) return "predicted_fault";
        return st;
      }).filter(Boolean) as string[];
      const ws = states.length ? worstState(states) : "idle";
      light.clear(); light.circle(0, 0, 6).fill(colorOf(ws)).stroke({ width: 2, color: 0x10151d });
    }
  }

  const focusName = focus ? park.companies.find((c) => c.id === focus)?.name : null;
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />
      {focus && (
        <div style={{ position: "absolute", top: 12, left: 14, display: "flex", gap: 12, alignItems: "center" }}>
          <button onClick={() => setFocus(null)}
                  style={{ background: "#222c3c", color: "#e6ecf5", border: "1px solid #2e3a4d", borderRadius: 6, padding: "6px 14px", cursor: "pointer" }}>
            ← 返回俯瞰
          </button>
          <span style={{ color: "#c7d2e0", fontWeight: 600 }}>🏭 {focusName} · 廠內即時</span>
        </div>
      )}
      {!focus && (
        <div style={{ position: "absolute", top: 12, left: 14, color: "#8a93a6", fontSize: 13 }}>
          點公司建築進入廠內 ｜ 點設備看即時值
        </div>
      )}
    </div>
  );
}
