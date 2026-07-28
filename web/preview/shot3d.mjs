/**
 * 3D 機種預覽自動截圖 + console 錯誤檢查(dev only)。
 *
 *   cd web && npx vite &            # 起 dev server
 *   node preview/shot3d.mjs <outdir>
 *
 * 一次只開一個 Canvas(逐 index 導頁),避免超過瀏覽器的 WebGL context 上限。
 * 會把所有 console error / pageerror 收集起來一起印 —— 這是離線資源(CDN 字型 / HDR)
 * 回歸的第一道防線。
 */
import { chromium } from "playwright";
import path from "path";

const outDir = process.argv[2] || ".";
const base = process.env.PREVIEW_URL || "http://localhost:5173/preview/models3d.html";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 900, height: 520 } });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", (e) => errs.push(String(e)));

await page.goto(`${base}?i=0`, { waitUntil: "load" });
await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
const n = await page.evaluate(() => window.__caseCount);
const titles = await page.evaluate(() => window.__caseTitles);

for (let i = 0; i < n; i++) {
  await page.goto(`${base}?i=${i}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.waitForTimeout(2500);           // 讓動畫跑幾個相位
  await page.screenshot({ path: path.join(outDir, `m3d_${String(i).padStart(2, "0")}.png`) });
  process.stdout.write(`${i} ${titles[i]}\n`);
}

console.log(errs.length ? "PAGE_ERRORS:\n" + [...new Set(errs)].join("\n") : "OK no page errors");
await browser.close();
