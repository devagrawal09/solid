// Bootstrap-selected hydration bytes and compiler cost (optimization slice 7).
//
//   node scripts/hydration-capabilities/measure-bootstrap.mjs [--json out.json]
//
// For the read-only, event-only, synchronous-only, store-using, streamed and
// full-feature fixture graphs, resolves the client bootstrap from the graph's
// capability manifest (resolveHydrationBootstrap) and from an unknown summary
// (the general runtime), bundles each against the built production
// artifacts, and reports:
//
//   emitted   tree-shaken bundle, not minified
//   minified  esbuild minify
//   gzip      gzip -9 of the minified bundle (brotli q11 alongside)
//
// for the whole client and for the RUNTIME alone. Runtime bytes are the
// whole bundle minus the same entry bundled with solid-js, @solidjs/web and
// @solidjs/signals external (the app's own code and the generated entry).
// Raw and minified runtime bytes subtract exactly; compressed sizes are not
// strictly additive, so compressed runtime bytes are a close estimate.
//
// Compiler cost: wall time of resolveHydrationBootstrap (manifest ->
// validated selection -> entry source + source map) per graph, next to the
// native JSX compiler's time for the same app module (a debug build of the
// compiler; reference only).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { APPS_DIR, ROOT, bundle, loadManifestTools, readManifest, sizes } from "./bundle.mjs";

const FIXTURES = [
  ["read-only", "read-only"],
  ["event-only", "event-only"],
  ["synchronous-only", "sync"],
  ["store-using", "store"],
  ["streamed", "streaming"],
  ["full-feature", "full"]
];
const RUNTIME = ["solid-js", "@solidjs/web", "@solidjs/signals"];
const { resolveHydrationBootstrap } = await loadManifestTools();
const compiler = createRequire(import.meta.url)(join(ROOT, "packages/compiler/index.js"));
const workDir = mkdtempSync(join(tmpdir(), "solid-slice7-bootstrap-"));

function appEntry(app, entryFile) {
  return (
    `import { hydrate } from ${JSON.stringify(entryFile)};\n` +
    `import { createComponent } from "solid-js";\n` +
    `import App from ${JSON.stringify(join(APPS_DIR, `${app}.tsx`))};\n` +
    `hydrate(() => createComponent(App, {}), document.getElementById("root"));\n`
  );
}

async function measure(app, bootstrap) {
  const entryFile = join(
    workDir,
    `${app}-${bootstrap.mode}-${Math.random().toString(36).slice(2)}.js`
  );
  writeFileSync(entryFile, bootstrap.entry.code);
  const src = appEntry(app, entryFile);
  const emitted = await bundle(src, { workDir, minify: false });
  const minified = await bundle(src, { workDir });
  const appOnlyEmitted = await bundle(src, {
    workDir,
    minify: false,
    external: RUNTIME,
    alias: {}
  });
  const appOnlyMin = await bundle(src, { workDir, external: RUNTIME, alias: {} });
  return {
    total: {
      emitted: emitted.raw,
      minified: minified.raw,
      gzip: minified.gzip,
      brotli: minified.brotli
    },
    runtime: {
      emitted: emitted.raw - appOnlyEmitted.raw,
      minified: minified.raw - appOnlyMin.raw,
      gzip: minified.gzip - appOnlyMin.gzip,
      brotli: minified.brotli - appOnlyMin.brotli
    },
    entry: sizes(bootstrap.entry.code).raw
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function time(fn, n) {
  for (let i = 0; i < Math.min(50, n); i++) fn(); // warm up
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    fn();
    samples.push(performance.now() - t);
  }
  return { medianUs: median(samples) * 1000, n };
}

const out = { fixtures: {}, compiler: {} };
try {
  const unknownSummary = { schema: 1, hydration: "unknown" };
  const general = resolveHydrationBootstrap(unknownSummary);
  for (const [label, app] of FIXTURES) {
    const manifest = readManifest(app);
    const selected = resolveHydrationBootstrap(manifest);
    if (selected.mode !== "selected") throw new Error(`${label}: manifest did not select`);
    out.fixtures[label] = {
      app,
      installers: selected.installers,
      selected: await measure(app, selected),
      general: await measure(app, general)
    };
    const source = readFileSync(join(APPS_DIR, `${app}.tsx`), "utf-8");
    out.compiler[label] = {
      resolveBootstrap: time(() => resolveHydrationBootstrap(manifest), 2000),
      resolveBootstrapInlineMap: time(
        () => resolveHydrationBootstrap(manifest, { inlineSourceMap: true }),
        2000
      ),
      resolveGeneral: time(() => resolveHydrationBootstrap(unknownSummary), 2000),
      jsxCompileApp: time(
        () =>
          compiler.transform(source, {
            generate: "dom",
            hydratable: true,
            dev: false,
            filename: `${app}.tsx`
          }),
        200
      )
    };
  }
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

const row = s => `${s.emitted} / ${s.minified} / ${s.gzip} / ${s.brotli}`;
const d = (a, b) => `${a - b > 0 ? "+" : ""}${a - b}`;
console.log("## Runtime bytes (emitted / minified / gzip / brotli)\n");
console.log(
  "| fixture | installers | selected runtime | general runtime | Δ runtime minified | Δ runtime gzip |"
);
console.log("|---|---|---|---|---|---|");
for (const [label, r] of Object.entries(out.fixtures))
  console.log(
    `| ${label} | ${r.installers.join(", ") || "(none)"} | ${row(r.selected.runtime)} | ${row(r.general.runtime)} | ${d(r.selected.runtime.minified, r.general.runtime.minified)} | ${d(r.selected.runtime.gzip, r.general.runtime.gzip)} |`
  );
console.log("\n## Whole client (emitted / minified / gzip / brotli)\n");
console.log(
  "| fixture | selected | general | Δ gzip | generated entry bytes (selected / general) |"
);
console.log("|---|---|---|---|---|");
for (const [label, r] of Object.entries(out.fixtures))
  console.log(
    `| ${label} | ${row(r.selected.total)} | ${row(r.general.total)} | ${d(r.selected.total.gzip, r.general.total.gzip)} | ${r.selected.entry} / ${r.general.entry} |`
  );
console.log("\n## Compiler cost (median µs per call)\n");
console.log(
  "| fixture | resolveHydrationBootstrap | + inline source map | unknown summary (general) | JSX compile of the app module (reference) |"
);
console.log("|---|---|---|---|---|");
for (const [label, c] of Object.entries(out.compiler))
  console.log(
    `| ${label} | ${c.resolveBootstrap.medianUs.toFixed(1)} | ${c.resolveBootstrapInlineMap.medianUs.toFixed(1)} | ${c.resolveGeneral.medianUs.toFixed(1)} | ${c.jsxCompileApp.medianUs.toFixed(1)} |`
  );
const jsonAt = process.argv.indexOf("--json");
if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out, null, 2) + "\n");
