#!/usr/bin/env node
// Stage 2 (H1 memo fusion) end to end: each program below is compiled by the
// native compiler twice — `memoFusion: false` and `memoFusion: true` — and
// both outputs run on the shipped prod runtime (packages/signals/dist/prod).
//
//  1. fired: the fused output has no `createMemo(` left for the fusable memos
//     and carries `equals: _$isEqual` where the reader is an effect; a program
//     the policy keeps compiles unchanged, and its hand-fused twin (what the
//     pass would emit without that rule) is timed instead, to price the rule;
//  2. gate: sink values AND effect-phase run counts after mount and after
//     every op (7 rounds) are identical between the two outputs;
//  3. time: per op, interleaved A/B, median of R reps of K iterations, plus an
//     A/A control (unfused vs unfused) to size the noise band.
//
//   pnpm --filter @solidjs/signals build:js   (effect `equals` must be in dist)
//   taskset -c 2,3 node scripts/heuristics/fusion/bench.mjs [--n 1000] [--reps 15] [--out file]
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs, ROOT } from "../common.mjs";

const args = parseArgs(process.argv.slice(2));
const N = Number(args.n ?? 1000);
const REPS = Number(args.reps ?? 15);
const ITER = Number(args.iter ?? 20);
const dir = join(ROOT, "node_modules/.cache/heuristics/fusion", String(process.pid));
rmSync(dir, { recursive: true, force: true });
cpSync(join(ROOT, "packages/signals/dist/prod"), join(dir, "runtime"), { recursive: true });
const runtime = pathToFileURL(join(dir, "runtime/index.js")).href;

const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
const compile = (src, memoFusion) =>
  transform(src, { filename: "program.jsx", generate: "dom", memoFusion }).code;

// Programs: `make(n)` → { mount, unmount, sink, ops }. `sink.runs` counts
// effect-phase runs, so a lost cut-off shows up in the gate.
const HEADER = `import { createMemo, createRenderEffect, createRoot, createSignal, flush, isEqual } from "solid-js";`;
const PROGRAMS = {
  // A two-memo chain per row into a render effect (the H1 shape).
  chain: {
    fused: 2,
    source: `${HEADER}
export function make(n) {
  const sink = { runs: 0, last: [] };
  const setters = [];
  let dispose;
  return {
    sink,
    mount() {
      createRoot(d => {
        dispose = d;
        for (let i = 0; i < n; i++) {
          const [count, setCount] = createSignal(i);
          setters.push(setCount);
          const total = createMemo(() => count() * 2);
          const label = createMemo(() => \`\${total()} items\`);
          createRenderEffect(() => label(), v => { sink.runs++; sink.last[i] = v; });
        }
      });
      flush();
    },
    unmount() { dispose(); setters.length = 0; },
    ops: {
      updateAll() { for (let i = 0; i < setters.length; i++) setters[i](v => v + 1); flush(); },
      update10th() { for (let i = 0; i < setters.length; i += 10) setters[i](v => v + 1); flush(); }
    }
  };
}`
  },
  // A narrowing memo whose cut-off matters: most writes leave it unchanged.
  // Kept by the narrowing rule; \`hand\` prices the rule.
  cutoff: {
    fused: 0,
    // What fusion without the narrowing rule would emit.
    hand: src =>
      src
        .replace("const big = createMemo(() => x() > 1000);\n", "")
        .replace("createRenderEffect(() => big(),", "createRenderEffect(() => x() > 1000,")
        .replace("v => { sink.runs++; sink.last[i] = v; });", "v => { sink.runs++; sink.last[i] = v; }, { equals: isEqual });"),
    source: `${HEADER}
export function make(n) {
  const sink = { runs: 0, last: [] };
  const setters = [];
  let dispose;
  return {
    sink,
    mount() {
      createRoot(d => {
        dispose = d;
        for (let i = 0; i < n; i++) {
          const [x, setX] = createSignal(0);
          setters.push(setX);
          const big = createMemo(() => x() > 1000);
          createRenderEffect(() => big(), v => { sink.runs++; sink.last[i] = v; });
        }
      });
      flush();
    },
    unmount() { dispose(); setters.length = 0; },
    ops: {
      smallWrites() { for (let i = 0; i < setters.length; i++) setters[i](v => (v + 1) % 1000); flush(); },
      crossAndBack() {
        for (let i = 0; i < setters.length; i += 10) setters[i](v => v + 2000);
        flush();
        for (let i = 0; i < setters.length; i += 10) setters[i](v => v - 2000);
        flush();
      }
    }
  };
}`
  },
  // Shared source and a narrowing body: kept (both rules) — a selection flag
  // per row, jfb shape.
  select: {
    fused: 0,
    hand: src =>
      src
        .replace("const isSel = createMemo(() => selected() === i);\n", "")
        .replace("createRenderEffect(() => isSel(),", "createRenderEffect(() => selected() === i,")
        .replace("v => { sink.runs++; sink.last[i] = v; });", "v => { sink.runs++; sink.last[i] = v; }, { equals: isEqual });"),
    source: `${HEADER}
export function make(n) {
  const sink = { runs: 0, last: [] };
  const [selected, setSelected] = createSignal(-1);
  let dispose, k = 0;
  return {
    sink,
    mount() {
      createRoot(d => {
        dispose = d;
        for (let i = 0; i < n; i++) {
          const isSel = createMemo(() => selected() === i);
          createRenderEffect(() => isSel(), v => { sink.runs++; sink.last[i] = v; });
        }
      });
      flush();
    },
    unmount() { dispose(); },
    ops: {
      select() { setSelected((k = (k + 7) % n)); flush(); }
    }
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
      op();
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
for (const [name, program] of Object.entries(PROGRAMS)) {
  const plain = compile(program.source, false);
  let fused = compile(program.source, true);
  const removed = (plain.match(/createMemo\(/g) ?? []).length - (fused.match(/createMemo\(/g) ?? []).length;
  const fired = program.fused ? removed === program.fused && fused.includes("equals: _$isEqual") : fused === plain;
  if (!fired) {
    console.log(`NOT AS EXPECTED ${name}: removed ${removed}, expected ${program.fused}\n${fused}`);
    failed++;
    continue;
  }
  // Kept by policy: time the hand-fused twin to price the refusal.
  const variant = program.fused ? "compiled" : "hand";
  if (!program.fused) {
    fused = compile(program.hand(program.source), false);
    if ((fused.match(/createMemo\(/g) ?? []).length !== (plain.match(/createMemo\(/g) ?? []).length - 1)
      throw new Error(`${name}: hand edit did not apply`);
    console.log(`kept ${name}: the pass leaves it unchanged (policy); timing the hand-fused twin`);
  }
  const urls = { plain: write(`${name}.plain`, plain), fused: write(`${name}.fused`, fused), control: write(`${name}.control`, plain) };
  const reference = await trace(urls.plain);
  const got = await trace(urls.fused);
  if (JSON.stringify(got) !== JSON.stringify(reference)) {
    const i = got.findIndex((x, j) => x !== reference[j]);
    console.log(`GATE FAIL ${name} at step ${i}\n  plain ${reference[i]?.slice(0, 200)}\n  fused ${got[i]?.slice(0, 200)}`);
    failed++;
    continue;
  }
  console.log(`gate ok ${name} (${variant}): ${reference.length} steps identical (values + effect runs)`);
  const makes = {};
  for (const [k, url] of Object.entries(urls)) makes[k] = (await import(url)).make;
  for (const op of ["mount", ...Object.keys(makes.plain(1).ops)]) {
    const samples = { plain: [], fused: [], control: [] };
    for (let r = 0; r < REPS; r++)
      for (const k of r % 2 ? ["fused", "control", "plain"] : ["plain", "control", "fused"]) samples[k].push(time(makes[k], op));
    const m = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, median(v)]));
    const row = {
      program: name,
      variant,
      op,
      plainMs: m.plain,
      fusedMs: m.fused,
      controlMs: m.control,
      delta: m.fused / m.plain - 1,
      aa: m.control / m.plain - 1
    };
    results.push(row);
    console.log(
      `${name.padEnd(7)} ${op.padEnd(12)} plain ${m.plain.toFixed(3)} ms  fused ${m.fused.toFixed(3)} ms  ${(row.delta * 100).toFixed(1).padStart(6)}%  (A/A ${(row.aa * 100).toFixed(1)}%)`
    );
  }
}
if (args.out) {
  mkdirSync(join(ROOT, "documentation/plans/heuristic-oracles"), { recursive: true });
  writeFileSync(args.out, JSON.stringify({ n: N, reps: REPS, iter: ITER, node: process.version, results }, null, 2));
}
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
