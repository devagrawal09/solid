// Hydration startup CPU for optimization slice 7 (capability-selected
// hydration runtime), measured in Chromium.
//
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   CHROMIUM=/opt/pw-browsers/chromium \
//   node scripts/hydration-capabilities/measure-startup.mjs [--runs 30] [--json out.json]
//
// playwright-core is deliberately not a workspace dependency (see
// scripts/size/README.md for why tooling stays out of the pnpm graph):
// install it anywhere and point PLAYWRIGHT_CORE at it.
//
// For each fixture graph, the server-rendered artifact from
// packages/web/test/harness/__capability_artifacts__ (all chunks applied,
// i.e. a fully loaded document) is served with the client bundle INLINED
// (a fresh page per load: no HTTP cache, no V8 code cache). Variants:
//   universal   hydrate() from "@solidjs/web"
//   universal2  the identical universal bundle again (A/A: the noise floor)
//   selected    hydrate() from the entry composed from the graph's manifest
//   baseline    (with BASELINE_DIST=<dir of pre-change solid/ web/ signals/
//               dists, each with a sideEffects:false package.json>) the
//               universal hydrate() before the slice-7 refactor
// Loads are interleaved in a seeded shuffled order. Per load:
//   evalMs     script start -> just before hydrate() (parse/compile/module init)
//   hydrateMs  the synchronous hydrate() call
//   settleMs   hydrate() start -> hydration end (sharedConfig.onHydrationEnd)
// Each at 1x and 4x CPU throttling (CDP Emulation.setCPUThrottlingRate).
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPS,
  APPS_DIR,
  ARTIFACT_DIR,
  bundle,
  distAlias,
  loadManifestTools,
  readManifest
} from "./bundle.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const RUNS = Number(arg("--runs", 30));
const THROTTLES = [1, 4];
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const { composeHydrationEntry, assertHydrationManifest } = await loadManifestTools();
const workDir = mkdtempSync(join(tmpdir(), "solid-slice7-startup-"));

function instrumentedEntry(app, hydrateFrom) {
  const lazyPage = JSON.stringify(join(APPS_DIR, "lazy-page.tsx"));
  return `
import { hydrate } from ${JSON.stringify(hydrateFrom)};
import { createComponent, sharedConfig } from "solid-js";
import App from ${JSON.stringify(join(APPS_DIR, `${app}.tsx`))};
import * as lazyPage from ${lazyPage};
// A real client would import the mapped chunk; the module is already in the
// bundle, so preload it the way a finished import would (same for every variant).
const hy = window._$HY;
for (const k in hy.r)
  if (k.endsWith("_assets")) {
    hy.modules ||= {};
    for (const m in hy.r[k]) hy.modules[m] = lazyPage;
  }
const t1 = performance.now();
hydrate(() => createComponent(App, {}), document.getElementById("root"));
const t2 = performance.now();
const end = () => {
  window.__result = { t0: window.__t0, t1, t2, t3: performance.now(),
    text: document.getElementById("root").textContent };
};
sharedConfig.onHydrationEnd ? sharedConfig.onHydrationEnd(end) : queueMicrotask(end);
`;
}

function page(app, code) {
  const { shell, rest } = JSON.parse(readFileSync(join(ARTIFACT_DIR, `${app}.json`), "utf-8"));
  // `</script` cannot appear inside an inline script; the minified bundle
  // only contains it inside string literals, where `<\/` is equivalent.
  const inline = code.replaceAll("</script", "<\\/script");
  return (
    `<!doctype html><html><head><meta charset="utf-8"></head><body>` +
    `<div id="root">${shell}${rest}</div>` +
    `<script>window.__t0=performance.now()</script>` +
    `<script>${inline}</script></body></html>`
  );
}

// Deterministic shuffle (mulberry32).
function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (list, rand) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const stats = xs => {
  const s = [...xs].sort((a, b) => a - b);
  const q = p => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { median: q(0.5), p25: q(0.25), p75: q(0.75), min: s[0], n: s.length };
};

const results = { runs: RUNS, chromium: null, apps: {} };
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/opt/pw-browsers/chromium",
  args: ["--disable-gpu"]
});
results.chromium = browser.version();
try {
  for (const app of APPS) {
    const manifest = assertHydrationManifest(readManifest(app));
    const entryPath = join(workDir, `${app}.hydration-entry.js`);
    writeFileSync(entryPath, composeHydrationEntry(manifest));
    const universal = await bundle(instrumentedEntry(app, "@solidjs/web"), {
      format: "iife",
      workDir
    });
    const selected = await bundle(instrumentedEntry(app, entryPath), { format: "iife", workDir });
    const variants = {
      universal: page(app, universal.code),
      universal2: page(app, universal.code),
      selected: page(app, selected.code)
    };
    if (process.env.BASELINE_DIST) {
      const baseline = await bundle(instrumentedEntry(app, "@solidjs/web"), {
        format: "iife",
        workDir,
        alias: distAlias(process.env.BASELINE_DIST)
      });
      variants.baseline = page(app, baseline.code);
    }
    results.apps[app] = {};
    for (const throttle of THROTTLES) {
      const samples = {};
      const texts = {};
      for (const v of Object.keys(variants))
        samples[v] = { evalMs: [], hydrateMs: [], settleMs: [] };
      const rand = rng(0x5eed + throttle);
      const context = await browser.newContext();
      // Warm the browser process (first page pays process/JIT startup).
      for (const html of Object.values(variants)) {
        const warm = await context.newPage();
        await warm.setContent(html);
        await warm.waitForFunction(() => window.__result);
        await warm.close();
      }
      for (let run = 0; run < RUNS; run++) {
        for (const v of shuffle(Object.keys(variants), rand)) {
          const p = await context.newPage();
          const cdp = await context.newCDPSession(p);
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
          await p.setContent(variants[v]);
          const r = await p.waitForFunction(() => window.__result).then(h => h.jsonValue());
          samples[v].evalMs.push(r.t1 - r.t0);
          samples[v].hydrateMs.push(r.t2 - r.t1);
          samples[v].settleMs.push(r.t3 - r.t1);
          texts[v] ??= r.text;
          await cdp.detach();
          await p.close();
        }
      }
      await context.close();
      if (texts.selected !== texts.universal)
        throw new Error(`${app}: selected hydrated to different text than universal`);
      results.apps[app][`${throttle}x`] = Object.fromEntries(
        Object.entries(samples).map(([v, m]) => [
          v,
          Object.fromEntries(Object.entries(m).map(([k, xs]) => [k, stats(xs)]))
        ])
      );
      results.apps[app][`${throttle}x`].raw = samples;
      process.stderr.write(`${app} ${throttle}x done\n`);
    }
  }
} finally {
  await browser.close();
  rmSync(workDir, { recursive: true, force: true });
}

const f = n => n.toFixed(3);
console.log(`Chromium ${results.chromium}, ${RUNS} interleaved loads per variant\n`);
for (const throttle of THROTTLES) {
  console.log(`### ${throttle}x CPU throttling — medians in ms [p25–p75]\n`);
  console.log(
    "| graph | metric | universal | universal (A/A copy) | selected | Δ selected−universal | Δ A/A | pre-change universal | Δ universal−pre-change |"
  );
  console.log("|---|---|---|---|---|---|---|---|---|");
  for (const [app, byThrottle] of Object.entries(results.apps)) {
    const r = byThrottle[`${throttle}x`];
    for (const metric of ["evalMs", "hydrateMs", "settleMs"]) {
      const cell = s => `${f(s.median)} [${f(s.p25)}–${f(s.p75)}]`;
      const u = r.universal[metric],
        u2 = r.universal2[metric],
        s = r.selected[metric];
      console.log(
        `| ${app} | ${metric} | ${cell(u)} | ${cell(u2)} | ${cell(s)} | ${f(s.median - u.median)} | ${f(u2.median - u.median)} | ` +
          (r.baseline
            ? `${cell(r.baseline[metric])} | ${f(u.median - r.baseline[metric].median)} |`
            : "n/a | n/a |")
      );
    }
  }
  console.log("");
}
const jsonAt = process.argv.indexOf("--json");
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(results, null, 2) + "\n");
