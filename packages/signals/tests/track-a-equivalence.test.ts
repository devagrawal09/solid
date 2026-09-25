/**
 * Track A, stage 1 — end-to-end equivalence of handwritten Solid, the `$`
 * runtime driver, transformed `$` (compiler lowering), and optimized `$`
 * (block proofs, with and without host fusion).
 *
 * Each scenario is real source compiled by the native compiler
 * (`@solidjs/compiler`, workspace build) and executed against this
 * package's source. Every variant must produce the same trace; the
 * optimized variants must actually take the status-free path where the
 * scenario is provable, and must not where it is not.
 *
 * Skipped when the native compiler binding has not been built
 * (`pnpm --filter @solidjs/compiler build`).
 */
import { createRequire } from "node:module";
import { transformWithEsbuild } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import * as S from "../src/index.js";
import { GlobalQueue } from "../src/core/scheduler.js";

const require = createRequire(import.meta.url);
let compiler: { transform(code: string, options: object): { code: string } } | null = null;
try {
  compiler = require("../../compiler/index.js");
} catch {
  compiler = null;
}

afterEach(() => {
  S.resetErrorHalt();
  S.flush();
});

type Variant = "handwritten" | "runtime" | "transformed" | "optimized" | "optimizedUnfused";
const VARIANT_OPTIONS: Record<Exclude<Variant, "handwritten">, object> = {
  runtime: { generators: false },
  transformed: {},
  optimized: { blockProofs: true, hostFusion: true },
  optimizedUnfused: { blockProofs: true }
};

/** Compile + evaluate a module exporting `run(log)`. */
async function load(source: string, filename: string, options: object) {
  let code = compiler!.transform(source, { filename, generate: "dom", ...options }).code;
  if (filename.endsWith(".ts")) code = (await transformWithEsbuild(code, filename)).code;
  code = code
    .replace(
      /import\s*\{([^}]*)\}\s*from\s*"@solidjs\/signals";?/g,
      (_, names: string) =>
        `const {${names.replace(/\b(\w+|\$)\s+as\s+([\w$]+)/g, "$1: $2")}} = __S;`
    )
    .replace(/^export\s+/gm, "");
  const factory = new Function("__S", `${code}\nreturn run;`);
  return factory(S) as (log: unknown[]) => unknown;
}

async function traces(scenario: Scenario) {
  const results = {} as Record<Variant, { log: unknown[]; fast: number }>;
  const variants: [Variant, string, object][] = [
    ["handwritten", scenario.handwritten, {}],
    ...(Object.entries(VARIANT_OPTIONS) as [Variant, object][]).map(
      ([variant, options]) => [variant, scenario.block, options] as [Variant, string, object]
    )
  ];
  for (const [variant, source, options] of variants) {
    const run = await load(source, scenario.filename, options);
    const log: unknown[] = [];
    const original = GlobalQueue._recomputeStatusFree!;
    let fast = 0;
    GlobalQueue._recomputeStatusFree = (el, create) => {
      const ran = original(el, create);
      if (ran) fast++;
      return ran;
    };
    try {
      await run(log);
    } finally {
      GlobalQueue._recomputeStatusFree = original;
    }
    results[variant] = { log, fast };
  }
  return results;
}

interface Scenario {
  name: string;
  filename: string;
  handwritten: string;
  block: string;
  /** Whether the optimized variants must take the status-free path. */
  provable: boolean;
}

const HEADER = `import { $, createEffect, createErrorBoundary, createLoadingBoundary, createMemo, createRenderEffect, createRoot, createSignal, flush } from "@solidjs/signals";`;

const SCENARIOS: Scenario[] = [
  {
    name: "flags, identity comparisons and selections",
    filename: "flags.js",
    provable: true,
    handwritten: `${HEADER}
export function run(log) {
  const [filter, setFilter] = createSignal("all");
  const [open, setOpen] = createSignal(false);
  const dispose = createRoot(dispose => {
    const isAll = createMemo(() => filter() === "all");
    const closed = createMemo(() => !open());
    const mode = createMemo(() => (isAll() ? (closed() ? "all/closed" : "all/open") : "some"));
    createRenderEffect(() => mode(), v => { log.push(["mode", v]); });
    createEffect(() => [isAll(), closed()], v => { log.push(["pair", v]); });
    return dispose;
  });
  flush();
  setOpen(true); flush();
  setFilter("done"); flush();
  setFilter("done"); flush();
  setFilter("all"); setOpen(false); flush();
  dispose();
}`,
    block: `${HEADER}
export function run(log) {
  const [filter, setFilter] = createSignal("all");
  const [open, setOpen] = createSignal(false);
  const dispose = createRoot(dispose => {
    const isAll = createMemo($(function* () { return (yield* filter) === "all"; }));
    const closed = createMemo($(function* () { return !(yield* open); }));
    const mode = createMemo($(function* () {
      return (yield* isAll) ? ((yield* closed) ? "all/closed" : "all/open") : "some";
    }));
    createRenderEffect($(function* () { return yield* mode; }), v => { log.push(["mode", v]); });
    createEffect($(function* () { return [yield* isAll, yield* closed]; }), v => { log.push(["pair", v]); });
    return dispose;
  });
  flush();
  setOpen(true); flush();
  setFilter("done"); flush();
  setFilter("done"); flush();
  setFilter("all"); setOpen(false); flush();
  dispose();
}`
  },
  {
    name: "typed arithmetic, templates and conditional dependencies (TypeScript)",
    filename: "typed.ts",
    provable: true,
    handwritten: `${HEADER}
export function run(log: unknown[]) {
  const [a, setA] = createSignal(1);
  const [b, setB] = createSignal(10);
  const [useB, setUseB] = createSignal(false);
  const [unit] = createSignal("px");
  const dispose = createRoot(dispose => {
    const pick = createMemo(() => (useB() ? b() : a()));
    const scaled = createMemo(() => pick() * 2 + 1);
    const label = createMemo(() => \`\${scaled()}\${unit()}\`);
    createRenderEffect(() => label(), v => { log.push(v); });
    return dispose;
  });
  flush();
  setA(2); flush();
  setB(20); flush();
  setUseB(true); flush();
  setA(3); flush();
  setB(21); flush();
  dispose();
}`,
    block: `${HEADER}
export function run(log: unknown[]) {
  const [a, setA] = createSignal(1);
  const [b, setB] = createSignal(10);
  const [useB, setUseB] = createSignal(false);
  const [unit] = createSignal("px");
  const dispose = createRoot(dispose => {
    const pick = createMemo($(function* () { return (yield* useB) ? yield* b : yield* a; }));
    const scaled = createMemo($(function* () { return (yield* pick) * 2 + 1; }));
    const label = createMemo($(function* () { return \`\${yield* scaled}\${yield* unit}\`; }));
    createRenderEffect($(function* () { return yield* label; }), v => { log.push(v); });
    return dispose;
  });
  flush();
  setA(2); flush();
  setB(20); flush();
  setUseB(true); flush();
  setA(3); flush();
  setB(21); flush();
  dispose();
}`
  },
  {
    name: "an unprovable read of a throwing memo routes to the boundary identically",
    filename: "errors.js",
    provable: false,
    handwritten: `${HEADER}
export function run(log) {
  const [fail, setFail] = createSignal(false);
  const dispose = createRoot(dispose => {
    const risky = createMemo(() => { if (fail()) throw new Error("boom"); return 1; });
    const plus = createMemo(() => risky() + 1);
    const shown = createErrorBoundary(() => plus(), err => "caught:" + err().message);
    createRenderEffect(() => shown(), v => { log.push(v); });
    return dispose;
  });
  flush();
  setFail(true); flush();
  dispose();
}`,
    block: `${HEADER}
export function run(log) {
  const [fail, setFail] = createSignal(false);
  const dispose = createRoot(dispose => {
    const risky = createMemo(() => { if (fail()) throw new Error("boom"); return 1; });
    const plus = createMemo($(function* () { return (yield* risky) + 1; }));
    const shown = createErrorBoundary(() => plus(), err => "caught:" + err().message);
    createRenderEffect(() => shown(), v => { log.push(v); });
    return dispose;
  });
  flush();
  setFail(true); flush();
  dispose();
}`
  },
  {
    name: "an unprovable read of a pending memo suspends identically",
    filename: "pending.js",
    provable: false,
    handwritten: `${HEADER}
export async function run(log) {
  let resolve;
  const dispose = createRoot(dispose => {
    const source = createMemo(() => new Promise(r => (resolve = r)));
    const plus = createMemo(() => source() + 1);
    const view = createLoadingBoundary(() => plus(), () => "loading");
    createRenderEffect(() => view(), v => { log.push(v); });
    return dispose;
  });
  flush();
  resolve(41);
  await Promise.resolve(); await Promise.resolve();
  flush();
  dispose();
}`,
    block: `${HEADER}
export async function run(log) {
  let resolve;
  const dispose = createRoot(dispose => {
    const source = createMemo(() => new Promise(r => (resolve = r)));
    const plus = createMemo($(function* () { return (yield* source) + 1; }));
    const view = createLoadingBoundary(() => plus(), () => "loading");
    createRenderEffect(() => view(), v => { log.push(v); });
    return dispose;
  });
  flush();
  resolve(41);
  await Promise.resolve(); await Promise.resolve();
  flush();
  dispose();
}`
  }
];

describe.skipIf(!compiler)("Track A stage 1: handwritten vs transformed vs optimized $", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const results = await traces(scenario);
      const expected = results.handwritten.log;
      expect(expected.length).toBeGreaterThan(0);
      for (const variant of Object.keys(VARIANT_OPTIONS) as Variant[]) {
        expect({ variant, log: results[variant].log }).toEqual({ variant, log: expected });
      }
      // Only the optimized variants may take the status-free path, and they
      // must when the scenario is provable.
      expect(results.handwritten.fast).toBe(0);
      expect(results.runtime.fast).toBe(0);
      expect(results.transformed.fast).toBe(0);
      if (scenario.provable) {
        expect(results.optimized.fast).toBeGreaterThan(0);
        expect(results.optimizedUnfused.fast).toBeGreaterThan(0);
      } else {
        expect(results.optimized.fast).toBe(0);
        expect(results.optimizedUnfused.fast).toBe(0);
      }
    });
  }
});
