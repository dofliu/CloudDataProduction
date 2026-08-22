/**
 * 把廠內產線視圖的幾種配方各拍一張,用來人眼驗收「製程佈局讀不讀得懂」。
 *   node preview/shotline.mjs <outdir> [combo...]
 * 沒給 combo 就全拍。與 shot3d.mjs 一樣會把 console error 當失敗。
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.join(HERE, "../package.json"))("playwright");

const BASE = process.env.PREVIEW_URL || "http://localhost:5173/preview/models3d.html";
const OUT = process.argv[2] || "/tmp/lineshots";
const COMBOS = process.argv.slice(3).length ? process.argv.slice(3)
  : ["cnc", "inj", "press", "agv", "solo", "mixed",
     "weld", "laserpack", "aoi", "casting", "forging",
     "finishing", "handtool"];

function launchOpts() {
  const exe = process.env.PLAYWRIGHT_CHROMIUM
    ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  return exe ? { executablePath: exe } : {};
}
const ignorable = (m) => (m.location?.()?.url ?? "").endsWith("/favicon.ico");

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(launchOpts());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errs = [];
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !ignorable(m)) errs.push(m.text()); });

for (const c of COMBOS) {
  await page.goto(`${BASE}?line=${c}`, { waitUntil: "load" });
  // 場景是 autoRotate 的,等它轉回接近正面再拍,不然每次角度都不一樣沒法比對
  await page.waitForTimeout(2600);
  await page.screenshot({ path: path.join(OUT, `line_${c}.png`) });
  console.log(`${c} → line_${c}.png`);
}

console.log(errs.length ? `PAGE ERRORS:\n${[...new Set(errs)].join("\n")}` : "OK no page errors");
await browser.close();
process.exit(errs.length ? 1 : 0);
