import { chromium } from "playwright";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const url = "file://" + path.join(dir, "machines.html");
const outDir = process.argv[2] || dir;

/**
 * Chromium 位置:CI(GitHub Actions)用 playwright 自己裝的那份,本機開發環境
 * 則有預先安裝在 /opt/pw-browsers/chromium。用環境變數覆寫,兩邊都能跑。
 *   PLAYWRIGHT_CHROMIUM=<path>  指定;留空 = 交給 playwright 自己找。
 */
function launchOpts() {
  const exe = process.env.PLAYWRIGHT_CHROMIUM
    ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  return exe ? { executablePath: exe } : {};
}

const browser = await chromium.launch(launchOpts());
const page = await browser.newPage({ viewport: { width: 820, height: 660 }, deviceScaleFactor: 2 });
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
page.on("pageerror", (e) => errs.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => window.__ready === true, { timeout: 10000 });
// 抓多個時間點以涵蓋各機台不同動作相位
for (const target of [0.8, 1.7, 4.4, 5.2]) {
  await page.waitForFunction((tt) => window.__t >= tt, target, { timeout: 10000 });
  await page.screenshot({ path: path.join(outDir, `machines_t${target}.png`) });
}
if (errs.length) console.log("PAGE_ERRORS:\n" + errs.join("\n"));
else console.log("OK no page errors");
await browser.close();
