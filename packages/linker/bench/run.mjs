// Track C / slice 3 measurements on generated apps.
//
//   node --experimental-vm-modules bench/run.mjs [--sizes 500k,2m,10m]
//        [--profiles default,thin] [--runs 3] [--out bench/results/results.json]
//
// For every (size, profile): generate the app, then measure
//   - solid-tsc wall time without and with typed summaries (+ summary time);
//   - build wall time, baseline vs extraction, and the linker's phases;
//   - initial / route / cold-domain chunk sizes (raw, gzip -9, brotli q11),
//     chunk count, module duplication across chunks;
//   - V8 compile time of the initial chunk (vm.SourceTextModule) and jsdom
//     execute-to-first-render time;
//   - cold-miss and hit latency of a handler (local, plus a network model);
//   - cache stability (rebuild, hot-only edit, cold-only edit);
//   - correctness (baseline vs extracted transcripts over many features).
// Raw per-run samples are kept next to medians/min/max.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import { check } from "@solidjs/typecheck";
import { buildApp } from "../tests/helpers/build.js";
import { coldStats, importEntry, withDom } from "../tests/helpers/dom.js";
import { generateApp } from "./generate.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const compiler = createRequire(import.meta.url)("@solidjs/compiler");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const SIZES = { "60k": 60_000, "500k": 500_000, "2m": 2_000_000, "10m": 10_000_000 };
const sizes = option("sizes", "500k,2m,10m").split(",");
const profiles = option("profiles", "default").split(",");
const baseRuns = Number(option("runs", 3));
const outFile = path.resolve(option("out", path.join(here, "results/results.json")));
const NETWORKS = {
  "fast-4g": { rttMs: 40, mbps: 9 },
  "slow-4g": { rttMs: 150, mbps: 1.6 }
};

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const stat = values => ({
  median: round(median(values)),
  min: round(Math.min(...values)),
  max: round(Math.max(...values)),
  samples: values.map(round)
});
const round = value => Math.round(value * 100) / 100;
const sizesOf = code => ({
  raw: Buffer.byteLength(code),
  gzip: zlib.gzipSync(code, { level: 9 }).length,
  brotli: zlib.brotliCompressSync(code, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
    .length
});
const sum = list =>
  list.reduce(
    (acc, item) => ({
      raw: acc.raw + item.raw,
      gzip: acc.gzip + item.gzip,
      brotli: acc.brotli + item.brotli
    }),
    { raw: 0, gzip: 0, brotli: 0 }
  );
const log = (...values) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...values);

function machine() {
  const repo = path.resolve(here, "../../..");
  const git = command => {
    try {
      return execSync(command, { cwd: repo }).toString().trim();
    } catch {
      return null;
    }
  };
  return {
    node: process.version,
    platform: `${os.platform()} ${os.release()}`,
    cpus: `${os.cpus().length} × ${os.cpus()[0]?.model}`,
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    commit: git("git rev-parse HEAD"),
    dirty: !!git(
      "git status --porcelain -- packages/linker packages/compiler/src packages/typecheck/src"
    )
  };
}

// -- solid-tsc -----------------------------------------------------------------------
function measureTypecheck(root, runs) {
  const plain = [];
  const withSummaries = [];
  const summaryOnly = [];
  let errors = 0;
  // Warm-up (module loading, JIT): not recorded.
  check({
    project: path.join(root, "tsconfig.json"),
    summaries: { outDir: path.join(root, ".summaries") }
  });
  for (let i = 0; i < runs; i++) {
    // Alternate the order so drift does not favour one variant.
    const plainRun = () => {
      const started = performance.now();
      const result = check({ project: path.join(root, "tsconfig.json") });
      plain.push(performance.now() - started);
      return result;
    };
    const summaryRun = () => {
      const started = performance.now();
      const result = check({
        project: path.join(root, "tsconfig.json"),
        summaries: { outDir: path.join(root, ".summaries") }
      });
      withSummaries.push(performance.now() - started);
      summaryOnly.push(result.summaryTime);
      return result;
    };
    const [a, b] =
      i % 2
        ? [plainRun(), summaryRun()]
        : (() => {
            const second = summaryRun();
            return [plainRun(), second];
          })();
    errors =
      a.diagnostics.filter(d => d.category === 1).length +
      b.diagnostics.filter(d => d.category === 1).length;
  }
  const summaryBytes = dirBytes(path.join(root, ".summaries"));
  return {
    errors,
    plainMs: stat(plain),
    withSummariesMs: stat(withSummaries),
    summaryPhaseMs: stat(summaryOnly),
    overheadPct: round(((median(withSummaries) - median(plain)) / median(plain)) * 100),
    summaryBytes
  };
}

function dirBytes(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile())
      total += fs.statSync(path.join(entry.parentPath ?? entry.path, entry.name)).size;
  }
  return total;
}

// -- builds --------------------------------------------------------------------------
async function build(root, variant, outDir, extra = {}) {
  const cold =
    variant === "base"
      ? false
      : { typedSummaries: path.join(root, ".summaries"), prefetch: extra.prefetch ?? "idle" };
  return buildApp({
    root,
    input: path.join(root, "src/main.tsx"),
    outDir,
    cold,
    minified: true,
    sourcemap: false
  });
}

function chunkReport(result, outDir) {
  const chunks = result.output.filter(file => file.type === "chunk");
  const byName = new Map(chunks.map(chunk => [chunk.fileName, chunk]));
  const entry = chunks.find(chunk => chunk.isEntry);
  const initial = new Set();
  const visit = name => {
    if (initial.has(name)) return;
    initial.add(name);
    for (const dep of byName.get(name)?.imports ?? []) visit(dep);
  };
  visit(entry.fileName);
  const domainFiles = new Set((result.manifest?.domains ?? []).map(domain => domain.chunk));
  const measure = name => sizesOf(fs.readFileSync(path.join(outDir, name), "utf8"));
  const initialSizes = [...initial].map(measure);
  const routeChunks = chunks.filter(chunk => /^route\d+-/.test(chunk.fileName));
  const coldChunks = chunks.filter(chunk => domainFiles.has(chunk.fileName));
  const other = chunks.filter(
    chunk =>
      !initial.has(chunk.fileName) && !routeChunks.includes(chunk) && !coldChunks.includes(chunk)
  );
  const moduleChunks = new Map();
  for (const chunk of chunks) {
    for (const [id, info] of Object.entries(chunk.modules)) {
      if (!info.renderedLength) continue;
      const list = moduleChunks.get(id) ?? [];
      list.push({ file: chunk.fileName, bytes: info.renderedLength });
      moduleChunks.set(id, list);
    }
  }
  const duplicated = [...moduleChunks].filter(([, list]) => list.length > 1);
  // Bytes of every copy beyond the first (pre-minification rendered length).
  const duplicateBytes = duplicated.reduce(
    (total, [, list]) => total + list.slice(1).reduce((sum, copy) => sum + copy.bytes, 0),
    0
  );
  const all = chunks.map(chunk => measure(chunk.fileName));
  return {
    chunkCount: chunks.length,
    initial: { files: initial.size, ...sum(initialSizes) },
    routes: { count: routeChunks.length, ...sum(routeChunks.map(c => measure(c.fileName))) },
    coldDomains: {
      count: coldChunks.length,
      ...sum(coldChunks.map(c => measure(c.fileName))),
      largestGzip: Math.max(0, ...coldChunks.map(c => measure(c.fileName).gzip)),
      smallestGzip: coldChunks.length
        ? Math.min(...coldChunks.map(c => measure(c.fileName).gzip))
        : 0
    },
    other: { count: other.length, ...sum(other.map(c => measure(c.fileName))) },
    total: sum(all),
    duplication: {
      modules: duplicated.length,
      bytes: duplicateBytes,
      examples: duplicated.slice(0, 3).map(([id]) => path.basename(id))
    },
    entryFile: entry.fileName,
    initialFiles: [...initial].sort(),
    hashes: chunks.map(chunk => chunk.fileName).sort()
  };
}

// -- parse / execute -------------------------------------------------------------------
/**
 * Compiler cost over every source file: the JSX/`$` transform vs the
 * behavioral summary (`summarizeModule`), warm, per full pass.
 */
function measureCompiler(root, runs) {
  const files = fs
    .readdirSync(path.join(root, "src"), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map(entry => path.join(entry.parentPath ?? entry.path, entry.name));
  const sources = files.map(file => [file, fs.readFileSync(file, "utf8")]);
  const pass = run => {
    const started = performance.now();
    for (const [file, text] of sources) run(file, text);
    return performance.now() - started;
  };
  const transform = (file, text) => compiler.transform(text, { filename: file, generate: "dom" });
  const summarize = (file, text) =>
    compiler.summarizeModule(text, { filename: path.basename(file) });
  pass(transform);
  pass(summarize);
  const transformMs = [];
  const summarizeMs = [];
  for (let i = 0; i < runs; i++) {
    transformMs.push(pass(transform));
    summarizeMs.push(pass(summarize));
  }
  const summaryBytes = sources.reduce(
    (total, [file, text]) => total + JSON.stringify(summarize(file, text)).length,
    0
  );
  return {
    files: files.length,
    transformMs: stat(transformMs),
    summarizeMs: stat(summarizeMs),
    summaryVsTransformPct: round((median(summarizeMs) / median(transformMs)) * 100),
    summaryJsonBytes: summaryBytes
  };
}

/**
 * First interaction under each prefetch policy: a click immediately after
 * the home features mount, and one 300 ms later (after an idle period).
 * `intent` sees a pointerover on the feature 30 ms before the click.
 */
async function measurePolicy(outDir, total, policy, delayMs, runs) {
  const samples = [];
  let misses = 0;
  for (let i = 0; i < runs; i++) {
    const dir = freshCopy(outDir);
    delete globalThis[Symbol.for("solid.cold.stats")];
    await withDom(async window => {
      const doc = window.document;
      await importEntry(entryOf(dir));
      await waitFor(() => doc.querySelectorAll("section.feature").length >= 1);
      if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
      const section = doc.querySelector("#f0");
      if (policy === "intent") {
        section.dispatchEvent(new window.MouseEvent("pointerover", { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      const status = section.querySelector(".status");
      const before = status.textContent;
      const started = performance.now();
      section
        .querySelector(".bump")
        .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      await waitFor(() => status.textContent !== before);
      samples.push(performance.now() - started);
      misses += coldStats()?.misses ?? 0;
      await mounted(doc, total);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { latencyMs: stat(samples), misses, runs };
}

/** Parse + V8 compile of every initial-load file (eager top level, preparsed functions). */
function measureCompile(dir, files, runs = 15) {
  const codes = files.map(file => fs.readFileSync(path.join(dir, file), "utf8"));
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    for (const code of codes)
      new vm.SourceTextModule(code, { identifier: `bench-${i}-${Math.random()}` });
    samples.push(performance.now() - started);
  }
  return stat(samples.slice(2));
}

function freshCopy(dir) {
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "solid-bench-run-"));
  fs.cpSync(dir, copy, { recursive: true });
  return copy;
}

/** Let lazy routes finish mounting before the window goes away. */
async function mounted(doc, total) {
  await waitFor(() => doc.querySelectorAll("section.feature").length >= total, 60000);
  await new Promise(resolve => setTimeout(resolve, 20));
}

async function measureExecute(outDir, homeFeatures, total, runs) {
  const samples = [];
  for (let i = 0; i < runs; i++) {
    const dir = freshCopy(outDir);
    await withDom(async window => {
      const started = performance.now();
      await importEntry(entryOf(dir));
      while (window.document.querySelectorAll("section.feature").length < homeFeatures) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      samples.push(performance.now() - started);
      await mounted(window.document, total);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return stat(samples);
}

function entryOf(dir) {
  const files = fs.readdirSync(dir).filter(file => /^main-.*\.js$/.test(file));
  return files
    .map(file => path.join(dir, file))
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size)[0];
}

async function waitFor(predicate, timeout = 10000) {
  const started = performance.now();
  while (!predicate()) {
    if (performance.now() - started > timeout) throw new Error("timeout");
    await new Promise(resolve => setImmediate(resolve));
  }
  return performance.now() - started;
}

/** First interaction (a miss when extracted with prefetch "none") and a second one (a hit). */
async function measureLatency(outDir, total, runs) {
  const miss = [];
  const hit = [];
  let stats = null;
  for (let i = 0; i < runs; i++) {
    const dir = freshCopy(outDir);
    delete globalThis[Symbol.for("solid.cold.stats")];
    await withDom(async window => {
      const doc = window.document;
      await importEntry(entryOf(dir));
      await waitFor(() => doc.querySelectorAll("section.feature").length >= 2);
      await new Promise(resolve => setTimeout(resolve, 50));
      const clickAndWait = async id => {
        const status = doc.querySelector(`#${id} .status`);
        const before = status.textContent;
        const started = performance.now();
        doc
          .querySelector(`#${id} .bump`)
          .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await waitFor(() => status.textContent !== before);
        return performance.now() - started;
      };
      miss.push(await clickAndWait("f0"));
      hit.push(await clickAndWait("f1"));
      stats = { ...(coldStats() ?? {}) };
      await mounted(doc, total);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { firstInteractionMs: stat(miss), secondInteractionMs: stat(hit), runtimeStats: stats };
}

// -- correctness -------------------------------------------------------------------------
async function transcript(outDir, featureIds, total) {
  const dir = freshCopy(outDir);
  delete globalThis[Symbol.for("solid.cold.stats")];
  try {
    return await withDom(async window => {
      const doc = window.document;
      const lines = [];
      const text = id => doc.getElementById(id)?.textContent ?? "-";
      await importEntry(entryOf(dir));
      await waitFor(() => featureIds.every(id => doc.getElementById(id)), 30000);
      const settle = async () => {
        for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
      };
      for (const id of featureIds) {
        const section = doc.getElementById(id);
        const input = section.querySelector(".name");
        input.value = `item ${id}, a; b`;
        input.dispatchEvent(new window.InputEvent("input", { bubbles: true }));
        await settle();
        const submit = new window.Event("submit", { bubbles: true, cancelable: true });
        section.querySelector("form").dispatchEvent(submit);
        lines.push(`${id} submit defaultPrevented=${submit.defaultPrevented}`);
        await settle();
        section
          .querySelector(".bump")
          .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await settle();
        const guard = new window.MouseEvent("click", { bubbles: true });
        section.querySelector(".status").dispatchEvent(guard);
        await settle();
        lines.push(`${id} | ${text(id)}`);
      }
      await mounted(doc, total);
      return { lines, stats: { ...(coldStats() ?? {}) } };
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// -- cache stability -------------------------------------------------------------------------
function editFile(file, from, to) {
  const text = fs.readFileSync(file, "utf8");
  if (!text.includes(from)) throw new Error(`edit anchor missing in ${file}`);
  fs.writeFileSync(file, text.replace(from, to));
  return () => fs.writeFileSync(file, text);
}

async function measureStability(root, variant, reference, outBase) {
  const changed = (before, after) => {
    const set = new Set(before.hashes);
    const files = after.hashes.filter(name => !set.has(name));
    return { changedChunks: files.length, of: after.hashes.length, changedFiles: files };
  };
  const results = {};
  const rebuild = await build(root, variant, `${outBase}-rebuild`);
  results.rebuild = changed(reference, chunkReport(rebuild, `${outBase}-rebuild`));
  // Hot-only edit: a render helper's text in a home feature.
  let restore = editFile(path.join(root, "src/features/f1/view.ts"), "Feature 1:", "Feature one:");
  if (variant === "cold")
    check({
      project: path.join(root, "tsconfig.json"),
      summaries: { outDir: path.join(root, ".summaries") }
    });
  let result = await build(root, variant, `${outBase}-hotedit`);
  let report = chunkReport(result, `${outBase}-hotedit`);
  results.hotEdit = {
    ...changed(reference, report),
    changedGzip: gzipOf(report, reference, `${outBase}-hotedit`)
  };
  restore();
  // Cold-only edit: handler logic of a home feature.
  const logic = path.join(root, "src/features/f1/logic.ts");
  if (fs.existsSync(logic)) {
    restore = editFile(logic, "added ", "appended ");
    if (variant === "cold")
      check({
        project: path.join(root, "tsconfig.json"),
        summaries: { outDir: path.join(root, ".summaries") }
      });
    result = await build(root, variant, `${outBase}-coldedit`);
    report = chunkReport(result, `${outBase}-coldedit`);
    results.coldEdit = {
      ...changed(reference, report),
      changedGzip: gzipOf(report, reference, `${outBase}-coldedit`)
    };
    restore();
  }
  if (variant === "cold")
    check({
      project: path.join(root, "tsconfig.json"),
      summaries: { outDir: path.join(root, ".summaries") }
    });
  return results;
}

function gzipOf(report, reference, dir) {
  const set = new Set(reference.hashes);
  return report.hashes
    .filter(name => !set.has(name))
    .reduce(
      (total, name) =>
        total + zlib.gzipSync(fs.readFileSync(path.join(dir, name)), { level: 9 }).length,
      0
    );
}

// -- main ------------------------------------------------------------------------------------
const results = {
  schema: "solid-linker-bench",
  version: 1,
  machine: machine(),
  networks: NETWORKS,
  apps: []
};
for (const profile of profiles) {
  for (const size of sizes) {
    const name = `${profile}-${size}`;
    const runs = size === "10m" ? Math.max(2, baseRuns - 1) : baseRuns;
    const root = path.join(here, ".apps", name);
    const outBase = path.join(here, ".out", name);
    log(`== ${name}: generating`);
    const app = generateApp(root, { targetBytes: SIZES[size], profile });
    const record = { name, profile, size, app: { ...app, dir: undefined }, runs };
    log(
      `   ${app.features} features, ${app.routes} routes, ${app.bytes} bytes; solid-tsc ×${runs}`
    );
    record.typecheck = measureTypecheck(root, runs);
    record.compiler = measureCompiler(root, runs);
    log(
      `   compiler transform ${record.compiler.transformMs.median}ms, summarize ${record.compiler.summarizeMs.median}ms (${record.compiler.summaryVsTransformPct}%)`
    );
    log(
      `   tsc ${record.typecheck.plainMs.median}ms, +summaries ${record.typecheck.withSummariesMs.median}ms (${record.typecheck.overheadPct}%)`
    );
    const builds = { base: [], cold: [] };
    const phases = [];
    let reports = {};
    let manifest;
    // Warm-up builds (not recorded).
    await build(root, "base", `${outBase}-base`);
    await build(root, "cold", `${outBase}-cold`);
    for (let i = 0; i < runs; i++) {
      for (const variant of i % 2 ? ["cold", "base"] : ["base", "cold"]) {
        const outDir = `${outBase}-${variant}`;
        const result = await build(root, variant, outDir);
        builds[variant].push(result.time);
        if (variant === "cold") {
          manifest = result.manifest;
          phases.push(manifest.stats.timings);
        }
        reports[variant] = chunkReport(result, outDir);
      }
    }
    record.build = {
      baseMs: stat(builds.base),
      coldMs: stat(builds.cold),
      overheadPct: round(((median(builds.cold) - median(builds.base)) / median(builds.base)) * 100),
      linkerPhasesMs: Object.fromEntries(
        Object.keys(phases[0]).map(key => [key, stat(phases.map(phase => phase[key]))])
      )
    };
    record.analysis = {
      modules: manifest.stats.modules,
      blocks: manifest.stats.blocks,
      domains: manifest.stats.domains,
      movedStatements: manifest.stats.movedStatements,
      iterations: manifest.stats.iterations,
      manifestBytes: Buffer.byteLength(JSON.stringify(manifest))
    };
    record.sizes = { base: reports.base, cold: reports.cold };
    for (const report of Object.values(record.sizes)) delete report.hashes;
    log(
      `   build base ${record.build.baseMs.median}ms cold ${record.build.coldMs.median}ms; initial gzip ${reports.base.initial.gzip} → ${reports.cold.initial.gzip}`
    );
    record.compile = {
      baseMs: measureCompile(`${outBase}-base`, reports.base.initialFiles),
      coldMs: measureCompile(`${outBase}-cold`, reports.cold.initialFiles)
    };
    const homeFeatures = app.home;
    record.execute = {
      baseMs: await measureExecute(`${outBase}-base`, homeFeatures, app.features, 5),
      coldMs: await measureExecute(`${outBase}-cold`, homeFeatures, app.features, 5)
    };
    // Latency: prefetch "none" makes the first interaction a guaranteed miss.
    await build(root, "cold", `${outBase}-none`, { prefetch: "none" });
    const latency = {
      base: await measureLatency(`${outBase}-base`, app.features, 5),
      coldNone: await measureLatency(`${outBase}-none`, app.features, 5)
    };
    const domain = manifest.domains.find(d => d.roots.includes("src/main.tsx"));
    const domainGzip = domain
      ? zlib.gzipSync(fs.readFileSync(path.join(`${outBase}-cold`, domain.chunk)), { level: 9 })
          .length
      : 0;
    latency.model = Object.fromEntries(
      Object.entries(NETWORKS).map(([network, { rttMs, mbps }]) => [
        network,
        {
          missAddedMs: round(rttMs + (domainGzip * 8) / (mbps * 1000)),
          domainGzip
        }
      ])
    );
    record.latency = latency;
    // Prefetch policies (bundles differ only in the policy literal).
    record.prefetch = { base: {}, cold: {} };
    for (const delay of [0, 300]) {
      record.prefetch.base[`click@${delay}ms`] = await measurePolicy(
        `${outBase}-base`,
        app.features,
        "base",
        delay,
        5
      );
    }
    for (const policy of ["none", "intent", "idle", "load"]) {
      const dir = `${outBase}-policy-${policy}`;
      await build(root, "cold", dir, { prefetch: policy });
      record.prefetch.cold[policy] = {};
      for (const delay of [0, 300]) {
        record.prefetch.cold[policy][`click@${delay}ms`] = await measurePolicy(
          dir,
          app.features,
          policy,
          delay,
          5
        );
      }
    }
    log(
      `   prefetch click@0ms ${Object.entries(record.prefetch.cold)
        .map(
          ([policy, value]) =>
            `${policy}=${value["click@0ms"].latencyMs.median}ms/${value["click@0ms"].misses}miss`
        )
        .join(" ")}`
    );
    log(
      `   latency miss ${latency.coldNone.firstInteractionMs.median}ms hit ${latency.coldNone.secondInteractionMs.median}ms base ${latency.base.firstInteractionMs.median}ms`
    );
    // Correctness: home features plus the first route's features.
    const featureIds = Array.from(
      { length: Math.min(app.features, app.home + 10) },
      (_, i) => `f${i}`
    );
    const base = await transcript(`${outBase}-base`, featureIds, app.features);
    const none = await transcript(`${outBase}-none`, featureIds, app.features);
    const idle = await transcript(`${outBase}-cold`, featureIds, app.features);
    record.correctness = {
      features: featureIds.length,
      interactions: featureIds.length * 4,
      equalMissPath: JSON.stringify(base.lines) === JSON.stringify(none.lines),
      equalIdlePath: JSON.stringify(base.lines) === JSON.stringify(idle.lines),
      preventDefaultSync: none.lines.filter(line => line.includes("defaultPrevented=true")).length,
      missPathStats: none.stats,
      firstDifference: base.lines.find((line, i) => line !== none.lines[i]) ?? null
    };
    log(
      `   correctness miss=${record.correctness.equalMissPath} idle=${record.correctness.equalIdlePath}`
    );
    // Cache stability (reference = the last builds above).
    const reference = {
      base: chunkReport(await build(root, "base", `${outBase}-base`), `${outBase}-base`),
      cold: chunkReport(await build(root, "cold", `${outBase}-cold`), `${outBase}-cold`)
    };
    record.stability = {
      base: await measureStability(root, "base", reference.base, `${outBase}-stab-base`),
      cold: await measureStability(root, "cold", reference.cold, `${outBase}-stab-cold`)
    };
    log(
      `   stability hotEdit base ${record.stability.base.hotEdit.changedChunks}/${record.stability.base.hotEdit.of} cold ${record.stability.cold.hotEdit.changedChunks}/${record.stability.cold.hotEdit.of}`
    );
    results.apps.push(record);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify(results, null, 2) + "\n");
    for (const dir of fs.readdirSync(path.join(here, ".out"))) {
      if (dir.startsWith(name))
        fs.rmSync(path.join(here, ".out", dir), { recursive: true, force: true });
    }
  }
}
log(`wrote ${outFile}`);
