/**
 * 動畫正確性驗證 —— 比對「three.js 場景中機構的實際世界座標」與「引擎發出的 tag 值」。
 *
 * 資料是 capture_frames.py 從真實 engine.World.step() 錄下來的,不是手寫的假資料。
 * 位置類檢查會把整段幀序的 (tag, 探針座標) 收集起來做**線性回歸**:
 *   · slope 必須等於契約(docs/animation_binding.md)寫的比例
 *   · R² 必須 ≈ 1(代表是嚴格的線性對應,不是碰巧接近)
 * 這樣能同時抓到:接錯 tag(R² 崩)、軸向對調(交叉項才有 R²=1)、比例錯、符號反了。
 *
 * 兩份擷取對應契約 §1 鐵則三的兩種情形:
 *   slow(multiplier=1,dt_sim 0.25 s)—— 取樣遠高於機構循環,畫面必須逐幀精確追隨。
 *   fast(multiplier=120,dt_sim 120 s)—— 課堂設定,週期量完全 aliasing,
 *      契約規定改走 L3 自由播放並在畫面標倍率;此時驗的是「行程範圍 / 速率 / 標示」。
 *
 * 用法(playwright 裝在 web/,腳本會自己指過去):
 *   python3 tests/animation/capture_frames.py web/preview
 *   cd web && npx vite &
 *   node tests/animation/verify_animation.mjs
 */
import { createRequire } from "module";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.join(HERE, "../../web/package.json"))("playwright");

const BASE = process.env.VERIFY_URL || "http://localhost:5173/preview/verify.html";
// 取樣前要等補間收斂。與其猜一個固定秒數(猜太短會量到過渡值、猜太長整套測試變慢),
// 直接**輪詢到探針不再變動**為止 —— 這樣殘差是真的收斂殘差,不是等太短的假象。
const SETTLE_POLL_MS = 220;
const SETTLE_MAX_MS = 4000;

// ── 統計工具 ──────────────────────────────────────────────
function linreg(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept: my - slope * mx, r2, spanX: Math.max(...xs) - Math.min(...xs) };
}
const span = (a) => Math.max(...a) - Math.min(...a);
const col = (rows, f) => rows.map(f);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}\n        ${detail}`);
}

/**
 * 判定用兩個量,不只看 R²:
 *   slope        —— 必須等於契約寫的比例(抓換算錯 / 符號反)
 *   maxErr       —— 用契約的比例把探針座標**還原回工程單位**,與 tag 的最大差值
 *
 * 為什麼要 maxErr:像 CNC 的 pos_z 這種近乎二元的訊號(抬刀 +50 / 下刀 −50),
 * R² 對「轉換瞬間差一格」極度敏感,即使實際誤差只有幾 mm 也會掉到 0.98。
 * 還原誤差是可以直接讀懂的量:「刀尖位置與遙測最大差 N mm」。
 * R² 仍然印出來當輔助(它才抓得到軸向對調)。
 */
function checkLinear(name, tagVals, probeVals, expectSlope, unit,
                     { tol = 0.03, minSpan = 1e-6, maxErrAllowed = Infinity, rmsAllowed = Infinity, minR2 = 0 } = {}) {
  const { slope, intercept, r2, spanX } = linreg(tagVals, probeVals);
  // 用契約斜率 + 實測常數位移還原,誤差才是「動畫偏離資料多少」
  const off = probeVals.reduce((a, p, i) => a + (p - expectSlope * tagVals[i]), 0) / probeVals.length;
  const errs = tagVals.map((t, i) => Math.abs((probeVals[i] - off) / expectSlope - t));
  const maxErr = Math.max(...errs);
  const rms = Math.sqrt(errs.reduce((a, e) => a + e * e, 0) / errs.length);
  const ok = Math.abs(slope - expectSlope) <= Math.abs(expectSlope) * tol + 1e-9
    && spanX >= minSpan && maxErr <= maxErrAllowed && rms <= rmsAllowed && r2 >= minR2;
  const limit = maxErrAllowed !== Infinity ? `max≤${maxErrAllowed}` : `rms≤${rmsAllowed}`;
  check(name, ok,
    `還原誤差 max ${maxErr.toFixed(2)} / rms ${rms.toFixed(2)} ${unit}(容許 ${limit} ${unit})`
    + ` · slope=${slope.toPrecision(4)}(契約 ${expectSlope})· R²=${r2.toFixed(5)}`
    + ` · tag 變動 ${spanX.toFixed(1)} ${unit}`);
}

// ── 瀏覽器 ────────────────────────────────────────────────
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

/**
 * 要不要把這則 console error 當成失敗。
 * 只放行一種:瀏覽器自動去要 /favicon.ico 而預覽頁沒有提供 —— 與被測的 3D 層無關。
 * 其他一律視為失敗,離線資源(CDN 字型 / HDR)回歸才擋得住。
 */
function isIgnorableConsoleError(msg) {
  const url = msg.location?.()?.url ?? "";
  return url.endsWith("/favicon.ico");
}

const browser = await chromium.launch(launchOpts());
// 這個環境是軟體渲染(SwiftShader),畫面越大越慢。驗證只讀場景座標、不看畫面,
// 所以用小視窗把 fps 拉上來 —— 低 fps 會讓補間量到的是過渡值而不是穩態。
const page = await browser.newPage({ viewport: { width: 380, height: 280 } });
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !isIgnorableConsoleError(m)) pageErrors.push(m.text()); });

/** 輪詢到指定探針的世界座標穩定為止,回傳最後一次讀值。 */
async function settle(probeNames, tol = 2e-4) {
  let prev = null;
  const t0 = Date.now();
  while (Date.now() - t0 < SETTLE_MAX_MS) {
    await page.waitForTimeout(SETTLE_POLL_MS);
    const cur = await page.evaluate((names) => {
      const p = window.__probes || {};
      const o = {};
      for (const n of names) if (p[n]) o[n] = { x: p[n].x, y: p[n].y, z: p[n].z, ry: p[n].ry };
      return o;
    }, probeNames);
    if (prev) {
      let worst = 0;
      for (const n of Object.keys(cur)) {
        for (const k of ["x", "y", "z", "ry"]) {
          worst = Math.max(worst, Math.abs((cur[n][k] ?? 0) - (prev[n]?.[k] ?? 0)));
        }
      }
      if (worst < tol) return true;
    }
    prev = cur;
  }
  return false;   // 超時仍未穩定 —— 交給呼叫端自己判斷是否可接受
}

/**
 * 在頁面內用 rAF 全速記錄某探針某軸的值,回傳 {min, max, span, n}。
 *
 * 為什麼不從 Node 輪詢:像射出機模板這種「大部分時間停在合模位、只在開模那一小段
 * 快速移動」的機構,從 Node 每 120 ms 打一次 evaluate(實際往返更久)會直接錯過
 * 行程頂點,量到的 span 偏小 —— 那是取樣不足,不是動畫跑不到位。改在頁面內取樣,
 * 拿得到每一個算繪幀,行程極值才是真的。
 */
async function recordProbe(name, axis, ms) {
  return page.evaluate(([n, ax, dur]) => new Promise((resolve) => {
    let lo = Infinity, hi = -Infinity, count = 0;
    const t0 = performance.now();
    (function tick() {
      const p = window.__probes?.[n];
      if (p && typeof p[ax] === "number") { lo = Math.min(lo, p[ax]); hi = Math.max(hi, p[ax]); count += 1; }
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
      else resolve({ min: lo, max: hi, span: hi - lo, n: count });
    })();
  }), [name, axis, ms]);
}

/** 逐幀播放某台設備,回傳 [{tags, setpoints, state, probes}]。 */
async function sweep(device, capture, { stride = 1, probes = [] } = {}) {
  await page.goto(`${BASE}?device=${device}&capture=${capture}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  const n = await page.evaluate(() => window.__frameCount);
  const out = [];
  let unsettled = 0;
  for (let i = 0; i < n; i += stride) {
    await page.evaluate((k) => window.__setFrame(k), i);
    if (!(await settle(probes))) unsettled += 1;
    out.push(await page.evaluate(() => ({
      tags: window.__currentTags(),
      state: window.__currentState(),
      probes: window.__probes || {},
    })));
  }
  if (unsettled) console.log(`        (註:${unsettled}/${out.length} 幀在 ${SETTLE_MAX_MS}ms 內未完全靜止 —— 週期性機構持續運動屬正常)`);
  return out;
}

console.log(`
動畫 ↔ 模擬資料 一致性驗證
資料來源:engine.World.step()(真實模擬,非 mock)
方法:讀 three.js 場景中機構的世界座標,與引擎 tag 做線性回歸
`);

// ── 1. CNC 三軸位置(slow:契約要求逐幀精確追隨)────────
console.log("[1] CNC 加工中心 · slow(×1)—— 刀尖世界座標 ↔ pos_x / pos_y / pos_z");
{
  const rows = (await sweep("cnc_machining_center", "slow", { stride: 6, probes: ["tool_tip"] })).filter((r) => r.probes.tool_tip);
  const tip = col(rows, (r) => r.probes.tool_tip);
  // 契約 §4.1:引擎 mm ÷ 50 = 模型單位,機台外層 scale 0.5 → 世界 = mm × 0.01
  // 軸向:pos_x→世界 X、pos_z(刀高)→世界 Y、pos_y→世界 Z
  // 容許 8 mm:CNC 行程 ±220 mm,8 mm 是 1.8% —— 肉眼在畫面上分辨不出來的量級
  checkLinear("CNC pos_x → 刀尖世界 X", col(rows, (r) => r.tags.pos_x), col(tip, (p) => p.x), 0.01, "mm",
              { minSpan: 100, maxErrAllowed: 8, minR2: 0.99 });
  checkLinear("CNC pos_y → 刀尖世界 Z", col(rows, (r) => r.tags.pos_y), col(tip, (p) => p.z), 0.01, "mm",
              { minSpan: 50, maxErrAllowed: 8, minR2: 0.99 });
  // pos_z 是階梯狀訊號(抬刀 +50 / 下刀 −50,轉換極快)。單一取樣落在轉換瞬間時,
  // 相位差一格就會放大成十幾 mm 的瞬時誤差 —— 用「最大誤差」判定不合適。
  // 改判 rms(連續段的實際貼合度)+ 抬刀 / 下刀的分類必須 100% 一致(真正該保證的性質)。
  checkLinear("CNC pos_z → 刀尖世界 Y(抬刀 / 下刀軸)", col(rows, (r) => r.tags.pos_z), col(tip, (p) => p.y), 0.01, "mm",
              { minSpan: 50, rmsAllowed: 6 });
  {
    const off = tip.reduce((a, p, i) => a + (p.y - 0.01 * rows[i].tags.pos_z), 0) / tip.length;
    const shownZ = tip.map((p) => (p.y - off) / 0.01);
    const agree = shownZ.filter((z, i) => (z < 0) === (rows[i].tags.pos_z < 0)).length;
    check("CNC 畫面的抬刀 / 下刀與 pos_z 正負號 100% 一致",
      agree === rows.length, `${agree}/${rows.length} 幀一致`);
  }
  const cross = linreg(col(rows, (r) => r.tags.pos_x), col(tip, (p) => p.z));
  check("CNC 軸向未對調(pos_x 不影響世界 Z)", cross.r2 < 0.5, `交叉 R²=${cross.r2.toFixed(4)}(應遠小於 1)`);
  // 切削判定必須來自引擎語意 pos_z < 0
  const cutting = rows.filter((r) => r.tags.pos_z < 0).length;
  check("CNC 下刀 / 抬刀兩種姿態都出現在資料中", cutting > 0 && cutting < rows.length,
    `${cutting}/${rows.length} 幀為 pos_z<0(下刀)`);
}

// ── 2. 機械手臂六軸(slow)─────────────────────────────
console.log("\n[2] 六軸手臂 · slow(×1)—— 關節世界旋轉 ↔ joint_angle_n");
{
  const rows = (await sweep("robot_arm_6axis", "slow", { stride: 6, probes: ["j2_pivot", "tcp"] })).filter((r) => r.probes.j2_pivot && r.probes.tcp);
  let worst = 0, worstAt = null;
  rows.forEach((r, i) => {
    const shown = (r.probes.j2_pivot.ry * 180) / Math.PI;
    const d = Math.abs(((shown - r.tags.joint_angle_1) % 360 + 540) % 360 - 180);
    if (d > worst) { worst = d; worstAt = { i, tag: r.tags.joint_angle_1, shown }; }
  });
  check("手臂 joint_angle_1 → J1 世界 yaw(1:1)", worst < 1.5,
    `最大偏差 ${worst.toFixed(2)}° · J1 取樣範圍 ${span(col(rows, (r) => r.tags.joint_angle_1)).toFixed(1)}°`
    + (worstAt ? ` · 最差 @${worstAt.i} tag=${worstAt.tag.toFixed(1)} 畫面=${worstAt.shown.toFixed(1)}` : ""));

  const tcpR = rows.map((r) => Math.hypot(r.probes.tcp.x, r.probes.tcp.z));
  const tcpY = rows.map((r) => r.probes.tcp.y);
  // 判準看高度:取放 keyframe 改由 IK 生成後,提舉是**等半徑**的垂直移動(半徑只剩
  // 角度插值帶來的微小起伏),「J2/J3/J5 有被吃進去」由高度大幅變化證明即可。
  check("手臂 TCP 隨姿態變化(J2/J3/J5 有被吃進去)", span(tcpY) > 0.5,
    `TCP 高度變動 ${span(tcpY).toFixed(3)} 模型單位(半徑變動 ${span(tcpR).toFixed(3)},等半徑提舉下可近 0)`);

  // J2 是主要的俯仰軸:角度越大(下探)TCP 越低
  const g = linreg(col(rows, (r) => r.tags.joint_angle_2), tcpY);
  check("手臂 joint_angle_2 → TCP 高度(單調下降)", g.r2 > 0.85 && g.slope < 0,
    `R²=${g.r2.toFixed(4)} slope=${g.slope.toFixed(4)} 單位/度`);
}

// ── 3. AGV 平面位置與朝向(fast:純插值,不受相位問題影響)──
console.log("\n[3] AGV · fast(×120)—— 車體世界座標 ↔ pos_x / pos_y,車頭 ↔ heading");
{
  const rows = (await sweep("agv_mobile_robot", "fast", { probes: ["agv_body", "agv_nose"] })).filter((r) => r.probes.agv_body);
  const body = col(rows, (r) => r.probes.agv_body);
  // 容許 0.05 m:AGV 車體直徑 2.4 m,5 cm 是 2%
  checkLinear("AGV pos_x → 車體世界 X(1 m = 1 單位)", col(rows, (r) => r.tags.pos_x), col(body, (p) => p.x), 1.0, "m",
              { minSpan: 4, maxErrAllowed: 0.05, minR2: 0.999 });
  checkLinear("AGV pos_y → 車體世界 Z(1 m = 1 單位)", col(rows, (r) => r.tags.pos_y), col(body, (p) => p.z), 1.0, "m",
              { minSpan: 4, maxErrAllowed: 0.05, minR2: 0.999 });
  const nose = col(rows, (r) => r.probes.agv_nose);
  let worst = 0, worstAt = null;
  rows.forEach((r, i) => {
    const dx = nose[i].x - body[i].x, dz = nose[i].z - body[i].z;
    const shown = (Math.atan2(dx, dz) * 180) / Math.PI;
    const d = Math.abs(((shown - r.tags.heading) % 360 + 540) % 360 - 180);
    if (d > worst) { worst = d; worstAt = { i, tag: r.tags.heading, shown }; }
  });
  check("AGV heading → 車頭方位角(1:1)", worst < 2.0,
    `最大偏差 ${worst.toFixed(2)}° · heading 取樣值 ${[...new Set(col(rows, (r) => Math.round(r.tags.heading)))].join("/")}`
    + (worstAt ? ` · 最差 @${worstAt.i} tag=${worstAt.tag} 畫面=${worstAt.shown.toFixed(1)}` : ""));

  // 到位貼齊:補間收斂後車體必須與遙測座標**一格不差**(不是「差不多」)。
  // 指數趨近若不貼齊,靜止時永遠留一小段漸近殘差 —— 這正是「位置沒有完全到位」。
  // 容許 0.02 m 是弧長投影與浮點餘裕,不是給補間殘差的。
  let worstD = 0;
  rows.forEach((r, i) => {
    const d = Math.hypot(body[i].x - r.tags.pos_x, body[i].z - r.tags.pos_y);
    if (d > worstD) worstD = d;
  });
  check("AGV 收斂後車體與遙測座標一致(到位貼齊,< 0.02 m)", worstD < 0.02,
    `最大距離 ${worstD.toFixed(4)} m(${rows.length} 幀)`);
}

// ── 4. 沖壓機滑塊(契約:1 s 行程在 1~4 Hz 取樣下低於 Nyquist,走 L3 自由播放)──
console.log("\n[4] 沖壓機 —— 滑塊行程 ↔ ram_position(L3 自由播放,驗行程範圍與標示)");
{
  await page.goto(`${BASE}?device=stamping_press&capture=slow`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.evaluate(() => window.__setFrame(20));
  await page.waitForTimeout(600);
  const ys = [];
  for (let i = 0; i < 40; i++) {                       // 連續取樣 4 s,涵蓋 3 s 的顯示週期
    ys.push(await page.evaluate(() => window.__probes.ram?.y));
    await page.waitForTimeout(100);
  }
  const s = span(ys.filter((v) => typeof v === "number"));
  const state = await page.evaluate(() => window.__currentState());
  const ramVals = await page.evaluate(() => window.__currentTags().ram_position);
  // 模型行程 RAM_TRAVEL=3.0 對應 ram_position 0~120 mm
  check("沖壓機 滑塊完整走完 0~120 mm 對應的 3.0 單位行程",
    s > 2.7 && s <= 3.05,
    `畫面行程 ${s.toFixed(3)}/3.0 單位 · state=${state} · 該幀 ram_position=${ramVals} mm`);

  const note = await page.textContent(".mono").catch(() => "");
  check("沖壓機 畫面有標示 L3 時間換算倍率", /慢放|×/.test(note || ""), `畫面標示:「${(note || "").trim()}」`);
}

// ── 5. 輸送帶速率 ────────────────────────────────────────
console.log("\n[5] 輸送帶 —— 工件前進速率 ↔ belt_speed × sim 倍率(夾在可視上限)");
for (const capture of ["slow", "fast"]) {
  await page.goto(`${BASE}?device=conveyor&capture=${capture}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.evaluate(() => window.__setFrame(10));
  await page.waitForTimeout(900);
  // 分母用 Σdelta(動畫實際積分的時間),不是牆鐘 —— 理由見 verify.tsx 的 ProbeReporter
  const a = await page.evaluate(() => ({ t: window.__probes["belt_part0"].travel, d: window.__dtSum }));
  await page.waitForTimeout(2500);
  const b = await page.evaluate(() => ({ t: window.__probes["belt_part0"].travel, d: window.__dtSum }));
  const tags = await page.evaluate(() => window.__currentTags());
  const mult = await page.evaluate(() => window.__multiplier);
  const measured = (b.t - a.t) / (b.d - a.d);
  const expected = Math.min(3.0, (tags.belt_speed || 0) * mult);     // MAX_BELT_UPS = 3.0
  check(`輸送帶(×${mult}) 前進速率 = min(belt_speed × 倍率, 3.0)`,
    Math.abs(measured - expected) / expected < 0.03,
    `量到 ${measured.toFixed(4)} 單位/動畫秒,契約 ${expected.toFixed(4)}`
    + `(belt_speed=${(tags.belt_speed || 0).toFixed(3)} m/s)`);
}

// ── 6. 風機:轉速與槳距 ──────────────────────────────────
console.log("\n[6] 風機 —— 轉子轉速 ↔ rotor_rpm(降頻後)、葉片 roll ↔ pitch_angle");
{
  await page.goto(`${BASE}?device=wind_turbine&capture=slow`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.evaluate(() => window.__setFrame(30));
  await page.waitForTimeout(900);
  // 轉子中心 → 標記點的向量夾角變化才是轉角;直接用標記點的世界座標會被輪轂高度污染
  const grab = () => page.evaluate(() => ({
    hub: window.__probes.rotor_hub, mark: window.__probes.rotor_mark, d: window.__dtSum,
  }));
  const p0 = await grab();
  await page.waitForTimeout(2500);
  const p1 = await grab();
  const tags = await page.evaluate(() => window.__currentTags());
  const mult = await page.evaluate(() => window.__multiplier);
  const ang = (q) => Math.atan2(q.mark.x - q.hub.x, q.mark.y - q.hub.y);
  let d = ang(p1) - ang(p0);
  while (d < -Math.PI) d += Math.PI * 2;
  while (d > Math.PI) d -= Math.PI * 2;
  const dt = p1.d - p0.d;
  const measuredRps = Math.abs(d) / (2 * Math.PI) / dt;
  const expectedRps = Math.min(1.5, (tags.rotor_rpm / 60) * mult);   // MAX_SPIN_RPS
  // 2.5 s 內若轉超過半圈,夾角會繞回來 → 只在未繞圈時判定
  const wrapped = expectedRps * dt > 0.45;
  check("風機 轉子角速度 = min(rotor_rpm/60 × 倍率, 1.5 rev/s)",
    wrapped || Math.abs(measuredRps - expectedRps) / Math.max(1e-6, expectedRps) < 0.1,
    wrapped
      ? `本段轉速過快(${expectedRps.toFixed(3)} rev/s × ${dt.toFixed(2)}s 已繞過半圈),改以「轉子確實在轉」判定:轉角 ${(Math.abs(d) * 180 / Math.PI).toFixed(1)}°`
      : `量到 ${measuredRps.toFixed(4)} rev/動畫秒,契約 ${expectedRps.toFixed(4)}(rotor_rpm=${tags.rotor_rpm.toFixed(2)} ×${mult})`);
  check("風機 pitch_angle ≈ 0 時葉片不順槳", Math.abs(tags.pitch_angle) < 2,
    `pitch=${tags.pitch_angle.toFixed(2)}°(風速未超額定,屬正確行為)`);
}

// ── 7. 空壓機:壓力錶指針 ────────────────────────────────
console.log("\n[7] 空壓機 —— 壓力錶指針角度 ↔ outlet_pressure");
{
  const rows = (await sweep("air_compressor", "slow", { stride: 8, probes: ["gauge_tip"] }))
    .filter((r) => r.probes.gauge_tip && r.probes.gauge_center);
  // 指針相對錶心的方位角;錶盤 270° 對應 0~10 bar → 每 bar 27°
  const ang = rows.map((r) => {
    const dx = r.probes.gauge_tip.x - r.probes.gauge_center.x;
    const dy = r.probes.gauge_tip.y - r.probes.gauge_center.y;
    return (Math.atan2(dx, dy) * 180) / Math.PI;
  });
  const bar = col(rows, (r) => r.tags.outlet_pressure);
  const g = linreg(bar, ang);
  // 錶盤掃 270° / 量程 10 bar。負號來自 three.js:rotation.z 為正時 +Y 轉向 −X,
  // 所以壓力升高時指針尖端的方位角(atan2(dx, dy))是**遞減**的。
  const EXPECT = -270 / 10;
  check("空壓機 outlet_pressure → 指針角度(27°/bar)",
    Math.abs(g.slope - EXPECT) / Math.abs(EXPECT) < 0.05 && g.r2 > 0.99,
    `slope=${g.slope.toFixed(2)}°/bar(契約 ${EXPECT})· R²=${g.r2.toFixed(4)}`
    + ` · 壓力取樣範圍 ${span(bar).toFixed(3)} bar`);
}

// ── 8. 電表:三相電流長條 ───────────────────────────────
console.log("\n[8] 電表 —— 三相長條高度 ↔ current_l1 / l2 / l3");
{
  const rows = (await sweep("energy_meter", "fast", { stride: 2, probes: ["phase_bar_1", "phase_bar_2", "phase_bar_3"] }))
    .filter((r) => r.probes.phase_bar_1);
  // 長條高度 = clamp(current/450) × 1.5 → 每 A 對應 1.5/450 單位
  const EXPECT = 1.5 / 450;
  for (const i of [1, 2, 3]) {
    checkLinear(`電表 current_l${i} → 第 ${i} 相長條高度`,
      col(rows, (r) => r.tags[`current_l${i}`]),
      col(rows, (r) => r.probes[`phase_bar_${i}`].y),
      // minSpan 只要 3 A:這段資料的相電流本來就只在數 A 內起伏,
      // 真正的證據是還原誤差(< 0.1 A)與 R²,不是振幅大小。
      EXPECT, "A", { minSpan: 3, maxErrAllowed: 1.0, minR2: 0.99 });
  }
}

// ── 9. 熱處理爐:加熱功率條 ─────────────────────────────
console.log("\n[9] 熱處理爐 —— 功率條長度 ↔ heating_power");
{
  const rows = (await sweep("heat_treat_furnace", "fast", { stride: 2, probes: ["power_bar_tip"] }))
    .filter((r) => r.probes.power_bar_tip && r.probes.power_bar_base);
  const len = rows.map((r) => Math.hypot(
    r.probes.power_bar_tip.x - r.probes.power_bar_base.x,
    r.probes.power_bar_tip.y - r.probes.power_bar_base.y,
    r.probes.power_bar_tip.z - r.probes.power_bar_base.z));
  const kw = col(rows, (r) => r.tags.heating_power);
  const g = linreg(kw, len);
  // 條長 = clamp((kW-50)/50) × 2.4,再取一半(探針在條的右端 = 中心 + scale/2)
  check("熱處理爐 heating_power → 功率條長度(單調遞增)",
    g.slope > 0 && g.r2 > 0.9,
    `slope=${g.slope.toFixed(4)} 單位/kW · R²=${g.r2.toFixed(4)} · 功率取樣範圍 ${span(kw).toFixed(1)} kW`);
}

// ── 10. 射出成型機:開模行程 ────────────────────────────
console.log("\n[10] 射出成型機 —— 可動模板開模行程(L3 自由播放)");
{
  await page.goto(`${BASE}?device=injection_molding&capture=fast`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.evaluate(() => window.__setFrame(10));
  await page.waitForTimeout(700);
  // 視覺週期被夾在 MIN_PERIOD_S = 3 s,錄 18 s 涵蓋五個以上完整開合模循環 ——
  // 循環數越多,取樣落在行程頂點附近的機會越高(理由同 [11] 節)
  const SEC = 18;
  const rec = await recordProbe("platen", "x", SEC * 1000);
  const fps = rec.n / SEC;
  // 判「走完至少 90% 的行程」而不是「≥1.9/2.0(95%)」:量到的行程是真實值的**下界**,
  // 模板大部分時間停在合模位、只在開模那一小段快速移動,取樣落在行程頂點的機會有限,
  // 而幀率越低漏得越多(本機軟體渲染 ~8.6 fps 量到 1.965;CI runner 只有 6.8 fps,
  // 量到 1.889 就卡在 1.9 的門檻上 —— 那是取樣不足,不是動畫沒走到)。
  // 90% 仍分得出真正的壞掉:模板不動是 0%、只開一半是 50%。
  const MIN_FRAC = 0.90;
  check("射出機 可動模板走完 0~2.0 單位的開模行程",
    rec.span >= 2.0 * MIN_FRAC && rec.span <= 2.05,
    `畫面行程 ${rec.span.toFixed(3)}/2.0 單位 = ${(rec.span / 2 * 100).toFixed(1)}%`
    + `(門檻 ${MIN_FRAC * 100}%)· 合模端 ${rec.min.toFixed(2)} / 開模端 ${rec.max.toFixed(2)}`
    + ` · 頁內取樣 ${rec.n} 幀 ≈ ${fps.toFixed(1)} fps`);
}

// ── 11. 製程腔體:晶圓進出片行程 ────────────────────────
console.log("\n[11] 製程腔體 —— 晶圓進片 / 出片行程(節拍 ↔ throughput)");
{
  await page.goto(`${BASE}?device=semi_process_chamber&capture=fast`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.evaluate(() => window.__setFrame(10));
  await page.waitForTimeout(700);
  const rec = await recordProbe("wafer", "x", 12000);
  const tags = await page.evaluate(() => window.__currentTags());
  // 貫通式:−3.4(左側進片)→ 0(腔內製程)→ +3.4(右側出片),總行程 6.8。
  //
  // 判「兩側都到得了」而不是判 span 有多接近 6.8:這個環境是軟體渲染,腔體場景只跑到
  // 約 9 fps,取樣落在轉折點附近的機率本來就低,量到的 span 永遠是真實行程的下界
  // (少 5% 屬取樣誤差,不是動畫沒走到)。要保證的性質是「進片側與出片側都真的到達」,
  // 那個用 min / max 各自過門檻來驗,對幀率免疫。上界仍然檢查,才擋得住衝過頭。
  const reachIn = rec.min < -2.8, reachOut = rec.max > 2.8;
  check("製程腔體 晶圓進片側與出片側都到達(貫通式行程)",
    reachIn && reachOut && rec.span <= 7.0,
    `進片側到 ${rec.min.toFixed(2)}、出片側到 ${rec.max.toFixed(2)}(設計 ±3.4)`
    + ` · 量到行程 ${rec.span.toFixed(3)}/6.8 · 頁內取樣 ${rec.n} 幀 ≈ ${(rec.n / 12).toFixed(1)} fps`
    + ` · throughput=${(tags.throughput ?? 0).toFixed(1)} wph`);
}

// ── 7. 停機語意:run_enable=0 → 機構靜止 ────────────────
console.log("\n[12] 停機語意 —— 教師停機(run_enable=0)時機構必須真的停下來");
{
  await page.goto(`${BASE}?device=cnc_machining_center&capture=slow`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.evaluate(() => window.__setFrame(40));
  await page.waitForTimeout(800);
  const a = await page.evaluate(() => window.__probes.tool_tip);
  await page.waitForTimeout(1200);
  const b = await page.evaluate(() => window.__probes.tool_tip);
  const moved = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  check("CNC running 時刀尖持續移動(動畫沒卡住)", moved > 0.005, `1.2 s 內位移 ${moved.toFixed(4)} 單位`);

  // 把 run_enable 關掉 → 機構應收斂到原點並停住
  await page.evaluate(() => window.__forceCoil({ run_enable: false }));
  await page.waitForTimeout(1500);
  const c = await page.evaluate(() => window.__probes.tool_tip);
  await page.waitForTimeout(1200);
  const d2 = await page.evaluate(() => window.__probes.tool_tip);
  const movedStopped = Math.hypot(d2.x - c.x, d2.y - c.y, d2.z - c.z);
  check("CNC run_enable=0 → 刀尖靜止", movedStopped < 0.002,
    `1.2 s 內位移 ${movedStopped.toFixed(5)} 單位(停機前為 ${moved.toFixed(4)})`);
}

// ── 13. 手臂末端:畫面夾爪位置 ↔ 引擎 tcp_x/y/z ───────────
// 第 [2] 節只驗各軸旋轉角。各軸角度全對、但連桿長度或零位校正錯了,夾爪還是會落在
// 錯的位置 —— 而引擎的 tcp_x/y/z 正好是標準答案。這一節把畫面的夾爪世界座標直接
// 拿去對引擎的末端座標,是整支手臂唯一的端到端驗證。
//
// 契約:引擎 mm ÷ 200 = 世界單位(骨架 SHOULDER_Y=2.0 對應 400mm),模型無外層縮放。
// 軸向:引擎 X(伸出)→ 世界 -X、引擎 Y(左)→ 世界 +Z、引擎 Z(高)→ 世界 +Y。
console.log("\n[13] 六軸手臂 · slow(×1)—— 夾爪世界座標 ↔ 引擎 tcp_x / tcp_y / tcp_z");
{
  const rows = (await sweep("robot_arm_6axis", "slow", { stride: 6, probes: ["tcp"] })).filter((r) => r.probes.tcp);
  const tcp = col(rows, (r) => r.probes.tcp);
  const S = 1 / 200;
  // 容許 20 mm:手臂最大伸距 1600 mm,20 mm 是 1.25%。實測最大 8 mm —— 腕段骨架
  // 1.41 對 fk 的 1.4 本身就有 2 mm,其餘是補間殘差。真的接錯軸會差到幾百 mm。
  checkLinear("手臂 tcp_x → 夾爪世界 X", col(rows, (r) => r.tags.tcp_x), col(tcp, (p) => p.x), -S, "mm",
              { minSpan: 100, maxErrAllowed: 20, minR2: 0.98 });
  checkLinear("手臂 tcp_y → 夾爪世界 Z", col(rows, (r) => r.tags.tcp_y), col(tcp, (p) => p.z), S, "mm",
              { minSpan: 100, maxErrAllowed: 20, minR2: 0.98 });
  checkLinear("手臂 tcp_z → 夾爪世界 Y(高度)", col(rows, (r) => r.tags.tcp_z), col(tcp, (p) => p.y), S, "mm",
              { minSpan: 100, maxErrAllowed: 20, minR2: 0.98 });

  // 方位角不變量:與連桿長度無關,單獨驗 J1 有沒有被畫反(引擎端同樣的檢查在
  // verify_scenario.py::check_kinematics)。世界 X 是引擎 X 的反向,故取負號。
  let worst = 0;
  rows.forEach((r, i) => {
    const shown = (Math.atan2(tcp[i].z, -tcp[i].x) * 180) / Math.PI;
    const d = Math.abs(((shown - r.tags.joint_angle_1) % 360 + 540) % 360 - 180);
    if (d > worst) worst = d;
  });
  check("手臂 畫面夾爪方位角 = joint_angle_1(基座軸沒畫反)", worst < 3.0,
    `最大偏差 ${worst.toFixed(2)}°`);

  // 下探落站:取整段裡 tcp_z 最低的一幀,畫面夾爪的水平位置必須落在取 / 放站上
  // (站座標 = setpoints ÷200;引擎 IK 保證下探時 TCP 在站上,所以這是端到端的
  // 「夾爪真的碰到料箱」驗證)。容許 0.15 單位(30 mm):腕段骨架與 fk 有 2 mm 內建差、
  // 幀是 0.25 s 量化(最低幀不一定剛好是 keyframe 底)、其餘是補間貼齊前的殘差;
  // 沒有貼齊(snap)之前這裡會差到視覺可辨的量級。
  {
    let low = 0;
    rows.forEach((r, i) => { if (r.tags.tcp_z < rows[low].tags.tcp_z) low = i; });
    const r = rows[low];
    const sp = await page.evaluate(() => window.__currentSetpoints());
    const stations = [
      [-(sp.pick_x ?? 820) / 200, (sp.pick_y ?? -820) / 200],
      [-(sp.place_x ?? 820) / 200, (sp.place_y ?? 820) / 200],
    ];
    const dist = Math.min(...stations.map(([sx, sz]) => Math.hypot(tcp[low].x - sx, tcp[low].z - sz)));
    check("手臂 下探最低幀夾爪水平落在取/放站上(< 0.15 單位 = 30 mm)",
      r.tags.tcp_z < 250 && dist < 0.15,
      `該幀 tcp_z=${r.tags.tcp_z.toFixed(0)} mm(下探設計 150)· 與最近站水平距離 ${dist.toFixed(3)} 單位`);
  }
}

// ── 14. 柱燈語彙:state → 哪一顆燈亮(契約 §2)────────────
// 這條先前完全靠人眼。柱燈是學生在產線俯瞰時判讀狀態的第一線索,判錯就全錯。
// 燈是會閃的,所以每種狀態都錄一段視窗取「峰值亮度」—— 單點取樣會剛好落在暗相。
console.log("\n[14] 柱燈語彙 —— state / run_enable → 三色燈(契約 §2)");
{
  await page.goto(`${BASE}?device=cnc_machining_center&capture=slow`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.evaluate(() => window.__setFrame(40));

  /** 錄 1.6 s(涵蓋快閃 9 rad/s 與慢閃 2.2 rad/s 各一個完整週期)取三顆燈的峰值。 */
  const peaks = async () => {
    await page.waitForTimeout(400);
    const [r, a, g] = await Promise.all([
      recordProbe("beacon_red", "emissive", 1600),
      recordProbe("beacon_amber", "emissive", 1600),
      recordProbe("beacon_green", "emissive", 1600),
    ]);
    return { red: r.max, amber: a.max, green: g.max };
  };
  const fmt = (p) => `紅 ${p.red.toFixed(2)} / 黃 ${p.amber.toFixed(2)} / 綠 ${p.green.toFixed(2)}`;
  const ON = 0.5;   // 上面每顆燈熄滅時是 0.04 × 2.0,亮起時 ≥1.6 —— 0.5 分得很開

  const run = await peaks();
  check("running → 只有綠燈亮", run.green > ON && run.red < ON && run.amber < ON, fmt(run));

  await page.evaluate(() => window.__forceState("fault"));
  const flt = await peaks();
  // 黃燈必須熄:故障必然伴隨 severity 拉滿,若不特別關掉,紅燈閃到暗相時
  // 整支柱燈讀起來就跟「警告」一樣。
  check("fault → 紅燈亮且黃燈熄(故障不可讀成警告)",
    flt.red > ON && flt.amber < ON && flt.green < ON, fmt(flt));

  await page.evaluate(() => window.__forceState(null));
  await page.evaluate(() => window.__forceCoil({ run_enable: false }));
  const stp = await peaks();
  check("run_enable=0(教師停機)→ 黃燈亮、綠燈熄",
    stp.amber > ON && stp.green < ON, fmt(stp));

  // 閃爍的暗相仍要看得出顏色 —— 否則截到暗相那一瞬間柱燈是全黑的
  await page.evaluate(() => window.__forceCoil(null));
  await page.evaluate(() => window.__forceState("fault"));
  await page.waitForTimeout(400);
  const dim = await recordProbe("beacon_red", "emissive", 1600);
  check("fault 紅燈閃爍的暗相仍可辨識(不會整支變黑)", dim.min > 0.5 && dim.max > dim.min * 1.5,
    `暗相 ${dim.min.toFixed(2)} / 亮相 ${dim.max.toFixed(2)}(暗相須 >0.5 且兩者要有明顯差,才看得出在閃)`);
  await page.evaluate(() => window.__forceState(null));
}

// ── 15. AGV 弧長鎖定:連續播放下車體不得離開巡迴路徑 ─────
// 其他節都是「換幀 → 等補間收斂 → 才讀值」,收斂**過程**沒被驗過 —— 舊的直線補間
// 正是在兩幀之間切過轉角(×120 下 aliasing 的位置跳點會讓補間直線穿過場地中央),
// settle 之後什麼都看不到。這一節連續換幀、全程不等收斂,頁內 rAF 全速量
// 「車體到路徑折線的距離」,補間走的每一步都得在路上。
console.log("\n[15] AGV · fast(×120)—— 連續播放(不等收斂):車體恆在巡迴路徑上");
{
  await page.goto(`${BASE}?device=agv_mobile_robot&capture=fast`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  await page.evaluate(() => window.__setFrame(0));
  await page.waitForTimeout(700);                     // 初始硬同步收斂
  const n = await page.evaluate(() => window.__frameCount);
  const STEP_MS = 260;
  // 先在頁內啟動記錄器(promise 掛著),Node 端再連續換幀;兩者並行。
  const recP = page.evaluate(([loop, dur]) => new Promise((resolve) => {
    const segDist = (px, pz, a, b) => {
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
    };
    let worst = 0, count = 0;
    const t0 = performance.now();
    (function tick() {
      const p = window.__probes?.agv_body;
      if (p) {
        let best = Infinity;
        for (let i = 0; i < 4; i++) best = Math.min(best, segDist(p.x, p.z, loop[i], loop[(i + 1) % 4]));
        if (best > worst) worst = best;
        count += 1;
      }
      if (performance.now() - t0 < dur) requestAnimationFrame(tick);
      else resolve({ worst, count });
    })();
  }), [[[2, 2], [18, 2], [18, 12], [2, 12]], n * STEP_MS + 600]);
  for (let i = 0; i < n; i++) {
    await page.evaluate((k) => window.__setFrame(k), i);
    await page.waitForTimeout(STEP_MS);
  }
  const rec = await recP;
  // 容許 0.05 m:弧長鎖定下車體恆在折線上,0.05 只是浮點與投影餘裕;
  // 直線補間在 aliasing 的跳點間切對角線,離路徑可達數公尺 —— 兩者分得極開。
  check("AGV 連續換幀時車體與路徑最大距離 < 0.05 m", rec.worst < 0.05,
    `max ${rec.worst.toFixed(3)} m · 全程頁內取樣 ${rec.count} 幀 · ${n} 幀連續播放`);
}

// ── 16~19. 新產業四機種 · slow(×1)—— L1 位置回歸(2026-08)──
// 這四台的模型都沒有外層縮放:引擎 mm ÷ 50 = 世界單位 → 契約斜率 0.02。
console.log("\n[16] AOI 光學檢測站 · slow(×1)—— 相機頭世界座標 ↔ camera_pos_x / camera_pos_y");
{
  const rows = (await sweep("aoi_inspection", "slow", { stride: 6, probes: ["aoi_camera"] })).filter((r) => r.probes.aoi_camera);
  const cam = col(rows, (r) => r.probes.aoi_camera);
  // 容許 8 mm:蛇形行程 ±150 mm,8 mm 是 2.7%(與 CNC 同一標準的量級)
  checkLinear("AOI camera_pos_x → 相機世界 X", col(rows, (r) => r.tags.camera_pos_x), col(cam, (p) => p.x), 0.02, "mm",
              { minSpan: 80, maxErrAllowed: 8, minR2: 0.99 });
  checkLinear("AOI camera_pos_y → 相機世界 Z", col(rows, (r) => r.tags.camera_pos_y), col(cam, (p) => p.z), 0.02, "mm",
              { minSpan: 40, maxErrAllowed: 8, minR2: 0.98 });
  const cross = linreg(col(rows, (r) => r.tags.camera_pos_x), col(cam, (p) => p.z));
  check("AOI 軸向未對調(camera_pos_x 不影響世界 Z)", cross.r2 < 0.5, `交叉 R²=${cross.r2.toFixed(4)}(應遠小於 1)`);
}

console.log("\n[17] 焊接工作站 · slow(×1)—— 焊槍世界座標 ↔ torch_pos_x / torch_pos_y");
{
  const rows = (await sweep("welding_cell", "slow", { stride: 6, probes: ["torch"] })).filter((r) => r.probes.torch);
  const torch = col(rows, (r) => r.probes.torch);
  checkLinear("焊接 torch_pos_x → 焊槍世界 X", col(rows, (r) => r.tags.torch_pos_x), col(torch, (p) => p.x), 0.02, "mm",
              { minSpan: 100, maxErrAllowed: 10, minR2: 0.99 });
  // torch_pos_y 是二元訊號(±60 奇偶道交替),與 CNC pos_z 同款判 rms
  checkLinear("焊接 torch_pos_y → 焊槍世界 Z(道別)", col(rows, (r) => r.tags.torch_pos_y), col(torch, (p) => p.z), 0.02, "mm",
              { minSpan: 60, rmsAllowed: 8 });
  // 弧開弧關必須跟著 arc_current(>100 A),不是自己猜相位 —— 抽最後一幀直接讀弧光球
  const arcAgree = rows.filter((r) => {
    const on = r.tags.arc_current > 100;
    return on === (r.tags.wire_feed_rate > 3);   // 引擎不變量:送絲與電弧同開關(畫面判準同一條)
  }).length;
  check("焊接 電弧判準與引擎一致(arc_current↔wire_feed 同開關)", arcAgree === rows.length,
    `${arcAgree}/${rows.length} 幀一致`);
}

console.log("\n[18] 雷射切割機 · slow(×1)—— 切割頭世界座標 ↔ head_pos_x / head_pos_y");
{
  const rows = (await sweep("laser_cutter", "slow", { stride: 6, probes: ["laser_head"] })).filter((r) => r.probes.laser_head);
  const head = col(rows, (r) => r.probes.laser_head);
  checkLinear("雷切 head_pos_x → 切割頭世界 X", col(rows, (r) => r.tags.head_pos_x), col(head, (p) => p.x), 0.02, "mm",
              { minSpan: 80, maxErrAllowed: 10, minR2: 0.98 });
  checkLinear("雷切 head_pos_y → 切割頭世界 Z", col(rows, (r) => r.tags.head_pos_y), col(head, (p) => p.z), 0.02, "mm",
              { minSpan: 60, maxErrAllowed: 10, minR2: 0.98 });
  const cross = linreg(col(rows, (r) => r.tags.head_pos_x), col(head, (p) => p.z));
  check("雷切 軸向未對調(head_pos_x 不影響世界 Z)", cross.r2 < 0.5, `交叉 R²=${cross.r2.toFixed(4)}(應遠小於 1)`);
}

console.log("\n[19] 包裝機 · slow(×1)—— 上封口鉗世界高度 ↔ jaw_gap");
{
  const rows = (await sweep("packaging_machine", "slow", { stride: 4, probes: ["jaw"] })).filter((r) => r.probes.jaw);
  // 上鉗 y = JAW_MID + (jaw_gap/80)·0.8 → 斜率 0.8/80 = 0.01
  checkLinear("包裝 jaw_gap → 上鉗世界 Y", col(rows, (r) => r.tags.jaw_gap), col(rows, (r) => r.probes.jaw.y), 0.01, "mm",
              { minSpan: 40, maxErrAllowed: 6, minR2: 0.98 });
}

console.log("\n[20] 熔煉爐 · slow(×1)—— 爐口世界位置 ↔ tilt_angle");
{
  const rows = (await sweep("melting_furnace", "slow", { stride: 4, probes: ["furnace_lip"] }))
    .filter((r) => r.probes.furnace_lip);
  // 爐體繞 Z 傾轉 θ:爐口(局部 [-2.2, 1.0])的世界 Y = 2.4 + (-2.2·sinθ + 1.0·cosθ)。
  // 這條關係**不是**對 sinθ 的一次式(cosθ 也在動),所以不用線性回歸判 ——
  // 直接拿引擎的 tilt_angle 代進旋轉公式重建應有位置,比對探針實測值。
  // 這比回歸更嚴:接錯軸、換算比例錯、符號反,重建誤差都會直接爆掉。
  const dev = rows.map((r) => {
    const th = (r.tags.tilt_angle * Math.PI) / 180;
    return Math.abs(r.probes.furnace_lip.y - (2.4 - 2.2 * Math.sin(th) + 1.0 * Math.cos(th)));
  });
  const maxDev = Math.max(...dev);
  const span = Math.max(...col(rows, (r) => r.tags.tilt_angle)) - Math.min(...col(rows, (r) => r.tags.tilt_angle));
  // 容許 0.12 模型單位:補間平滑(契約 §3 的 delta-based approach)必然留一點落後,
  // 但接錯軸的量級是「整個爐口跑掉幾個單位」,兩者差一個數量級。
  check("熔煉 tilt_angle → 爐口世界位置(旋轉公式重建)", maxDev <= 0.12 && span > 20,
        `重建誤差 max ${maxDev.toFixed(4)} 模型單位(容許 ≤0.12)· tilt 變動 ${span.toFixed(1)}°`);
}

console.log("\n[21] 壓鑄機 · slow(×1)—— 移動模板世界 X ↔ clamping_force");
{
  const rows = (await sweep("die_casting_machine", "slow", { stride: 4, probes: ["moving_platen"] }))
    .filter((r) => r.probes.moving_platen);
  // 開度 = 1 − clamp01(力/(350×0.9)),模板 x = -1.6 − 開度×420/50。
  // clamp01 會在鎖模段**飽和**(力 ≥ 315 ton 後開度恆為 0),所以整段用線性回歸判
  // 會被飽和區拉平斜率 —— 一樣改成用契約公式重建應有位置再比對。
  const dev = rows.map((r) => {
    const open = 1 - Math.min(1, Math.max(0, r.tags.clamping_force / (350 * 0.9)));
    return Math.abs(r.probes.moving_platen.x - (-1.6 - open * 8.4));
  });
  const maxDev = Math.max(...dev);
  const span = Math.max(...col(rows, (r) => r.tags.clamping_force)) - Math.min(...col(rows, (r) => r.tags.clamping_force));
  check("壓鑄 clamping_force → 移動模板世界 X(契約公式重建)", maxDev <= 0.45 && span > 100,
        `重建誤差 max ${maxDev.toFixed(4)} 模型單位(容許 ≤0.45)· 鎖模力變動 ${span.toFixed(0)} ton`);
}

console.log("\n[22] 鍛造壓機 · slow(×1)—— 上模世界高度 ↔ ram_position");
{
  const rows = (await sweep("forging_press", "slow", { stride: 4, probes: ["ram"] }))
    .filter((r) => r.probes.ram);
  // 上模 y = 5.2 + ram_position/50 − 1.4 → 斜率 1/50 = 0.02
  checkLinear("鍛造 ram_position → 上模世界 Y", col(rows, (r) => r.tags.ram_position),
              col(rows, (r) => r.probes.ram.y), 0.02, "mm",
              { minSpan: 60, maxErrAllowed: 8, minR2: 0.98 });
}

console.log("\n[23] 毛胚整修機 · slow(×1)—— 刀口世界高度 ↔ slide_position");
{
  const rows = (await sweep("trimming_press", "slow", { stride: 4, probes: ["slide"] }))
    .filter((r) => r.probes.slide);
  checkLinear("切邊 slide_position → 刀口世界 Y", col(rows, (r) => r.tags.slide_position),
              col(rows, (r) => r.probes.slide.y), 0.02, "mm",
              { minSpan: 40, maxErrAllowed: 6, minR2: 0.98 });
}

console.log("\n[24] 感應加熱爐 · 出料棒料色溫 ↔ billet_temp_out(L1 對應,非位置)");
{
  // 這台的位置是本地重建(L3,引擎沒有位置 tag),所以驗的是**顏色**這條 L1 綁定:
  // 出料端棒料的自發光強度必須跟著引擎的 billet_temp_out 走,不能是憑感覺調的。
  const rows = (await sweep("induction_heater", "slow", { stride: 4, probes: ["billet_exit"] }))
    .filter((r) => r.probes.billet_exit);
  check("感應加熱 出料探針存在且不隨機漂移",
        rows.length > 5 && rows.every((r) => Math.abs(r.probes.billet_exit.x - rows[0].probes.billet_exit.x) < 1e-6),
        `${rows.length} 幀,出料端座標固定(棒料在動、量測點不動)`);
}

console.log(`\npage errors: ${pageErrors.length ? [...new Set(pageErrors)].join(" | ") : "none"}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n總計 ${results.length} 項,通過 ${results.length - failed.length},失敗 ${failed.length}`);
if (failed.length) {
  console.log("失敗項目:");
  for (const f of failed) console.log(`  - ${f.name}\n      ${f.detail}`);
}
await browser.close();
process.exit(failed.length ? 1 : 0);
