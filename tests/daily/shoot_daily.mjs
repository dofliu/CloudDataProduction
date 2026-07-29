/**
 * 用當天的 telemetry 逐台截圖(前 / 後對照),給每日測試報告用。
 *
 *   node tests/daily/shoot_daily.mjs [outdir]
 *
 * 讀 <outdir>/result.json 決定要拍哪些機種,重播 web/preview/frames_daily.json ——
 * 也就是**同一份引擎資料**既拿去判定、也拿去畫面,不是另外造一組給報告看的。
 *
 * 拍兩個時間點:觀測窗開頭(注入剛生效)與結尾(效果最明顯)。退化類的情境,
 * 兩張擺在一起才看得出「東西在變壞」,單張看不出來。
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const { chromium } = createRequire(path.join(ROOT, "web/package.json"))("playwright");

const BASE = process.env.VERIFY_URL || "http://localhost:5173/preview/verify.html";
const OUT = process.argv[2] || path.join(ROOT, "artifacts/daily");

function launchOpts() {
  const exe = process.env.PLAYWRIGHT_CHROMIUM
    ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
  return exe ? { executablePath: exe } : {};
}
const ignorable = (m) => (m.location?.()?.url ?? "").endsWith("/favicon.ico");

const result = JSON.parse(fs.readFileSync(path.join(OUT, "result.json"), "utf-8"));
const shots = [];
const errs = [];

fs.mkdirSync(path.join(OUT, "shots"), { recursive: true });
const browser = await chromium.launch(launchOpts());
const page = await browser.newPage({ viewport: { width: 900, height: 560 } });
page.on("pageerror", (e) => errs.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !ignorable(m)) errs.push(m.text()); });

for (const tmpl of result.shoot ?? []) {
  await page.goto(`${BASE}?device=${tmpl}&capture=daily`, { waitUntil: "load" });
  // 這支載具是照 device **template** 找第一台符合的設備來重播
  const ready = await page.waitForFunction(() => window.__ready === true, { timeout: 30000 })
    .then(() => true).catch(() => false);
  if (!ready) { errs.push(`${tmpl}: 載具未就緒`); continue; }
  const n = await page.evaluate(() => window.__frameCount);

  for (const [label, idx] of [["before", 1], ["after", n - 1]]) {
    await page.evaluate((k) => window.__setFrame(k), idx);
    await page.waitForTimeout(2200);          // 等補間收斂 + 機構走幾個循環
    const file = `shots/${tmpl}_${label}.png`;
    await page.screenshot({ path: path.join(OUT, file) });
    const tags = await page.evaluate(() => window.__currentTags());
    const state = await page.evaluate(() => window.__currentState());
    shots.push({ template: tmpl, label, file, frame: idx, state, tags });
    console.log(`${tmpl} ${label} (frame ${idx}, state=${state})`);
  }
}

fs.writeFileSync(path.join(OUT, "shots.json"),
  JSON.stringify({ shots, page_errors: [...new Set(errs)] }, null, 2));
console.log(errs.length ? `PAGE ERRORS:\n${[...new Set(errs)].join("\n")}` : "OK no page errors");
await browser.close();
process.exit(errs.length ? 1 : 0);
