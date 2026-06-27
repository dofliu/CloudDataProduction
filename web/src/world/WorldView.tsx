import { useEffect, useRef } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import { Park, TelemetryMsg, colorOf, worstState } from "../api";

// ── 等距投影 ───────────────────────────────────────────
const GRID = 22;
const HW = 22, HH = 11;          // tile 半寬 / 半高
const CX = GRID / 2, CY = GRID / 2;
const AGV_SCALE = 2.4;

function iso(gx: number, gy: number) {
  const rx = gx - CX, ry = gy - CY;
  return { x: (rx - ry) * HW, y: (rx + ry) * HH };
}
function isRoad(gx: number, gy: number) {
  return gx === 7 || gx === 15 || gy === 7 || gy === 15;
}
// 確定性 PRNG(讓園區佈局每次一樣)
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
  return ((r * f) << 16) | ((g * f) << 8) | (b * f);
}

const ROOFS = [0x3a4a63, 0x4a4036, 0x394f4a, 0x44485a, 0x53473a, 0x35506b, 0x4d3f4a];

// 一個等距箱:base 四角(north/east/south/west)往上拉 height
function drawIsoBox(g: Graphics, gx: number, gy: number, w: number, h: number, height: number, roof: number) {
  const N = iso(gx, gy), E = iso(gx + w, gy), S = iso(gx + w, gy + h), W = iso(gx, gy + h);
  const up = (p: { x: number; y: number }) => ({ x: p.x, y: p.y - height });
  const left = darken(roof, 0.62), right = darken(roof, 0.8);
  g.poly([W.x, W.y, S.x, S.y, up(S).x, up(S).y, up(W).x, up(W).y]).fill(left);     // 左面
  g.poly([S.x, S.y, E.x, E.y, up(E).x, up(E).y, up(S).x, up(S).y]).fill(right);    // 右面
  g.poly([up(N).x, up(N).y, up(E).x, up(E).y, up(S).x, up(S).y, up(W).x, up(W).y]) // 屋頂
    .fill(roof).stroke({ width: 1, color: darken(roof, 1.15) });
}

interface DeviceVisual {
  container: Container; ring: Graphics; pulse: Graphics;
  base: { x: number; y: number }; target: { x: number; y: number };
  kind: string;
}
interface Smoke { g: Graphics; x: number; y: number; vy: number; life: number; max: number; }

export default function WorldView({
  park, telemetry, selected, onSelect, predicted,
}: {
  park: Park; telemetry: TelemetryMsg | null;
  selected: string | null; onSelect: (id: string) => void; predicted: Set<string>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const lightsRef = useRef<Record<string, Graphics>>({});
  const devicesRef = useRef<Record<string, DeviceVisual>>({});
  const chimneysRef = useRef<{ x: number; y: number }[]>([]);
  const smokeRef = useRef<Smoke[]>([]);
  const fxRef = useRef<Container | null>(null);
  const onSelectRef = useRef(onSelect);
  const selectedRef = useRef(selected);
  const predictedRef = useRef(predicted);
  onSelectRef.current = onSelect; selectedRef.current = selected; predictedRef.current = predicted;

  useEffect(() => {
    let cancelled = false, ready = false;
    const host = hostRef.current!;
    const app = new Application();
    const safeDestroy = () => { try { app.destroy(true, { children: true }); } catch { /* */ } };

    (async () => {
      await app.init({ background: 0x10151d, antialias: true,
                       width: host.clientWidth || 800, height: host.clientHeight || 600 });
      if (cancelled) { safeDestroy(); return; }
      ready = true; appRef.current = app; host.appendChild(app.canvas);

      const world = new Container(); app.stage.addChild(world); worldRef.current = world;
      recenter();

      // 1) 地磚 + 街道(整片畫進一個 Graphics)
      const ground = new Graphics();
      for (let gx = 0; gx < GRID; gx++) for (let gy = 0; gy < GRID; gy++) {
        const N = iso(gx, gy), E = iso(gx + 1, gy), S = iso(gx + 1, gy + 1), W = iso(gx, gy + 1);
        const road = isRoad(gx, gy);
        const col = road ? 0x20242c : ((gx + gy) % 2 === 0 ? 0x1b2230 : 0x18202c);
        ground.poly([N.x, N.y, E.x, E.y, S.x, S.y, W.x, W.y]).fill(col);
        if (road) { // 路面虛線
          const mx = (N.x + S.x) / 2, my = (N.y + S.y) / 2;
          ground.circle(mx, my, 1.2).fill(0x3a4150);
        }
      }
      world.addChild(ground);

      // 2) 裝飾建築(確定性佈局,依深度由後往前加),公司格保留
      const reserved = new Set<string>();
      for (const c of park.companies) {
        const p = c.map_pos;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++)
          reserved.add(`${p.x + dx},${p.y + dy}`);
      }
      const occupied = new Set<string>();
      const rnd = mulberry32(20260627);
      const props: { gx: number; gy: number; w: number; h: number; ht: number; roof: number; chimney: boolean }[] = [];
      for (let gx = 1; gx < GRID - 1; gx++) for (let gy = 1; gy < GRID - 1; gy++) {
        if (isRoad(gx, gy) || reserved.has(`${gx},${gy}`) || occupied.has(`${gx},${gy}`)) continue;
        if (rnd() > 0.22) continue;
        const w = rnd() > 0.7 ? 2 : 1, h = rnd() > 0.7 ? 2 : 1;
        let clash = false;
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) {
          const k = `${gx + dx},${gy + dy}`;
          if (isRoad(gx + dx, gy + dy) || reserved.has(k) || occupied.has(k)) clash = true;
        }
        if (clash) continue;
        for (let dx = 0; dx < w; dx++) for (let dy = 0; dy < h; dy++) occupied.add(`${gx + dx},${gy + dy}`);
        props.push({ gx, gy, w, h, ht: 14 + Math.floor(rnd() * 42), roof: ROOFS[Math.floor(rnd() * ROOFS.length)], chimney: rnd() > 0.78 });
      }
      props.sort((a, b) => (a.gx + a.gy) - (b.gx + b.gy));
      for (const b of props) {
        const g = new Graphics(); drawIsoBox(g, b.gx, b.gy, b.w, b.h, b.ht, b.roof); world.addChild(g);
        if (b.chimney) {
          const top = iso(b.gx + b.w * 0.5, b.gy + b.h * 0.5);
          chimneysRef.current.push({ x: top.x, y: top.y - b.ht - 4 });
        }
      }

      // 3) 公司建築(可點設備、屋頂燈、煙囪、招牌)
      const slots = [[-30, -8], [30, -8], [-30, 14], [30, 14], [0, 26]];
      const companies = [...park.companies].sort((a, b) => (a.map_pos.x + a.map_pos.y) - (b.map_pos.x + b.map_pos.y));
      for (const c of companies) {
        const p = iso(c.map_pos.x, c.map_pos.y);
        const g = new Graphics(); drawIsoBox(g, c.map_pos.x, c.map_pos.y, 2, 2, 46, 0x2b3950); world.addChild(g);
        chimneysRef.current.push({ x: p.x + 16, y: p.y - 50 });

        const label = new Text({ text: c.name, style: { fill: 0xc7d2e0, fontSize: 12, fontFamily: "Segoe UI", fontWeight: "600" } });
        label.anchor.set(0.5, 0); label.x = p.x; label.y = p.y + 30; world.addChild(label);

        const light = new Graphics(); light.x = p.x; light.y = p.y - 58; world.addChild(light);
        lightsRef.current[c.id] = light;

        c.device_ids.forEach((did, i) => {
          const slot = slots[i % slots.length];
          const base = { x: p.x + slot[0], y: p.y + slot[1] + Math.floor(i / slots.length) * 16 };
          const cont = new Container(); cont.x = base.x; cont.y = base.y;
          cont.eventMode = "static"; cont.cursor = "pointer";
          cont.on("pointertap", () => onSelectRef.current(did));
          const pulse = new Graphics(); cont.addChild(pulse);
          const ring = new Graphics(); cont.addChild(ring);
          const dl = new Text({ text: did, style: { fill: 0x9fb0c4, fontSize: 9, fontFamily: "Segoe UI" } });
          dl.anchor.set(0.5, 0); dl.y = 9; cont.addChild(dl);
          world.addChild(cont);
          devicesRef.current[did] = { container: cont, ring, pulse, base, target: { ...base }, kind: "idle" };
        });
      }

      // 4) 特效層(煙)在最上
      const fx = new Container(); world.addChild(fx); fxRef.current = fx;

      // 動畫 ticker
      let animT = 0;
      app.ticker.add((tk) => {
        animT += tk.deltaMS / 1000;
        // AGV / 設備位置補間
        for (const v of Object.values(devicesRef.current)) {
          v.container.x += (v.target.x - v.container.x) * 0.18;
          v.container.y += (v.target.y - v.container.y) * 0.18;
          // 脈動 / 紅閃
          v.pulse.clear();
          if (v.kind === "fault") {
            const a = 0.5 + 0.5 * Math.sin(animT * 6);
            v.pulse.circle(0, 0, 9 + a * 7).fill({ color: 0xe24c4c, alpha: 0.18 + 0.22 * a });
          } else if (v.kind === "predicted") {
            const a = 0.5 + 0.5 * Math.sin(animT * 3);
            v.pulse.circle(0, 0, 9 + a * 6).fill({ color: 0xf08c2e, alpha: 0.12 + 0.16 * a });
          } else if (v.kind === "running" || v.kind === "moving") {
            const a = 0.5 + 0.5 * Math.sin(animT * 2);
            v.pulse.circle(0, 0, 11).fill({ color: 0x37d67a, alpha: 0.05 + 0.06 * a });
          }
        }
        // 冒煙
        const fxc = fxRef.current;
        if (fxc) {
          if (Math.sin(animT * 9) > 0.6) {
            for (const ch of chimneysRef.current) {
              if (Math.random() < 0.5) {
                const g = new Graphics(); fxc.addChild(g);
                smokeRef.current.push({ g, x: ch.x + (Math.random() - 0.5) * 4, y: ch.y, vy: 6 + Math.random() * 6, life: 0, max: 1.4 + Math.random() });
              }
            }
          }
          for (const s of smokeRef.current) {
            s.life += tk.deltaMS / 1000; s.y -= s.vy * tk.deltaMS / 1000;
            const t = s.life / s.max;
            s.g.clear();
            s.g.circle(s.x, s.y, 2 + t * 6).fill({ color: 0x8a93a6, alpha: Math.max(0, 0.35 * (1 - t)) });
          }
          for (let i = smokeRef.current.length - 1; i >= 0; i--) {
            if (smokeRef.current[i].life >= smokeRef.current[i].max) {
              smokeRef.current[i].g.destroy(); smokeRef.current.splice(i, 1);
            }
          }
        }
      });

      update();
    })();

    function recenter() {
      const w = worldRef.current;
      if (w && app.renderer) { w.x = app.screen.width / 2; w.y = app.screen.height * 0.32; }
    }
    const onResize = () => { if (ready && app.renderer) { app.renderer.resize(host.clientWidth || 800, host.clientHeight || 600); recenter(); } };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true; window.removeEventListener("resize", onResize);
      lightsRef.current = {}; devicesRef.current = {}; chimneysRef.current = []; smokeRef.current = [];
      worldRef.current = null; appRef.current = null; fxRef.current = null;
      if (ready) safeDestroy();
    };
  }, [park]);

  useEffect(() => { update(); }, [telemetry, selected, predicted]);

  function update() {
    const tel = telemetry; if (!tel) return;
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
      const states = c.device_ids.map((d) => {
        const st = tel.devices[d]?.state;
        if (st && st !== "fault" && predictedRef.current.has(d)) return "predicted_fault";
        return st;
      }).filter(Boolean) as string[];
      const ws = states.length ? worstState(states) : "idle";
      light.clear();
      light.circle(0, 0, 6).fill(colorOf(ws)).stroke({ width: 2, color: 0x10151d });
    }
  }

  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}
