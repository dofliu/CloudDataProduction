/**
 * 量各機種模型在產線視圖裡的實際佔地(世界座標包圍盒),用來訂 processFlow.ts 的
 * HALF_W / LINE_SCALE —— 那兩張表如果用猜的,機台就會互相穿模或中間空一大段。
 *
 *   node preview/measure.mjs
 *
 * 量的是**已套 LINE_SCALE 之後**的尺寸,所以輸出可以直接當 HALF_W 用。
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.join(HERE, "../package.json"))("playwright");
const BASE = process.env.PREVIEW_URL || "http://localhost:5173/preview/models3d.html";

function launchOpts() {
  const exe = process.env.PLAYWRIGHT_CHROMIUM
    ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  return exe ? { executablePath: exe } : {};
}

const browser = await chromium.launch(launchOpts());
const page = await browser.newPage({ viewport: { width: 420, height: 320 } });

await page.goto(`${BASE}?line=measure`, { waitUntil: "load" });
await page.waitForFunction(() => (window).__measured, { timeout: 30000 });
const rows = await page.evaluate(() => (window).__measured);

console.log("template".padEnd(24), "halfW".padStart(7), "halfD".padStart(7), "height".padStart(7),
  "left".padStart(7), "right".padStart(7));
for (const r of rows) {
  console.log(r.template.padEnd(24),
    r.halfW.toFixed(2).padStart(7), r.halfD.toFixed(2).padStart(7), r.height.toFixed(2).padStart(7),
    (r.left ?? 0).toFixed(2).padStart(7), (r.right ?? 0).toFixed(2).padStart(7));
}
console.log("\n// 貼回 processFlow.ts 的 EXTENT_X(相對原點的左/右延伸 +0.3 餘隙):");
console.log("const EXTENT_X: Record<string, [number, number]> = {");
for (const r of rows) {
  console.log(`  ${r.template}: [${((r.left ?? r.halfW) + 0.3).toFixed(1)}, ${((r.right ?? r.halfW) + 0.3).toFixed(1)}],`);
}
console.log("};");

await browser.close();
