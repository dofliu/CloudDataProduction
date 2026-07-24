import { Application, Container, Graphics, Text } from "pixi.js";
import {
  mCNC, mInjection, mArm, mCompressor, mTurbine, mChamber, mMeter, mPress, mFurnace, mAGV,
} from "../src/world/machines";

type Draw = (g: Graphics, ox: number, oy: number, t: number, running: boolean, fault: boolean) => void;
const CELL_W = 200, CELL_H = 200, COLS = 4;

// 每台設備:名稱 + 繪法 + anchor 偏移(讓它落在格子中央)+ 是否示範故障
const MACHINES: { name: string; off: [number, number]; draw: Draw; fault?: boolean }[] = [
  { name: "CNC 加工中心", off: [-38, -34], draw: (g, ox, oy, t, r, f) => mCNC(g, ox, oy, t, r, f), fault: true },
  { name: "射出成型機", off: [-30, -30], draw: (g, ox, oy, t, r) => mInjection(g, ox, oy, t, r) },
  { name: "6 軸機械臂", off: [2, -6], draw: (g, ox, oy, t, r) => mArm(g, ox, oy, t, [ox - 46, oy - 14], [ox + 34, oy + 40]) },
  { name: "空壓機", off: [-32, -20], draw: (g, ox, oy, t, r) => mCompressor(g, ox, oy, t, r) },
  { name: "風力機", off: [8, 44], draw: (g, ox, oy, t, r) => mTurbine(g, ox, oy, t, r ? 14 : 3) },
  { name: "半導體製程腔體", off: [-30, -26], draw: (g, ox, oy, t, r) => mChamber(g, ox, oy, t, r) },
  { name: "能源電表", off: [-16, -20], draw: (g, ox, oy, t, r) => mMeter(g, ox, oy, t, r) },
  { name: "沖壓機", off: [-18, 6], draw: (g, ox, oy, t, r) => mPress(g, ox, oy, t, r) },
  { name: "熱處理爐", off: [-30, -26], draw: (g, ox, oy, t, r) => mFurnace(g, ox, oy, t, r) },
  { name: "AGV 移動機器人", off: [6, -14], draw: (g, ox, oy, t, r) => mAGV(g, ox, oy, t, r) },
];

async function main() {
  const app = new Application();
  await app.init({ background: 0xefe6d6, antialias: true, width: COLS * CELL_W, height: Math.ceil(MACHINES.length / COLS) * CELL_H });
  document.getElementById("host")!.appendChild(app.canvas);

  const arts: { g: Graphics; m: typeof MACHINES[number]; ox: number; oy: number; running: boolean }[] = [];
  MACHINES.forEach((m, i) => {
    const col = i % COLS, row = Math.floor(i / COLS);
    const cx = col * CELL_W + CELL_W / 2, cy = row * CELL_H + CELL_H / 2;
    const cont = new Container(); cont.x = cx; cont.y = cy; app.stage.addChild(cont);
    // 格線 + 名稱
    const frame = new Graphics();
    frame.rect(-CELL_W / 2 + 4, -CELL_H / 2 + 4, CELL_W - 8, CELL_H - 8).stroke({ width: 1, color: 0xd8c6a8 });
    cont.addChild(frame);
    const lab = new Text({ text: m.name, style: { fill: 0x453a29, fontSize: 13, fontFamily: "sans-serif", fontWeight: "600" } });
    lab.anchor.set(0.5, 0); lab.y = CELL_H / 2 - 26; cont.addChild(lab);
    const g = new Graphics(); cont.addChild(g);
    arts.push({ g, m, ox: m.off[0], oy: m.off[1], running: true });
  });

  let t = 0;
  app.ticker.add((tk) => {
    t += tk.deltaMS / 1000;
    for (const a of arts) { a.g.clear(); a.m.draw(a.g, a.ox, a.oy, t, a.running, a.m.fault ?? false); }
    (window as any).__t = t;
  });
  (window as any).__ready = true;
}
main();
