#!/usr/bin/env node
// Stage 4 (S2 store scalar replacement) end to end: each program below is
// compiled by the native compiler twice — `storeScalars: false` and
// `storeScalars: true` — and both outputs run on the shipped prod runtime.
//
//  1. fired: the replaced output has no `createStore(` left for the stores
//     the program expects replaced; a program the proof must refuse compiles
//     unchanged;
//  2. gate: sink values AND effect-phase run counts after mount and after
//     every op (7 rounds) are identical; ops may be async (actions);
//  3. time: per op, interleaved A/B, median of R reps of K iterations, plus an
//     A/A control. `+fusion` also turns on memoFusion (a replaced field read
//     is an accessor call, so memos over it become fusable).
//
//   taskset -c 2,3 node scripts/heuristics/fusion/stores.mjs [--n 1000] [--reps 15] [--out file]
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, ROOT } from "../common.mjs";

const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 1000);
const REPS = Number(args.reps ?? 15);
const ITER = Number(args.iter ?? 20);
const dir = join(ROOT, "node_modules/.cache/heuristics/stores", String(process.pid));
rmSync(dir, { recursive: true, force: true });
cpSync(join(ROOT, "packages/signals/dist/prod"), join(dir, "runtime"), { recursive: true });
const runtime = pathToFileURL(join(dir, "runtime/index.js")).href;

const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
const compile = (src, storeScalars, memoFusion = false) =>
  transform(src, { filename: "program.jsx", generate: "dom", storeScalars, memoFusion }).code;

// Programs: `make(n)` → { mount, unmount, sink, ops }. `sink.runs` counts
// effect-phase runs.
const HEADER = `import { action, createMemo, createRenderEffect, createRoot, createStore, flush } from "solid-js";`;
const PROGRAMS = {
  // Per-row stores (the JFB row shape): a label and a selected flag.
  rows: {
    replaced: 1,
    source: `${HEADER}
export function make(n) {
  const sink = { runs: 0, last: [] };
  const rows = [];
  let dispose, sel = -1, round = 0;
  return {
    sink,
    mount() {
      createRoot(d => {
        dispose = d;
        for (let i = 0; i < n; i++) {
          const [row, setRow] = createStore({ label: "row " + i, selected: false });
          rows.push({
            rename: (i, round) => setRow(d => { d.label = "row " + i + " #" + round; }),
            deselect: () => setRow(d => { d.selected = false; }),
            toggle: () => setRow(d => { d.selected = !d.selected; }),
            bump: () => setRow(d => { d.label += "!"; })
          });
          const cls = createMemo(() => (row.selected ? "danger" : ""));
          createRenderEffect(() => row.label, v => { sink.runs++; sink.last[2 * i] = v; });
          createRenderEffect(cls, v => { sink.runs++; sink.last[2 * i + 1] = v; });
        }
      });
      flush();
    },
    unmount() { dispose(); rows.length = 0; },
    ops: {
      update10th() {
        round++;
        for (let i = 0; i < rows.length; i += 10) rows[i].rename(i, round);
        flush();
      },
      select() {
        if (sel >= 0) rows[sel].deselect();
        sel = (sel + 7) % rows.length;
        rows[sel].toggle();
        flush();
      },
      bumpAll() {
        for (let i = 0; i < rows.length; i++) rows[i].bump();
        flush();
      }
    }
  };
}`
  },
  // A module-level counter store written by a sync handler and by an async
  // action (transition-held writes must behave the same).
  counter: {
    replaced: 1,
    source: `${HEADER}
const [s, setS] = createStore({ count: 0, step: 1, label: "c" });
const later = action(function* () {
  setS(d => { d.count += 2; });
  yield Promise.resolve();
  setS(d => { d.label = d.label + "+"; d.count++; });
});
export function make(n) {
  const sink = { runs: 0, last: [] };
  let dispose;
  return {
    sink,
    mount() {
      createRoot(d => {
        dispose = d;
        for (let i = 0; i < n; i++)
          createRenderEffect(() => s.count * 10 + s.step, v => { sink.runs++; sink.last[i] = v; });
        createRenderEffect(() => s.label, v => { sink.runs++; sink.label = v; });
      });
      flush();
    },
    unmount() { dispose(); },
    ops: {
      click() { setS(d => { d.count = s.count + 1; d.step = d.step === 1 ? 2 : 1; }); flush(); },
      async act() { const p = later(); flush(); sink.mid = s.count; await p; await Promise.resolve(); flush(); }
    }
  };
}`
  },
  // An escaping store: the proof must refuse it (compiled output unchanged).
  escapes: {
    replaced: 0,
    source: `${HEADER}
export function make(n) {
  const sink = { runs: 0, last: [] };
  let dispose, setter;
  return {
    sink,
    mount() {
      createRoot(d => {
        dispose = d;
        const [s, setS] = createStore({ a: 0 });
        setter = setS;
        sink.snapshot = JSON.stringify(s);
        createRenderEffect(() => s.a, v => { sink.runs++; sink.last[0] = v; });
      });
      flush();
    },
    unmount() { dispose(); },
    ops: { write() { setter(d => { d.a++; }); flush(); } }
  };
}`
  }
};

function write(name, code) {
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, code.replaceAll('"solid-js"', JSON.stringify(runtime)));
  return pathToFileURL(file).href;
}

async function trace(url) {
  const { make } = await import(url);
  const app = make(Math.min(N, 200));
  const out = [];
  app.mount();
  out.push(JSON.stringify(app.sink));
  for (let r = 0; r < 7; r++)
    for (const [k, op] of Object.entries(app.ops)) {
      await op();
      out.push(`${k}:${JSON.stringify(app.sink)}`);
    }
  app.unmount();
  return out;
}

function time(make, opName) {
  const app = make(N);
  let ms;
  if (opName === "mount") {
    app.mount();
    app.unmount();
    const t = performance.now();
    for (let i = 0; i < ITER; i++) {
      app.mount();
      app.unmount();
    }
    ms = performance.now() - t;
  } else {
    app.mount();
    for (let i = 0; i < 3; i++) app.ops[opName]();
    const t = performance.now();
    for (let i = 0; i < ITER; i++) app.ops[opName]();
    ms = performance.now() - t;
    app.unmount();
  }
  return ms / ITER;
}
const median = a => [...a].sort((x, y) => x - y)[a.length >> 1];

const results = [];
let failed = 0;
const count = (code, re) => (code.match(re) ?? []).length;
for (const [name, program] of Object.entries(PROGRAMS)) {
  const plain = compile(program.source, false);
  const replaced = compile(program.source, true);
  const stacked = compile(program.source, true, true);
  const removed = count(plain, /createStore\(/g) - count(replaced, /createStore\(/g);
  if (removed !== program.replaced || (!program.replaced && replaced !== plain)) {
    console.log(`NOT AS EXPECTED ${name}: replaced ${removed}, expected ${program.replaced}\n${replaced}`);
    failed++;
    continue;
  }
  const urls = {
    plain: write(`${name}.plain`, plain),
    replaced: write(`${name}.replaced`, replaced),
    stacked: write(`${name}.stacked`, stacked),
    control: write(`${name}.control`, plain)
  };
  const reference = await trace(urls.plain);
  let ok = true;
  for (const k of ["replaced", "stacked"]) {
    const got = await trace(urls[k]);
    if (JSON.stringify(got) !== JSON.stringify(reference)) {
      const i = got.findIndex((x, j) => x !== reference[j]);
      console.log(`GATE FAIL ${name} (${k}) at step ${i}\n  plain ${reference[i]?.slice(-120)}\n  ${k} ${got[i]?.slice(-120)}`);
      failed++;
      ok = false;
    }
  }
  if (!ok) continue;
  console.log(`gate ok ${name}: ${program.replaced} store(s) replaced, ${reference.length} steps identical (values + effect runs), +fusion too`);
  if (!program.replaced) continue;
  const makes = {};
  for (const [k, url] of Object.entries(urls)) makes[k] = (await import(url)).make;
  const syncOps = Object.entries(makes.plain(1).ops).filter(([, f]) => f.constructor.name !== "AsyncFunction").map(([k]) => k);
  for (const op of ["mount", ...syncOps]) {
    const samples = { plain: [], replaced: [], stacked: [], control: [] };
    const order = ["plain", "control", "replaced", "stacked"];
    for (let r = 0; r < REPS; r++)
      for (const k of r % 2 ? [...order].reverse() : order) samples[k].push(time(makes[k], op));
    const m = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, median(v)]));
    const row = {
      program: name,
      op,
      plainMs: m.plain,
      replacedMs: m.replaced,
      stackedMs: m.stacked,
      controlMs: m.control,
      delta: m.replaced / m.plain - 1,
      deltaStacked: m.stacked / m.plain - 1,
      aa: m.control / m.plain - 1
    };
    results.push(row);
    console.log(
      `${name.padEnd(7)} ${op.padEnd(10)} store ${m.plain.toFixed(3)} ms  signals ${m.replaced.toFixed(3)} ms ${(row.delta * 100).toFixed(1).padStart(6)}%  +fusion ${m.stacked.toFixed(3)} ms ${(row.deltaStacked * 100).toFixed(1).padStart(6)}%  (A/A ${(row.aa * 100).toFixed(1)}%)`
    );
  }
}
if (args.out) {
  mkdirSync(join(ROOT, "documentation/plans/heuristic-oracles"), { recursive: true });
  writeFileSync(args.out, JSON.stringify({ n: N, reps: REPS, iter: ITER, node: process.version, results }, null, 2));
}
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
