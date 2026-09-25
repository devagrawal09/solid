// Retained-graph size measurement for optimization slice 7
// (capability-selected hydration runtime).
//
//   node scripts/hydration-capabilities/measure-size.mjs [--json out.json]
//
// For each fixture graph (sync/no-store, store, async, streaming, lazy,
// full), bundles the real client — the compiled app plus its hydrate entry —
// against the built production artifacts, three ways:
//   csr        render() of the non-hydratable compilation (context only)
//   universal  hydrate() from "@solidjs/web" (every capability)
//   selected   hydrate() from the entry composed from the graph's manifest
// and reports minified raw / gzip(9) / brotli(11) bytes. It also measures
// each capability's marginal cost alone (added to the sync graph's minimal
// runtime) and removed from the full runtime, to expose overlap between
// capabilities that share helpers.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APPS, APPS_DIR, bundle, loadManifestTools, readManifest } from "./bundle.mjs";

const { composeHydrationEntry, assertHydrationManifest } = await loadManifestTools();
const workDir = mkdtempSync(join(tmpdir(), "solid-slice7-size-"));
const out = { apps: {}, marginal: {}, removed: {} };

function appEntry(app, hydrateFrom, mode = "hydrate") {
  const appPath = JSON.stringify(join(APPS_DIR, `${app}.tsx`));
  if (mode === "render")
    return (
      `import { render } from "@solidjs/web";\nimport { createComponent } from "solid-js";\n` +
      `import App from ${appPath};\n` +
      `render(() => createComponent(App, {}), document.getElementById("root"));\n`
    );
  return (
    `import { hydrate } from ${JSON.stringify(hydrateFrom)};\nimport { createComponent } from "solid-js";\n` +
    `import App from ${appPath};\n` +
    `hydrate(() => createComponent(App, {}), document.getElementById("root"));\n`
  );
}

function entryFile(manifest) {
  const file = join(
    workDir,
    `hydration-${manifest.producer.replace(/\W/g, "_")}-${Math.random().toString(36).slice(2)}.js`
  );
  writeFileSync(file, composeHydrationEntry(manifest));
  return file;
}

const fmt = n => String(n).padStart(6);
const delta = (a, b) => {
  const d = a - b;
  return `${d > 0 ? "+" : ""}${d} (${((d / b) * 100).toFixed(1)}%)`;
};

try {
  if (process.argv.includes("--universal-only")) {
    // Baseline mode (SLICE7_DIST_ROOT=<pre-change dists>): only the universal
    // hydrate() exists there.
    console.log("| graph | csr render() | universal hydrate() |\n|---|---|---|");
    for (const app of APPS) {
      const csr = await bundle(appEntry(app, null, "render"), { hydratable: false, workDir });
      const universal = await bundle(appEntry(app, "@solidjs/web"), { workDir });
      out.apps[app] = {
        csr: { raw: csr.raw, gzip: csr.gzip, brotli: csr.brotli },
        universal: { raw: universal.raw, gzip: universal.gzip, brotli: universal.brotli }
      };
      const cell = s => `${s.raw} / ${s.gzip} / ${s.brotli}`;
      console.log(`| ${app} | ${cell(csr)} | ${cell(universal)} |`);
    }
    const jsonAt = process.argv.indexOf("--json");
    if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out, null, 2) + "\n");
    process.exit(0);
  }
  for (const app of APPS) {
    const manifest = assertHydrationManifest(readManifest(app));
    const csr = await bundle(appEntry(app, null, "render"), { hydratable: false, workDir });
    const universal = await bundle(appEntry(app, "@solidjs/web"), { workDir });
    const selected = await bundle(appEntry(app, entryFile(manifest)), { workDir });
    out.apps[app] = {
      csr: { raw: csr.raw, gzip: csr.gzip, brotli: csr.brotli },
      universal: { raw: universal.raw, gzip: universal.gzip, brotli: universal.brotli },
      selected: { raw: selected.raw, gzip: selected.gzip, brotli: selected.brotli }
    };
  }

  // Capability marginals on the runtime alone: the sync graph's app code is
  // held fixed, so the delta is hydration runtime only.
  const base = assertHydrationManifest(readManifest("sync"));
  const with_ = caps =>
    assertHydrationManifest({
      ...base,
      producer: "measure:" + Object.keys(caps).join("+"),
      capabilities: { ...base.capabilities, ...caps }
    });
  const baseSize = await bundle(appEntry("sync", entryFile(base)), { workDir });
  const adds = {
    snapshots: { snapshots: true },
    asyncResults: { asyncResults: true, snapshots: true },
    storeAdapters: { storeAdapters: true, snapshots: true },
    errorMarkers: { errorMarkers: true },
    loadingMarkers: { loadingMarkers: true, snapshots: true },
    streamLedger: { streamLedger: true, loadingMarkers: true, snapshots: true },
    lazyAssets: { lazyAssets: true },
    "ssrSources[client]": { ssrSources: ["client"], snapshots: true },
    "ssrSources[hybrid]": { ssrSources: ["hybrid"], snapshots: true },
    "ssrSources[client,hybrid]": { ssrSources: ["client", "hybrid"], snapshots: true }
  };
  out.marginal.base = { raw: baseSize.raw, gzip: baseSize.gzip, brotli: baseSize.brotli };
  for (const [name, caps] of Object.entries(adds)) {
    const s = await bundle(appEntry("sync", entryFile(with_(caps))), { workDir });
    out.marginal[name] = {
      raw: s.raw - baseSize.raw,
      gzip: s.gzip - baseSize.gzip,
      brotli: s.brotli - baseSize.brotli
    };
  }
  const noEvents = await bundle(appEntry("sync", entryFile(with_({ delegatedEvents: [] }))), {
    workDir
  });
  out.marginal["delegatedEvents (replay)"] = {
    raw: baseSize.raw - noEvents.raw,
    gzip: baseSize.gzip - noEvents.gzip,
    brotli: baseSize.brotli - noEvents.brotli
  };

  // Removal from the full runtime (sync graph's app code again).
  const full = assertHydrationManifest(readManifest("full"));
  const fullSize = await bundle(appEntry("sync", entryFile({ ...full, graph: "sync" })), {
    workDir
  });
  out.removed.full = { raw: fullSize.raw, gzip: fullSize.gzip, brotli: fullSize.brotli };
  const removals = {
    asyncResults: { asyncResults: false },
    storeAdapters: { storeAdapters: false },
    errorMarkers: { errorMarkers: false },
    streamLedger: { streamLedger: false },
    "loadingMarkers+streamLedger": { loadingMarkers: false, streamLedger: false },
    lazyAssets: { lazyAssets: false },
    ssrSources: { ssrSources: [] }
  };
  for (const [name, caps] of Object.entries(removals)) {
    const m = assertHydrationManifest({
      ...full,
      graph: "sync",
      producer: "measure:-" + name,
      capabilities: { ...full.capabilities, ...caps }
    });
    const s = await bundle(appEntry("sync", entryFile(m)), { workDir });
    out.removed[name] = {
      raw: fullSize.raw - s.raw,
      gzip: fullSize.gzip - s.gzip,
      brotli: fullSize.brotli - s.brotli
    };
  }
  const universalSync = out.apps.sync.universal;
  out.removed["universal - full-manifest (same capabilities)"] = {
    raw: universalSync.raw - fullSize.raw,
    gzip: universalSync.gzip - fullSize.gzip,
    brotli: universalSync.brotli - fullSize.brotli
  };

  // Report.
  console.log("## Retained client graph (minified bytes: raw / gzip / brotli)\n");
  console.log(
    "| graph | csr render() | universal hydrate() | manifest entry | Δ selected vs universal (brotli) |"
  );
  console.log("|---|---|---|---|---|");
  for (const [app, r] of Object.entries(out.apps)) {
    const cell = s => `${s.raw} / ${s.gzip} / ${s.brotli}`;
    console.log(
      `| ${app} | ${cell(r.csr)} | ${cell(r.universal)} | ${cell(r.selected)} | ${delta(r.selected.brotli, r.universal.brotli)} |`
    );
  }
  console.log(
    "\n## Capability marginal cost, added alone to the sync graph's minimal runtime (bytes)\n"
  );
  console.log("| capability | raw | gzip | brotli |\n|---|---|---|---|");
  for (const [k, v] of Object.entries(out.marginal))
    console.log(`| ${k} | ${fmt(v.raw)} | ${fmt(v.gzip)} | ${fmt(v.brotli)} |`);
  console.log("\n## Removed from the full runtime (bytes saved)\n");
  console.log("| capability | raw | gzip | brotli |\n|---|---|---|---|");
  for (const [k, v] of Object.entries(out.removed))
    console.log(`| ${k} | ${fmt(v.raw)} | ${fmt(v.gzip)} | ${fmt(v.brotli)} |`);

  const jsonAt = process.argv.indexOf("--json");
  if (jsonAt > 0) writeFileSync(process.argv[jsonAt + 1], JSON.stringify(out, null, 2) + "\n");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
