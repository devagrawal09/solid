#!/usr/bin/env node
/**
 * Compiler cost of strict store paths (Track B, slice 2).
 *
 * Transforms one synthetic strict module — K components, each with a store,
 * typed direct paths, a `Borrowed` row, a handoff and an escape — with:
 *
 *   base     another checkout's compiler (e.g. the pre-slice commit):
 *            `perform(readPath(root, [...]))` lowering
 *   stage1   this compiler, `storeHandles` off: `readPathK` handle readers
 *   stage2   this compiler, `storeHandles` on: handle stores, Borrowed
 *            verification, store summary
 *
 * Usage (release bindings recommended):
 *   node scripts/bench-store-handles.mjs --native <this .node> \
 *     [--base-dir <other checkout>/packages/compiler --base-native <its .node>] \
 *     [--components 200] [--samples 15] [--json out.json]
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { gzipSync, brotliCompressSync, constants } from "node:zlib";
import { transformSync } from "esbuild";

/** Emitted, minified (esbuild), gzip -9 and brotli -q11 bytes of a module. */
function sizes(code) {
  const minified = Buffer.from(
    transformSync(code, { loader: "tsx", minify: true, format: "esm" }).code
  );
  return {
    emitted: code.length,
    minified: minified.length,
    gzip: gzipSync(minified, { level: 9 }).length,
    brotli: brotliCompressSync(minified, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })
      .length
  };
}

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const K = Number(opt("components", 200));
const SAMPLES = Number(opt("samples", 15));
const PER_SAMPLE = Number(opt("per-sample", 5));

function load(dir, native) {
  const require = createRequire(join(dir, "index.js"));
  const previous = process.env.SOLID_COMPILER_NATIVE;
  if (native) process.env.SOLID_COMPILER_NATIVE = native;
  const compiler = require(join(dir, "index.js"));
  if (native) process.env.SOLID_COMPILER_NATIVE = previous ?? "";
  return compiler;
}

export function syntheticModule(k) {
  let out = `import { $, createMemo, createStore, type Borrowed } from "solid-js";
interface Todo { title: string; meta: { done: boolean } }
declare function log(value: unknown): void;
`;
  for (let i = 0; i < k; i++) {
    out += `
function Row${i}(props: { todo: Borrowed<Todo>; label: string }) {
  return $(function* () {
    return <li class={{ done: yield* props.todo.meta.done }}>{yield* props.todo.title}:{yield* props.label}</li>;
  });
}
export function App${i}() {
  const [store, setStore] = createStore({ user: { name: "a", address: { city: "b" } }, rows: [{ title: "x", meta: { done: false } }] });
  const i = 0;
  const name = createMemo($(function* () { return \`\${yield* store.user.name} \${yield* store.user.address.city}\`; }));
  const count = createMemo($(function* () { return (yield* store.rows.length) + (yield* store.rows[i].meta.done ? 1 : 0); }));
  log(store);
  return $(function* () {
    return <div><h1>{yield* name}</h1><Row${i} todo={store.rows[i]} label="x" />{yield* count}</div>;
  });
}
`;
  }
  return out;
}

if (process.argv[1]?.endsWith("bench-store-handles.mjs")) {
  const source = syntheticModule(K);
  const current = load(join(here, ".."), opt("native", null));
  const variants = {
    stage1: code => current.transform(code, { filename: "app.tsx", generate: "dom" }),
    stage2: code =>
      current.transform(code, { filename: "app.tsx", generate: "dom", storeHandles: true })
  };
  const baseDir = opt("base-dir", null);
  if (baseDir) {
    const base = load(baseDir, opt("base-native", null));
    variants.base = code => base.transform(code, { filename: "app.tsx", generate: "dom" });
  }

  const outputs = Object.fromEntries(Object.entries(variants).map(([k, f]) => [k, f(source)]));
  for (const f of Object.values(variants)) for (let i = 0; i < 10; i++) f(source);
  const samples = Object.fromEntries(Object.keys(variants).map(k => [k, []]));
  const order = Object.keys(variants);
  for (let s = 0; s < SAMPLES; s++) {
    for (const k of order.map((_, i) => order[(i + s) % order.length])) {
      const t0 = process.hrtime.bigint();
      for (let i = 0; i < PER_SAMPLE; i++) variants[k](source);
      samples[k].push(Number(process.hrtime.bigint() - t0) / 1e6 / PER_SAMPLE);
    }
  }
  const median = xs => [...xs].sort((a, b) => a - b)[xs.length >> 1];
  const result = {
    meta: {
      node: process.version,
      cpu: os.cpus()[0]?.model,
      components: K,
      sourceBytes: source.length,
      samples: SAMPLES,
      perSample: PER_SAMPLE,
      native: opt("native", "(default loader)"),
      baseNative: opt("base-native", null)
    },
    results: Object.fromEntries(
      Object.entries(samples).map(([k, xs]) => [
        k,
        {
          medianMs: median(xs),
          minMs: Math.min(...xs),
          maxMs: Math.max(...xs),
          outputBytes: outputs[k].code.length,
          ...sizes(outputs[k].code),
          summaryBytes: outputs[k].storeSummary
            ? JSON.stringify(outputs[k].storeSummary).length
            : 0,
          samples: xs
        }
      ])
    )
  };
  const json = opt("json", null);
  if (json) writeFileSync(json, JSON.stringify(result, null, 2));
  console.log(`source ${source.length} B, ${K} components`);
  for (const [k, r] of Object.entries(result.results)) {
    console.log(
      `  ${k.padEnd(7)} median ${r.medianMs.toFixed(2)} ms  min ${r.minMs.toFixed(2)}  max ${r.maxMs.toFixed(
        2
      )}  emitted ${r.emitted} B  minified ${r.minified} B  gzip ${r.gzip} B  brotli ${r.brotli} B  summary ${r.summaryBytes} B`
    );
  }
}
