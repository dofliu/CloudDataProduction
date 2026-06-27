import { useEffect, useRef } from "react";
import { Application, Container, Graphics, Text } from "pixi.js";
import { Park, TelemetryMsg, colorOf, worstState } from "../api";

// 等距投影參數
const HW = 30, HH = 16;          // tile 半寬 / 半高
const BH = 30;                   // 建築高度
const AGV_SCALE = 3.2;           // AGV pos(公尺)→ 螢幕像素

interface DeviceVisual {
  container: Container;
  ring: Graphics;
  base: { x: number; y: number };  // 相對 worldContainer 的基準座標
  target: { x: number; y: number };  // 移動目標(AGV 用,ticker 補間逼近)
  companyId: string;
}

export default function WorldView({
  park, telemetry, selected, onSelect, predicted,
}: {
  park: Park;
  telemetry: TelemetryMsg | null;
  selected: string | null;
  onSelect: (id: string) => void;
  predicted: Set<string>;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const lightsRef = useRef<Record<string, Graphics>>({});
  const devicesRef = useRef<Record<string, DeviceVisual>>({});
  const onSelectRef = useRef(onSelect);
  const selectedRef = useRef(selected);
  const predictedRef = useRef(predicted);
  onSelectRef.current = onSelect;
  selectedRef.current = selected;
  predictedRef.current = predicted;

  // ── 建場景(只在掛載 / park 變動時)──────────────────
  useEffect(() => {
    let cancelled = false;
    let ready = false;
    const host = hostRef.current!;
    const app = new Application();

    const safeDestroy = () => { try { app.destroy(true, { children: true }); } catch { /* ignore */ } };

    (async () => {
      // 不用 resizeTo(其 ResizePlugin 在 StrictMode 雙掛載下會 _cancelResize 出錯),改手動量測 + resize
      const w0 = host.clientWidth || 800, h0 = host.clientHeight || 600;
      await app.init({ background: 0x0f141b, antialias: true, width: w0, height: h0 });
      if (cancelled) { safeDestroy(); return; }   // init 完成前已卸載 → 此時才安全 destroy
      ready = true;
      appRef.current = app;
      host.appendChild(app.canvas);

      const world = new Container();
      app.stage.addChild(world);
      worldRef.current = world;
      recenter();

      // 公司座標中心化(讓園區置中)
      const cs = park.companies;
      const cx = cs.reduce((s, c) => s + c.map_pos.x, 0) / cs.length;
      const cy = cs.reduce((s, c) => s + c.map_pos.y, 0) / cs.length;
      const iso = (gx: number, gy: number) => {
        const rx = gx - cx, ry = gy - cy;
        return { x: (rx - ry) * HW, y: (rx + ry) * HH };
      };

      // 地面底盤
      const ground = new Graphics();
      const gpad = 4;
      const corners = [iso(cx - gpad, cy - gpad), iso(cx + gpad, cy - gpad), iso(cx + gpad, cy + gpad), iso(cx - gpad, cy + gpad)];
      ground.poly(corners.flatMap((p) => [p.x, p.y])).fill(0x141b25).stroke({ width: 1, color: 0x222c3c });
      world.addChild(ground);

      const slots = [ [-44, -10], [44, -10], [-44, 16], [44, 16], [0, 30] ];

      for (const c of cs) {
        const p = iso(c.map_pos.x, c.map_pos.y);

        // 建築(等距箱)
        const b = new Graphics();
        const left = [[-HW, 0], [0, HH], [0, HH - BH], [-HW, -BH]];
        const right = [[0, HH], [HW, 0], [HW, -BH], [0, HH - BH]];
        const top = [[0, -HH - BH], [HW, -BH], [0, HH - BH], [-HW, -BH]];
        b.poly(left.flat()).fill(0x273244);
        b.poly(right.flat()).fill(0x202a3a);
        b.poly(top.flat()).fill(0x344560).stroke({ width: 1, color: 0x3e4f6b });
        b.x = p.x; b.y = p.y;
        world.addChild(b);

        // 公司名
        const label = new Text({ text: c.name, style: { fill: 0xc7d2e0, fontSize: 13, fontFamily: "Segoe UI" } });
        label.anchor.set(0.5, 0); label.x = p.x; label.y = p.y + HH + 4;
        world.addChild(label);

        // 公司彙整燈號(屋頂)
        const light = new Graphics();
        light.x = p.x; light.y = p.y - HH - BH - 8;
        world.addChild(light);
        lightsRef.current[c.id] = light;

        // 設備標記
        c.device_ids.forEach((did, i) => {
          const slot = slots[i % slots.length];
          const base = { x: p.x + slot[0], y: p.y + slot[1] };
          const cont = new Container();
          cont.x = base.x; cont.y = base.y;
          cont.eventMode = "static"; cont.cursor = "pointer";
          cont.on("pointertap", () => onSelectRef.current(did));

          const ring = new Graphics();
          cont.addChild(ring);
          const dlabel = new Text({ text: did, style: { fill: 0x9fb0c4, fontSize: 10, fontFamily: "Segoe UI" } });
          dlabel.anchor.set(0.5, 0); dlabel.y = 9;
          cont.addChild(dlabel);

          world.addChild(cont);
          devicesRef.current[did] = { container: cont, ring, base, target: { ...base }, companyId: c.id };
        });
      }

      // 補間 ticker:每幀把標記逼近目標位置 → AGV 平順滑行(不受高倍率瞬移影響)
      app.ticker.add(() => {
        for (const v of Object.values(devicesRef.current)) {
          v.container.x += (v.target.x - v.container.x) * 0.18;
          v.container.y += (v.target.y - v.container.y) * 0.18;
        }
      });

      update(); // 首次上色
    })();

    function recenter() {
      const w = worldRef.current;
      if (w && app.renderer) { w.x = app.screen.width / 2; w.y = app.screen.height * 0.42; }
    }
    const onResize = () => {
      if (!ready || !app.renderer) return;
      app.renderer.resize(host.clientWidth || 800, host.clientHeight || 600);
      recenter();
    };
    window.addEventListener("resize", onResize);

    return () => {
      cancelled = true;
      window.removeEventListener("resize", onResize);
      lightsRef.current = {}; devicesRef.current = {};
      worldRef.current = null; appRef.current = null;
      if (ready) safeDestroy();   // 尚未 ready 時,留給 async 區塊在 init 完成後 destroy
    };
  }, [park]);

  // ── 每次 telemetry / 選取 / 預測集合變動時重新上色 ────
  useEffect(() => { update(); }, [telemetry, selected, predicted]);

  function update() {
    const tel = telemetry;
    const devs = devicesRef.current;
    if (!tel) return;

    // 設備標記
    for (const [did, v] of Object.entries(devs)) {
      const snap = tel.devices[did];
      if (!snap) continue;
      const isSel = did === selectedRef.current;
      // 預測中(且尚未真故障)→ 橘;真故障紅優先
      const isPredicted = predictedRef.current.has(did) && snap.state !== "fault";
      const color = isPredicted ? 0xf08c2e : colorOf(snap.state);
      const r = isSel ? 11 : 8;
      v.ring.clear();
      v.ring.circle(0, 0, r).fill(color).stroke({ width: isSel ? 3 : 1.5, color: isSel ? 0xffffff : 0x0f141b });
      if (snap.state === "fault") v.ring.circle(0, 0, r + 5).stroke({ width: 1.5, color: 0xe24c4c });
      else if (isPredicted) v.ring.circle(0, 0, r + 5).stroke({ width: 1.5, color: 0xf08c2e });

      // AGV 依 pos_x/y 移動(局部 0..20m,中心 (10,7));設目標,由 ticker 平滑逼近
      if (snap.template === "agv_mobile_robot" && "pos_x" in snap.tags) {
        v.target.x = v.base.x + (snap.tags["pos_x"] - 10) * AGV_SCALE;
        v.target.y = v.base.y + (snap.tags["pos_y"] - 7) * AGV_SCALE;
      }
    }

    // 公司燈號 = 旗下設備最差狀態
    for (const c of park.companies) {
      const light = lightsRef.current[c.id];
      if (!light) continue;
      const states = c.device_ids.map((d) => {
        const st = tel.devices[d]?.state;
        if (st && st !== "fault" && predictedRef.current.has(d)) return "predicted_fault";
        return st;
      }).filter(Boolean) as string[];
      const ws = states.length ? worstState(states) : "idle";
      light.clear();
      light.circle(0, 0, 7).fill(colorOf(ws)).stroke({ width: 2, color: 0x0f141b });
      if (ws === "fault") light.circle(0, 0, 12).stroke({ width: 2, color: 0xe24c4c });
    }
  }

  return <div ref={hostRef} style={{ position: "absolute", inset: 0 }} />;
}
