#!/usr/bin/env node
// SSR / hydration redesign: current-state and prototype measurements
// (documentation/plans/ssr-hydration-redesign.md).
//
// For each app and variant:
//   1. server-render the page (real compiler SSR output, real server runtime);
//   2. bundle the client (real compiler DOM output, prod dists, esbuild minify);
//   3. gate: in Chromium, the page after load and after a scripted session
//      must equal variant A's (normalized: hydration keys, hole markers and
//      island anchors removed), and server nodes must survive (identity);
//   4. count hydration work (instrumented build: computations, recomputes,
//      signals, owners, template claims, trace re-runs of serialized computes);
//   5. time it (uninstrumented build, fresh browser context per rep, CPU
//      throttle 1x and 4x): ready time from navigation start, hydrate() time,
//      total script time (CDP ScriptDuration), heap, first interaction.
//
//   node scripts/ssr-redesign/measure.mjs [--apps hn,todos] [--only A,P1-lazy] [--reps 7] [--cpu 1,4] [--out file] [--check]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anatomy, bundleClient, HERE, islandsCompiler, kb, launchChromium, loadServer, median, ROOT } from "./lib.mjs";
import { APPS } from "./apps.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map(p => {
      const [k, ...v] = p.trim().split(/\s+/);
      return [k, v.join(" ") || "true"];
    })
);
const REPS = Number(args.reps ?? 7);
const CPUS = String(args.cpu ?? "1,4").split(",").map(Number);
const appNames = String(args.apps ?? Object.keys(APPS).join(",")).split(",");
const only = args.only ? new Set(String(args.only).split(",")) : null;
const cache = join(ROOT, "node_modules/.cache/ssr-redesign");
mkdirSync(cache, { recursive: true });

const browser = await launchChromium();
const out = { chromium: browser.version(), reps: REPS, cpus: CPUS, apps: {} };

const normalize = html =>
  html
    .replace(/ _hk="[^"]*"/g, "")
    .replace(/<!--(\$|\/|!\$)-->/g, "")
    .replace(/<\/?solid-island[^>]*>/g, "")
    .replace(/ data-i="[^"]*"/g, "")
    .replace(/ data-s="[^"]*"/g, "")
    .replace(/ data-pd(="")?/g, "")
    .replace(/ checked(="")?(?=[ >])/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");

for (const name of appNames) {
  const app = APPS[name];
  const res = (out.apps[name] = { variants: {} });
  console.log(`\n=== ${name}`);
  let reference = null;
  for (const [vname, v] of Object.entries(app.variants)) {
    if (only && !only.has(vname) && vname !== "A") continue;
    // Compiled islands (`v.islands`): one compiler shared by both builds.
    let islands;
    if (v.islands) {
      const compiler = islandsCompiler({ minTier: v.islands.minTier, tier1Core: v.islands.tier1Core });
      const root = join(HERE, v.islands.root);
      const collected = compiler.collect(root);
      islands = { compiler, root, mode: v.islands.mode, prefetch: v.islands.prefetch, files: new Set(collected.files) };
      const tiers = collected.islands.map(i => `${i.id}:${i.root}@t${i.tier}`).join(" ");
      console.log(`  islands: ${tiers || "(none)"}${collected.fallbacks.length ? " FALLBACK " + collected.fallbacks.map(f => f.reason).join("; ") : ""}`);
    }
    const srv = await loadServer(join(HERE, v.server), join(cache, `${name}-${vname}-server.mjs`), {
      swaps: v.serverSwaps,
      tildeRoot: app.tildeRoot,
      rewrites: v.serverRewrites,
      islands
    });
    // Server render: one warm-up, then the median of 5 (wall and CPU; the
    // todos mock API sleeps 400 ms, so CPU is the comparable number there).
    const html = await app.render(srv);
    const wall = [],
      cpu = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now(),
        c0 = process.cpuUsage();
      await app.render(srv);
      const c = process.cpuUsage(c0);
      wall.push(performance.now() - t0);
      cpu.push((c.user + c.system) / 1000);
    }
    const ssrMs = median(wall),
      ssrCpuMs = median(cpu);
    const head = srv.hydrationScript ? srv.hydrationScript() : "";
    const opts = { swaps: v.clientSwaps, tildeRoot: app.tildeRoot, rewrites: v.rewrites, oracles: v.oracles || [], splitting: !!v.splitting, hydratable: v.hydratable ?? true, aliases: v.aliases, islands };
    const client = await bundleClient(join(HERE, v.client), opts);
    const counted = await bundleClient(join(HERE, v.client), { ...opts, count: true });
    // The identity probe is a classic script: it runs while the page parses,
    // before the module hydrates, so it captures the server's own nodes. It
    // is excluded from the byte anatomy.
    const probe = app.markIdentity ? `<script>(${app.markIdentity.toString()})()</script>` : "";
    const body = v.page ? v.page(html) : `<div id="root">${html}</div>`;
    const page = (files, withProbe = true) =>
      `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}${withProbe ? probe : ""}<script type="module" src="/${files.entry}"></script></body></html>`;
    const pageHtml = page(client);
    const r = (res.variants[vname] = {
      ssrMs,
      ssrCpuMs,
      html: anatomy(page(client, false)),
      js: { bytes: client.bytes, gzip: client.gzip, groups: client.groups, lazy: client.lazy }
    });

    if (v.bytesOnly) {
      console.log(`${vname.padEnd(10)} JS ${kb(r.js.gzip)} KB gz ${JSON.stringify(r.js.groups)} (bytes only)`);
      continue;
    }
    // --- gate + counts (instrumented build) ---
    const gate = await runSession(page(counted), counted.files, app, { count: true });
    r.counts = gate.counts;
    r.countsAfterSession = gate.after;
    r.gate = { load: gate.load, steps: gate.steps.length, identity: gate.identity };
    if (vname === "A") reference = gate;
    else if (v.reference) r.gate.equalToA = "reference (not gated)";
    else {
      const eq = normalize(gate.load) === normalize(reference.load);
      const stepsEq = gate.steps.every((s, i) => normalize(s) === normalize(reference.steps[i]));
      r.gate.equalToA = eq && stepsEq;
      if (!eq || !stepsEq) {
        const a = normalize(eq ? reference.steps.find((s, i) => normalize(s) !== normalize(gate.steps[i])) : reference.load);
        const b = normalize(eq ? gate.steps.find((s, i) => normalize(s) !== normalize(reference.steps[i])) : gate.load);
        let i = 0;
        while (a[i] === b[i]) i++;
        const k = eq ? gate.steps.findIndex((s, j) => normalize(s) !== normalize(reference.steps[j])) : -1;
        console.log(`  GATE FAIL ${vname} ${k < 0 ? "after load" : `after step ${k}`} at ${i}:\n    A: ${a.slice(Math.max(0, i - 80), i + 120)}\n    ${vname}: ${b.slice(Math.max(0, i - 80), i + 120)}`);
      }
    }
    r.gate.load = undefined;
    console.log(
      `${vname.padEnd(10)} HTML ${kb(r.html.gzip)} KB gz (data ${kb(r.html.data.gzip)}, _hk ${kb(r.html.hk.gzip)}) | JS ${kb(r.js.gzip)} KB gz` +
        (client.lazy.names.length ? ` + lazy ${kb(client.lazy.gzip)}` : "") +
        ` | ssr ${ssrMs.toFixed(1)} ms (cpu ${ssrCpuMs.toFixed(1)}) | counts ${JSON.stringify(gate.counts)} | gate ${vname === "A" || v.reference ? "ref" : r.gate.equalToA ? "ok" : "FAIL"} identity ${gate.identity}` +
        `\n           after session ${JSON.stringify(gate.after)}`
    );
    if (args.check) continue;

    // --- timing (uninstrumented build) ---
    r.timing = {};
    for (const cpu of CPUS) {
      const samples = [];
      for (let i = 0; i < REPS; i++) samples.push(await runTimed(pageHtml, client.files, app, cpu));
      const pick = k => median(samples.map(s => s[k]));
      r.timing[cpu] = { readyAt: pick("readyAt"), hydrateMs: pick("hydrateMs"), scriptMs: pick("scriptMs"), heapKB: pick("heapKB"), firstMs: pick("firstMs"), scriptTotalMs: pick("scriptTotalMs") };
      const t = r.timing[cpu];
      console.log(
        `  cpu ${cpu}x: ready ${t.readyAt.toFixed(1)} ms | hydrate ${t.hydrateMs.toFixed(1)} ms | script ${t.scriptMs.toFixed(1)} ms | heap ${t.heapKB.toFixed(0)} KB | first interaction ${t.firstMs.toFixed(1)} ms | script through first ${t.scriptTotalMs.toFixed(1)} ms`
      );
    }
  }
}
await browser.close();
if (args.out) writeFileSync(args.out, JSON.stringify(out, null, 2) + "\n");

async function openPage(pageHtml, files, app) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route("http://bench.local/**", route => {
    const path = new URL(route.request().url()).pathname.slice(1);
    if (!path) return route.fulfill({ contentType: "text/html", body: pageHtml });
    if (files[path]) return route.fulfill({ contentType: "application/javascript", body: files[path] });
    return route.fulfill({ status: 404, body: "" });
  });
  if (app.init) await page.addInitScript(app.init);
  return { context, page };
}

async function settle(page) {
  await page.waitForFunction(() => globalThis.__readyAt !== undefined, null, { timeout: 30000 }).catch(() => {});
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
}

async function runSession(pageHtml, files, app) {
  const { context, page } = await openPage(pageHtml, files, app);
  page.on("pageerror", e => console.log("  pageerror:", e.message));
  await page.goto("http://bench.local/");
  await settle(page);
  // Server nodes captured during parsing must be the live nodes after load.
  const identity = app.checkIdentity ? await page.evaluate(app.checkIdentity) : "n/a";
  // The page's markup, and form controls' live state (a \`checked\` property
  // set by script and a server \`checked\` attribute are the same state).
  const load = await page.evaluate(() => { const r = document.getElementById("root"); return r.innerHTML + "\n[checked " + [...r.querySelectorAll("input")].map(i => (i.checked ? 1 : 0)).join("") + "]"; });
  const counts = await page.evaluate(() => ({ ...(globalThis.__c || {}) }));
  if (counts.gatherMs !== undefined) counts.gatherMs = +counts.gatherMs.toFixed(2);
  const steps = [];
  for (const step of app.session) {
    await page.evaluate(step);
    await page.waitForTimeout(app.stepWait ?? 50);
    steps.push(await page.evaluate(() => { const r = document.getElementById("root"); return r.innerHTML + "\n[checked " + [...r.querySelectorAll("input")].map(i => (i.checked ? 1 : 0)).join("") + "]"; }));
  }
  const after = await page.evaluate(() => ({ ...(globalThis.__c || {}) }));
  delete after.gatherMs;
  await context.close();
  return { load, steps, counts, after, identity };
}

async function runTimed(pageHtml, files, app, cpu) {
  const { context, page } = await openPage(pageHtml, files, app);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  if (cpu > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
  const metric = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
  const m0 = await metric();
  await page.goto("http://bench.local/");
  await settle(page);
  const m1 = await metric();
  const t = await page.evaluate(() => ({ readyAt: globalThis.__readyAt, hydrateMs: globalThis.__hydrateMs ?? 0 }));
  const firstMs = app.firstInteraction ? await page.evaluate(app.firstInteraction) : 0;
  const m2 = await metric();
  await context.close();
  return {
    readyAt: t.readyAt,
    hydrateMs: t.hydrateMs,
    scriptMs: (m1.ScriptDuration - (m0.ScriptDuration || 0)) * 1000,
    heapKB: m1.JSHeapUsedSize / 1024,
    firstMs,
    scriptTotalMs: (m2.ScriptDuration - (m0.ScriptDuration || 0)) * 1000
  };
}
