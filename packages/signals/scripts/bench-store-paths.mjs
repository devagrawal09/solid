#!/usr/bin/env node
/**
 * Strict store path reads (optimization Track B, slice 2): runtime cost of
 * each spelling of the same path read, over the PRODUCTION build
 * (`dist/prod`, property-mangled — run `pnpm --filter @solidjs/signals build`
 * first).
 *
 * Variants (same workload, same process, interleaved per sample):
 *   proxy    handwritten Solid: `store.a.b.c` in a plain memo (N Proxy [[Get]]s)
 *   rewalk   previous strict lowering: `$(() => perform(readPath(store, [...])))`
 *            (op object + path array + closure + token probe + proxy walk)
 *   handle   stage-1 lowering: `$(() => readPathK(store, ...))` (1 trap + K-1 handle hops)
 *   fused    stage-1 lowering under host fusion: plain memo, `readPathK(store, ...)`
 *   generic  `readPathN(store, HOISTED_KEYS)` in a plain memo (fixed arity vs generic)
 *   inline   `readPathN(store, [...])` with a per-read key array
 *   rooted   stage-2 handle root: `readHandleK(handle, ...)` (0 traps; see stage 2)
 *
 * Workloads (each "op" = one flush that re-runs the reading computation(s)):
 *   shallow  1 memo × 1000 reads of `store.v` (1 key)
 *   deep     1 memo × 1000 reads of `store.a.b.c.d` (4 keys)
 *   dynamic  1 memo × 1000 reads of `store.items[i].name`, i = 0..999 (3 keys, dynamic)
 *   list     1000 row memos, each `row.title` + `row.meta.done` (rows = child proxies)
 *
 * Modes:
 *   node scripts/bench-store-paths.mjs [--samples 21] [--ops 200] [--json out.json]
 *     [--dist /abs/path/to/dist/prod/index.js]   (another build, e.g. a base worktree)
 *     [--only shallow|deep|dynamic|list]
 *   node scripts/bench-store-paths.mjs --alloc [--json out.json]
 *     allocation evidence: heap bytes per read over windows that ran with
 *     zero scavenges (a `--trace-gc` child process; see `allocation`).
 */
import { performance, PerformanceObserver } from "node:perf_hooks";
import { writeFileSync } from "node:fs";
import os from "node:os";

const distArg = process.argv.indexOf("--dist");
const DIST =
  distArg === -1
    ? new URL("../dist/prod/index.js", import.meta.url).href
    : new URL(`file://${process.argv[distArg + 1]}`).href;
const S = await import(DIST);
const {
  $,
  createMemo,
  createRoot,
  createSignal,
  createStore,
  flush,
  perform,
  readPath,
  readPath1,
  readPath2,
  readPath3,
  readPath4,
  readPathN
} = S;
const storeHandle = S.storeHandle;
const readHandle1 = S.readHandle1;
const readHandle3 = S.readHandle3;
const readHandle4 = S.readHandle4;
const HAS_ROOTED = typeof storeHandle === "function";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const SAMPLES = Number(opt("samples", 21));
const OPS = Number(opt("ops", 200));
const WARMUP_OPS = Number(opt("warmup", 400));
const ALLOC = args.includes("--alloc");
const JSON_OUT = opt("json", null);
const ONLY = opt("only", null);
const R = 1000;

// --- workloads -------------------------------------------------------------------

const DEEP_KEYS = ["a", "b", "c", "d"];
const DYN_PREFIX = "items";

function readLoop(variant, store, handle, workload) {
  // Returns a compute function performing R path reads for the variant.
  switch (workload) {
    case "shallow":
      switch (variant) {
        case "proxy":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += store.v;
            return s;
          };
        case "rewalk":
          return $(function () {
            let s = 0;
            for (let i = 0; i < R; i++) s += perform(readPath(store, ["v"]));
            return s;
          });
        case "handle":
          return $(function () {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPath1(store, "v");
            return s;
          });
        case "fused":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPath1(store, "v");
            return s;
          };
        case "generic": {
          const keys = ["v"];
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPathN(store, keys);
            return s;
          };
        }
        case "inline":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPathN(store, ["v"]);
            return s;
          };
        case "rooted":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readHandle1(handle, "v");
            return s;
          };
      }
      break;
    case "deep":
      switch (variant) {
        case "proxy":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += store.a.b.c.d;
            return s;
          };
        case "rewalk":
          return $(function () {
            let s = 0;
            for (let i = 0; i < R; i++) s += perform(readPath(store, ["a", "b", "c", "d"]));
            return s;
          });
        case "handle":
          return $(function () {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPath4(store, "a", "b", "c", "d");
            return s;
          });
        case "fused":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPath4(store, "a", "b", "c", "d");
            return s;
          };
        case "generic":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPathN(store, DEEP_KEYS);
            return s;
          };
        case "inline":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPathN(store, ["a", "b", "c", "d"]);
            return s;
          };
        case "rooted":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readHandle4(handle, "a", "b", "c", "d");
            return s;
          };
      }
      break;
    case "dynamic":
      switch (variant) {
        case "proxy":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += store.items[i].name;
            return s;
          };
        case "rewalk":
          return $(function () {
            let s = 0;
            for (let i = 0; i < R; i++) s += perform(readPath(store, ["items", i, "name"]));
            return s;
          });
        case "handle":
          return $(function () {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPath3(store, "items", i, "name");
            return s;
          });
        case "fused":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPath3(store, "items", i, "name");
            return s;
          };
        case "generic":
          // Dynamic keys cannot be hoisted: the generic reader needs an array.
          return null;
        case "inline":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readPathN(store, [DYN_PREFIX, i, "name"]);
            return s;
          };
        case "rooted":
          return () => {
            let s = 0;
            for (let i = 0; i < R; i++) s += readHandle3(handle, "items", i, "name");
            return s;
          };
      }
      break;
  }
  throw new Error(`no ${variant}/${workload}`);
}

function rowCompute(variant, row, rowHandle) {
  switch (variant) {
    case "proxy":
      return () => row.title.length + (row.meta.done ? 1 : 0);
    case "rewalk":
      return $(function () {
        return (
          perform(readPath(row, ["title"])).length +
          (perform(readPath(row, ["meta", "done"])) ? 1 : 0)
        );
      });
    case "handle":
      return $(function () {
        return readPath1(row, "title").length + (readPath2(row, "meta", "done") ? 1 : 0);
      });
    case "fused":
      return () => readPath1(row, "title").length + (readPath2(row, "meta", "done") ? 1 : 0);
    case "rooted":
      return () =>
        readHandle1(rowHandle, "title").length + (S.readHandle2(rowHandle, "meta", "done") ? 1 : 0);
    default:
      return null;
  }
}

/** Build one benchmark instance: returns { op, dispose, check } or null. */
function setup(variant, workload) {
  if (variant === "rooted" && !HAS_ROOTED) return null;
  // A build without the readers (a base checkout via --dist) runs the
  // variants it has.
  if (variant !== "proxy" && variant !== "rewalk" && typeof readPath1 !== "function") return null;
  let dispose;
  let op;
  let check;
  createRoot(d => {
    dispose = d;
    if (workload === "list") {
      const [store, setStore] = createStore({
        rows: Array.from({ length: R }, (_, i) => ({
          id: i,
          title: `row ${i}`,
          meta: { done: false }
        }))
      });
      const rootHandle = HAS_ROOTED ? storeHandle(store) : null;
      const memos = [];
      for (let i = 0; i < R; i++) {
        const row = store.rows[i];
        const rowHandle = HAS_ROOTED ? S.readHandleChild(rootHandle, "rows", i) : null;
        const fn = rowCompute(variant, row, rowHandle);
        if (fn === null) return;
        memos.push(createMemo(fn));
      }
      let tick = 0;
      let sink = 0;
      op = () => {
        tick++;
        setStore(s => {
          for (let i = 0; i < R; i++) s.rows[i].title = tick & 1 ? `r${i}` : `row ${i}`;
        });
        flush();
        for (let i = 0; i < R; i++) sink += memos[i]();
        return sink;
      };
      check = () => memos[3]();
      return;
    }
    const [store, setStore] = createStore({
      v: 1,
      a: { b: { c: { d: 1 } } },
      items: Array.from({ length: R }, (_, i) => ({ id: i, name: i }))
    });
    const handle = HAS_ROOTED ? storeHandle(store) : null;
    const [tick, setTick] = createSignal(0);
    const reads = readLoop(variant, store, handle, workload);
    if (reads === null) return;
    const m = createMemo(
      variant === "rewalk" || variant === "handle"
        ? $(function () {
            perform(tick);
            return reads();
          })
        : () => {
            tick();
            return reads();
          }
    );
    let n = 0;
    let sink = 0;
    op = () => {
      setTick(++n);
      flush();
      sink += m();
      return sink;
    };
    check = () => m();
    void setStore;
  });
  if (!op) {
    dispose();
    return null;
  }
  return { op, dispose, check };
}

const VARIANTS = ["proxy", "rewalk", "handle", "fused", "generic", "inline", "rooted"];
const WORKLOADS = ["shallow", "deep", "dynamic", "list"];

function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function timing() {
  const results = {};
  for (const workload of WORKLOADS) {
    if (ONLY && ONLY !== workload) continue;
    const instances = {};
    for (const variant of VARIANTS) {
      const inst = setup(variant, workload);
      if (inst) instances[variant] = inst;
    }
    // Cross-check: every variant computes the same value.
    const ref = instances.proxy.check();
    for (const [v, inst] of Object.entries(instances)) {
      const got = inst.check();
      if (got !== ref) throw new Error(`${workload}/${v} disagrees: ${got} vs ${ref}`);
    }
    for (const inst of Object.values(instances)) for (let i = 0; i < WARMUP_OPS; i++) inst.op();
    const samples = Object.fromEntries(Object.keys(instances).map(v => [v, []]));
    const order = Object.keys(instances);
    for (let s = 0; s < SAMPLES; s++) {
      // Rotate the order every sample: no variant always runs first/last.
      const rotated = order.map((_, i) => order[(i + s) % order.length]);
      for (const v of rotated) {
        const inst = instances[v];
        const t0 = process.hrtime.bigint();
        for (let i = 0; i < OPS; i++) inst.op();
        const t1 = process.hrtime.bigint();
        // ns per read (list: per row recompute, 2 path reads each)
        samples[v].push(Number(t1 - t0) / OPS / R);
      }
    }
    results[workload] = {};
    for (const [v, xs] of Object.entries(samples)) {
      const sorted = [...xs].sort((a, b) => a - b);
      const median = quantile(sorted, 0.5);
      results[workload][v] = {
        median,
        min: sorted[0],
        p25: quantile(sorted, 0.25),
        p75: quantile(sorted, 0.75),
        iqrPct: ((quantile(sorted, 0.75) - quantile(sorted, 0.25)) / median) * 100,
        samples: xs
      };
    }
    for (const inst of Object.values(instances)) inst.dispose();
  }
  return results;
}

/**
 * Allocation evidence. The parent re-runs this script as a child with
 * `--trace-gc` and a young generation pre-sized (min = max semi-space) so a
 * measurement window fits without a scavenge; the child brackets each window
 * with synchronous stdout markers, and the parent counts the `Scavenge` trace
 * lines between them. heapUsed deltas are only trusted for windows with zero
 * scavenges (reported alongside).
 */
async function allocation() {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const child = spawnSync(
    process.execPath,
    [
      "--expose-gc",
      "--trace-gc",
      "--min-semi-space-size=128",
      "--max-semi-space-size=128",
      fileURLToPath(import.meta.url),
      "--alloc-child",
      ...args.filter(a => a !== "--alloc")
    ],
    { encoding: "utf8", maxBuffer: 1 << 28 }
  );
  if (child.status !== 0) throw new Error(child.stderr || `child exited ${child.status}`);
  const results = {};
  let current = null;
  let scavenges = 0;
  for (const line of child.stdout.split("\n")) {
    if (line.startsWith("@@WINDOW ")) {
      current = line.slice(9);
      scavenges = 0;
    } else if (line.startsWith("@@END ")) {
      const { workload, variant, rep, bytesPerRead } = JSON.parse(line.slice(6));
      ((results[workload] ??= {})[variant] ??= []).push({ rep, bytesPerRead, scavenges });
      current = null;
    } else if (current !== null && /Scavenge/.test(line)) scavenges++;
  }
  for (const byVariant of Object.values(results))
    for (const [variant, reps] of Object.entries(byVariant)) {
      const clean = reps
        .filter(r => r.scavenges === 0)
        .sort((a, b) => a.bytesPerRead - b.bytesPerRead);
      const pick = clean.length ? clean[clean.length >> 1] : reps[0];
      byVariant[variant] = {
        bytesPerRead: pick.bytesPerRead,
        scavenges: pick.scavenges,
        cleanWindows: clean.length,
        windows: reps.length
      };
    }
  return results;
}

async function allocationChild() {
  const { writeSync } = await import("node:fs");
  const WINDOW = Number(opt("window", 20));
  for (const workload of WORKLOADS) {
    if (ONLY && ONLY !== workload) continue;
    for (const variant of VARIANTS) {
      const inst = setup(variant, workload);
      if (!inst) continue;
      for (let i = 0; i < WARMUP_OPS; i++) inst.op();
      for (let rep = 0; rep < 5; rep++) {
        globalThis.gc();
        globalThis.gc();
        writeSync(1, `@@WINDOW ${workload}/${variant}\n`);
        const before = process.memoryUsage().heapUsed;
        for (let i = 0; i < WINDOW; i++) inst.op();
        const after = process.memoryUsage().heapUsed;
        const bytesPerRead = (after - before) / WINDOW / R;
        writeSync(1, `@@END ${JSON.stringify({ workload, variant, rep, bytesPerRead })}\n`);
      }
      inst.dispose();
    }
  }
}

if (args.includes("--alloc-child")) {
  await allocationChild();
  process.exit(0);
}

const meta = {
  node: process.version,
  v8: process.versions.v8,
  cpu: os.cpus()[0]?.model,
  cores: os.cpus().length,
  platform: `${os.platform()} ${os.release()}`,
  samples: SAMPLES,
  ops: OPS,
  warmup: WARMUP_OPS,
  readsPerOp: R,
  rooted: HAS_ROOTED,
  dist: DIST,
  date: new Date().toISOString()
};

const out = {
  meta,
  mode: ALLOC ? "alloc" : "time",
  results: ALLOC ? await allocation() : timing()
};
if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));

// Human-readable table.
for (const [workload, byVariant] of Object.entries(out.results)) {
  const base = byVariant.proxy;
  console.log(`\n${workload}`);
  for (const [v, r] of Object.entries(byVariant)) {
    if (ALLOC) {
      console.log(
        `  ${v.padEnd(8)} ${r.bytesPerRead.toFixed(2).padStart(8)} B/read  scavenges=${r.scavenges}  clean windows ${r.cleanWindows}/${r.windows}`
      );
    } else {
      console.log(
        `  ${v.padEnd(8)} median ${r.median.toFixed(2).padStart(7)} ns/read  min ${r.min
          .toFixed(2)
          .padStart(7)}  IQR ±${(r.iqrPct / 2).toFixed(1).padStart(4)}%  ${(r.median / base.median)
          .toFixed(2)
          .padStart(5)}x proxy`
      );
    }
  }
}
