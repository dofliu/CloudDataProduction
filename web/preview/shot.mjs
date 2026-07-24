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
// 抓兩個時間點:t≈1.4s(切削/合模中段)與 t≈3.0s(不同相位)
for (const target of [1.4, 3.0]) {
  await page.waitForFunction((tt) => window.__t >= tt, target, { timeout: 10000 });
  await page.screenshot({ path: path.join(outDir, `machines_t${target}.png`) });
}
if (errs.length) console.log("PAGE_ERRORS:\n" + errs.join("\n"));
else console.log("OK no page errors");
await browser.close();
