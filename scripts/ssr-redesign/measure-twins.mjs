#!/usr/bin/env node
// The real HackerNews twins, as built and served by their own examples:
//   examples/hackernews-spa  SSR + full hydration (the conventional baseline)
//   examples/hackernews      Solid Server Components over frame streams
// on the 1,406-comment story (/stories/30186326). Build them first
// (`pnpm build` in each example). For each: page anatomy, every JS file the
// page loads (by origin: framework vs app), and Chromium timings (ready when
// hydration is done, total script time, heap, first toggle click).
//
//   node scripts/ssr-redesign/measure-twins.mjs [--reps 7] [--cpu 1,4] [--out file]
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { anatomy, gz, kb, launchChromium, median, ROOT } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const REPS = Number(opt("reps", 7));
const CPUS = String(opt("cpu", "1,4")).split(",").map(Number);
const PATH = "/stories/30186326";
const TWINS = { "hackernews-spa": 3205, hackernews: 3204 };

const browser = await launchChromium();
const out = { chromium: browser.version(), reps: REPS, twins: {} };
for (const [twin, port] of Object.entries(TWINS)) {
  const srv = spawn(process.execPath, ["server.js"], { cwd: join(ROOT, "examples", twin), env: { ...process.env, PORT: String(port) }, stdio: "ignore" });
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(base + "/");
      break;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  try {
    const html = await (await fetch(base + PATH, { headers: { "accept-encoding": "identity" } })).text();
    const r = (out.twins[twin] = { html: anatomy(html) });
    // JS the page loads, observed in the browser.
    const js = new Map();
    {
      const page = await (await browser.newContext()).newPage();
      page.on("response", async res => {
        if (res.request().resourceType() === "script" || res.url().endsWith(".js")) js.set(res.url(), null);
      });
      await page.goto(base + PATH, { waitUntil: "networkidle" });
      await page.context().close();
    }
    let total = 0;
    const files = [];
    for (const url of js.keys()) {
      const body = await (await fetch(url, { headers: { "accept-encoding": "identity" } })).text();
      files.push({ file: url.replace(base, ""), bytes: Buffer.byteLength(body), gzip: gz(body) });
      total += gz(body);
    }
    r.js = { gzip: total, files };
    console.log(`${twin.padEnd(15)} HTML ${kb(r.html.gzip)} KB gz (data ${kb(r.html.data.gzip)}, _hk ${kb(r.html.hk.gzip)}, raw ${kb(r.html.bytes)} KB) | JS ${kb(total)} KB gz in ${files.length} files`);
    for (const f of files) console.log(`    ${f.file.padEnd(60)} ${kb(f.gzip)} KB gz`);
    r.timing = {};
    for (const cpu of CPUS) {
      const s = [];
      for (let i = 0; i < REPS; i++) s.push(await timed(base + PATH, cpu));
      const pick = k => median(s.map(x => x[k]).filter(v => !Number.isNaN(v)));
      const dead = s.filter(x => Number.isNaN(x.firstMs) && !x.noThread).length;
      const noThread = s.filter(x => x.noThread).length;
      r.timing[cpu] = { hydratedAt: pick("hydratedAt"), scriptMs: pick("scriptMs"), heapKB: pick("heapKB"), firstMs: pick("firstMs"), deadLoads: dead, loadsWithoutThread: noThread };
      const t = r.timing[cpu];
      console.log(`  cpu ${cpu}x: hydrated at ${t.hydratedAt.toFixed(0)} ms | script ${t.scriptMs.toFixed(1)} ms | heap ${t.heapKB.toFixed(0)} KB | first toggle ${t.firstMs.toFixed(1)} ms | dead toggles ${dead}/${REPS} | no thread ${noThread}/${REPS}`);
    }
  } finally {
    srv.kill();
  }
}
await browser.close();
if (opt("out")) writeFileSync(opt("out"), JSON.stringify(out, null, 2) + "\n");

async function timed(url, cpu) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
  const m0 = await metric();
  await page.goto(url, { waitUntil: "load" });
  // Hydration is done when the runtime says so (`_$HY.done`) and a toggle is
  // interactive; poll with rAF.
  const hydratedAt = await page.evaluate(
    () =>
      new Promise(res => {
        const check = () => (globalThis._$HY && globalThis._$HY.done ? res(performance.now()) : requestAnimationFrame(check));
        check();
        setTimeout(() => res(NaN), 20000);
      })
  );
  await page.waitForLoadState("networkidle");
  const m1 = await metric();
  // The server-components twin streams the thread after the shell: wait for
  // the toggles to exist. A click that has not toggled within 3 s counts as
  // a dead page (NaN): see the doc's note on the SPA twin at 4x CPU.
  const rendered = await page
    .waitForFunction(() => document.querySelectorAll(".toggle a").length > 3, null, { timeout: 15000 })
    .then(
      () => true,
      () => false
    );
  if (!rendered) {
    const state = await page.evaluate(() => ({ comments: document.querySelectorAll("li.comment").length, text: document.body.innerText.slice(0, 120) }));
    console.log(`    load without a rendered thread: ${JSON.stringify(state)}`);
    await context.close();
    return { hydratedAt, scriptMs: (m1.ScriptDuration - (m0.ScriptDuration || 0)) * 1000, heapKB: m1.JSHeapUsedSize / 1024, firstMs: NaN, noThread: true };
  }
  const firstMs = await page.evaluate(async () => {
    const a = document.querySelectorAll(".toggle a")[3];
    const root = a.parentElement;
    const t = performance.now();
    a.click();
    while (root.classList.contains("open")) {
      if (performance.now() - t > 3000) return NaN;
      await new Promise(r => setTimeout(r, 0));
    }
    return performance.now() - t;
  });
  await context.close();
  return { hydratedAt, scriptMs: (m1.ScriptDuration - (m0.ScriptDuration || 0)) * 1000, heapKB: m1.JSHeapUsedSize / 1024, firstMs };
}
