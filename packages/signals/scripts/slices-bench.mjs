#!/usr/bin/env node
// Core runtime slicing — hot-path sanity check (not a CodSpeed bench).
//
//   node scripts/slices-bench.mjs [--rounds 7] [--each]   # wall time
//   node scripts/slices-bench.mjs --icount [--each]       # instructions / op
//
// Bundles one benchmark program per runtime slice exactly as
// scripts/slices.mjs does (production defines; switches substituted) and
// runs each bundle in a fresh Node process. The question is only "does
// slicing cost or buy hot-path time?", so the scenarios are the core's three
// hot loops: node creation, write propagation (setSignal → insertSubs → heap
// → recompute → effects) and tracked reads.
//
// Wall time: `rounds` runs, slices interleaved so machine drift hits them
// alike; median per scenario. Instruction counts: the heuristic-oracles
// method (scripts/heuristics/icount.mjs) — valgrind cachegrind, Node
// `--predictable --single-threaded`, identical warmup, (Ir(2·ops) − Ir(ops)) /
// ops cancels startup, bundling and warmup; stable under machine load.
//
// --each: the full runtime with one switch off at a time (attribution).
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FEATURE_NAMES, measure } from "./slices.mjs";

const args = process.argv.slice(2);
const rounds = args.includes("--rounds") ? Number(args[args.indexOf("--rounds") + 1]) : 7;
const icount = args.includes("--icount");

// argv: [scenario, warmup, ops] runs one scenario (icount); none times all.
const PROGRAM = `
import { createSignal, createMemo, createEffect, createRoot, flush } from "SIG";
const SCENARIOS = {
  // 2,000 signals, memos and effects under a root, then dispose.
  create() {
    return () => createRoot(dispose => {
      for (let i = 0; i < 2000; i++) {
        const [s] = createSignal(i);
        const m = createMemo(() => s() + 1);
        createEffect(() => m(), () => {});
      }
      flush();
      dispose();
    });
  },
  // One source, 1,000 memos, 1,000 effects; one write + flush per op.
  update() {
    let set, sink = 0, n = 0;
    createRoot(() => {
      const [s, setS] = createSignal(0); set = setS;
      for (let i = 0; i < 1000; i++) {
        const m = createMemo(() => s() * 2 + i);
        createEffect(() => m(), v => { sink += v; });
      }
      flush();
    });
    return () => { set(++n); flush(); };
  },
  // A memo over 200 signals, recomputed once per op.
  read() {
    let bump, n = 0;
    createRoot(() => {
      const sigs = Array.from({ length: 200 }, (_, i) => createSignal(i));
      const [t, setT] = createSignal(0); bump = setT;
      const sum = createMemo(() => { t(); let x = 0; for (const [g] of sigs) x += g(); return x; });
      createEffect(() => sum(), () => {});
      flush();
    });
    return () => { bump(++n); flush(); };
  }
};
const [scenario, warmup, ops] = process.argv.slice(2);
if (scenario) {
  const op = SCENARIOS[scenario]();
  for (let i = 0; i < +warmup; i++) op();
  for (let i = 0; i < +ops; i++) op();
} else {
  const REPS = { create: 60, update: 200, read: 2000 };
  const out = {};
  for (const [name, setup] of Object.entries(SCENARIOS)) {
    const op = setup();
    for (let i = 0; i < 50; i++) op();
    const t = performance.now();
    for (let i = 0; i < REPS[name]; i++) op();
    out[name] = (performance.now() - t) / REPS[name];
  }
  console.log(JSON.stringify(out));
}
`;

const SLICES = args.includes("--each")
  ? [
      { name: "full", sync: false, off: [] },
      ...FEATURE_NAMES.map(n => ({ name: `full −${n}`, sync: false, off: [n] }))
    ]
  : [
      { name: "full", sync: false, off: [] },
      { name: "full, all switches off", sync: false, off: FEATURE_NAMES },
      { name: "sync", sync: true, off: [] },
      { name: "sync, all switches off", sync: true, off: FEATURE_NAMES }
    ];
const SCENARIOS = ["create", "update", "read"];
// Warmups from the heuristic-oracles harness (flat after tier-up).
const WARMUP = { create: 300, update: 2000, read: 2000 };
const OPS = { create: 40, update: 80, read: 80 };

function ir(file, scenario, ops) {
  return new Promise((resolve, reject) => {
    const child = spawn("valgrind", [
      "--tool=cachegrind",
      "--cache-sim=no",
      "--cachegrind-out-file=/dev/null",
      process.execPath,
      "--predictable",
      "--single-threaded",
      file,
      scenario,
      String(WARMUP[scenario]),
      String(ops)
    ]);
    let err = "";
    child.stderr.on("data", d => (err += d));
    child.on("close", () => {
      const m = /I\s+refs:\s+([\d,]+)/.exec(err);
      if (!m) reject(new Error(`no instruction count:\n${err.slice(-2000)}`));
      else resolve(Number(m[1].replaceAll(",", "")));
    });
  });
}

async function pool(tasks, jobs = 4) {
  const results = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: jobs }, async () => {
      while (next < tasks.length) {
        const i = next++;
        results[i] = await tasks[i]();
      }
    })
  );
  return results;
}

const dir = mkdtempSync(join(tmpdir(), "solid-slices-bench-"));
try {
  for (const slice of SLICES) {
    const r = await measure(PROGRAM.replace("SIG", slice.sync ? "sigsrc-sync" : "sigsrc"), {
      asyncCapability: !slice.sync,
      off: slice.off
    });
    slice.file = join(dir, `${slice.name.replace(/\W+/g, "_")}.mjs`);
    writeFileSync(slice.file, r.code);
  }
  const rows = new Map();
  if (icount) {
    const tasks = [];
    for (const slice of SLICES)
      for (const s of SCENARIOS)
        tasks.push(
          async () => [slice, s, "1", await ir(slice.file, s, OPS[s])],
          async () => [slice, s, "2", await ir(slice.file, s, 2 * OPS[s])]
        );
    const ir1 = new Map();
    for (const [slice, s, k, n] of await pool(tasks)) {
      const key = `${slice.name}|${s}`;
      if (k === "1") ir1.set(key, (ir1.get(key) ?? 0) - n);
      else ir1.set(key, (ir1.get(key) ?? 0) + n);
    }
    for (const slice of SLICES) {
      const row = {};
      for (const s of SCENARIOS) row[s] = ir1.get(`${slice.name}|${s}`) / OPS[s];
      rows.set(slice, row);
    }
  } else {
    const samples = new Map(SLICES.map(s => [s, []]));
    for (let round = 0; round < rounds; round++)
      for (const slice of round % 2 ? [...SLICES].reverse() : SLICES)
        samples
          .get(slice)
          .push(JSON.parse(execFileSync(process.execPath, [slice.file], { encoding: "utf8" })));
    const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];
    for (const slice of SLICES) {
      const row = {};
      for (const s of SCENARIOS) row[s] = median(samples.get(slice).map(x => x[s]));
      rows.set(slice, row);
    }
  }
  const unit = icount ? "instructions / op" : "ms / op";
  console.log(
    `| slice | create (${unit}) | update (${unit}) | read (${unit}) |\n| --- | ---: | ---: | ---: |`
  );
  const base = {};
  for (const slice of SLICES) {
    const row = rows.get(slice);
    const ref = slice.sync ? (base.sync ??= row) : (base.full ??= row);
    const fmt = v => (icount ? Math.round(v).toLocaleString("en-US") : v.toFixed(3));
    const cell = k =>
      `${fmt(row[k])}${row === ref ? "" : ` (${row[k] >= ref[k] ? "+" : ""}${(((row[k] - ref[k]) / ref[k]) * 100).toFixed(1)}%)`}`;
    console.log(`| ${slice.name} | ${cell("create")} | ${cell("update")} | ${cell("read")} |`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
