import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";

const dir = path.dirname(fileURLToPath(import.meta.url));
const url = "file://" + path.join(dir, "machines.html");
const outDir = process.argv[2] || dir;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const page = await browser.newPage({ viewport: { width: 820, height: 660 }, deviceScaleFactor: 2 });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
// 抓多個時間點以涵蓋各機台不同動作相位
for (const target of [0.8, 2.2, 3.6, 5.2]) {
  await page.waitForFunction((tt) => window.__t >= tt, target, { timeout: 10000 });
  await page.screenshot({ path: path.join(outDir, `machines_t${target}.png`) });
}
if (errs.length) console.log("PAGE_ERRORS:\n" + errs.join("\n"));
else console.log("OK no page errors");
await browser.close();
