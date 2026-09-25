// Track A stage-1 benchmark scenarios. Each scenario is a module source
// exporting `setup(S)` → `{ create(), update(), dispose() }`-style hooks
// written twice: handwritten Solid and `$` blocks. The `$` source is compiled
// by the native compiler into the transformed / fused / optimized variants
// (see compile.mjs). All sources import from "@solidjs/signals"; compile.mjs
// points that at the production build (dist/prod).
//
// Shape of every module: `export function make(n)` returns
// `{ mount(), update(), unmount() }`: mount creates n nodes under a root and
// flushes; update performs one write + flush; unmount disposes.

const HEADER = `import { $, createEffect, createMemo, createRenderEffect, createRoot, createSignal, flush } from "@solidjs/signals";`;

/** Provable in any module: `===`, `!`, selections over plain reads. */
const flags = {
  name: "flags",
  description:
    "n memos `(yield* sel) === i` (selection-style predicate) each read by a render effect; update flips the selected index",
  filename: "flags.js",
  handwritten: `${HEADER}
export function make(n) {
  const [sel, setSel] = createSignal(0);
  let dispose, round = 0;
  const sink = { v: 0 };
  return {
    mount() {
      dispose = createRoot(d => {
        for (let i = 0; i < n; i++) {
          const k = i;
          const on = createMemo(() => sel() === k);
          createRenderEffect(() => on(), v => { if (v) sink.v++; });
        }
        return d;
      });
      flush();
    },
    update() { setSel(++round % n); flush(); },
    unmount() { dispose(); }
  };
}`,
  block: `${HEADER}
export function make(n) {
  const [sel, setSel] = createSignal(0);
  let dispose, round = 0;
  const sink = { v: 0 };
  return {
    mount() {
      dispose = createRoot(d => {
        for (let i = 0; i < n; i++) {
          const k = i;
          const on = createMemo($(function* () { return (yield* sel) === k; }));
          createRenderEffect($(function* () { return yield* on; }), v => { if (v) sink.v++; });
        }
        return d;
      });
      flush();
    },
    update() { setSel(++round % n); flush(); },
    unmount() { dispose(); }
  };
}`
};

/** Provable only with typed domains (TypeScript): arithmetic + templates. */
const typed = {
  name: "typed-arith",
  description:
    "n memos `(yield* count) * 2 + 1` feeding n template memos read by render effects (TypeScript: typed primitive domains). A loop-derived constant (`+ k`) would be refused: the prover sees no domain for `const k = i`",
  filename: "typed.ts",
  handwritten: `${HEADER}
export function make(n: number) {
  const [count, setCount] = createSignal(0);
  let dispose: () => void;
  const sink = { v: "" };
  return {
    mount() {
      dispose = createRoot(d => {
        for (let i = 0; i < n; i++) {
          const scaled = createMemo(() => count() * 2 + 1);
          const label = createMemo(() => \`\${scaled()}px\`);
          createRenderEffect(() => label(), v => { sink.v = v; });
        }
        return d;
      });
      flush();
    },
    update() { setCount(c => c + 1); flush(); },
    unmount() { dispose(); }
  };
}`,
  block: `${HEADER}
export function make(n: number) {
  const [count, setCount] = createSignal(0);
  let dispose: () => void;
  const sink = { v: "" };
  return {
    mount() {
      dispose = createRoot(d => {
        for (let i = 0; i < n; i++) {
          const scaled = createMemo($(function* () { return (yield* count) * 2 + 1; }));
          const label = createMemo($(function* () { return \`\${yield* scaled}px\`; }));
          createRenderEffect($(function* () { return yield* label; }), v => { sink.v = v; });
        }
        return d;
      });
      flush();
    },
    update() { setCount(c => c + 1); flush(); },
    unmount() { dispose(); }
  };
}`
};

/** Object results: the full path probes every object for async shape. */
const objects = {
  name: "objects",
  description:
    "n memos returning `[yield* a, yield* b, k]` (object results: the full path's handleAsync probe) read by render effects",
  filename: "objects.js",
  handwritten: `${HEADER}
export function make(n) {
  const [a, setA] = createSignal(0);
  const [b] = createSignal(1);
  let dispose;
  const sink = { v: null };
  return {
    mount() {
      dispose = createRoot(d => {
        for (let i = 0; i < n; i++) {
          const k = i;
          const pair = createMemo(() => [a(), b(), k]);
          createRenderEffect(() => pair(), v => { sink.v = v; });
        }
        return d;
      });
      flush();
    },
    update() { setA(x => x + 1); flush(); },
    unmount() { dispose(); }
  };
}`,
  block: `${HEADER}
export function make(n) {
  const [a, setA] = createSignal(0);
  const [b] = createSignal(1);
  let dispose;
  const sink = { v: null };
  return {
    mount() {
      dispose = createRoot(d => {
        for (let i = 0; i < n; i++) {
          const k = i;
          const pair = createMemo($(function* () { return [yield* a, yield* b, k]; }));
          createRenderEffect($(function* () { return yield* pair; }), v => { sink.v = v; });
        }
        return d;
      });
      flush();
    },
    update() { setA(x => x + 1); flush(); },
    unmount() { dispose(); }
  };
}`
};

/** Control: an unknown call — nothing is provable; optimized must equal fused. */
const unprovable = {
  name: "unprovable",
  description:
    "control: n memos calling an unknown helper (refused by the prover); optimized must not regress",
  filename: "unprovable.js",
  handwritten: `${HEADER}
const format = x => "#" + x;
export function make(n) {
  const [count, setCount] = createSignal(0);
  let dispose;
  const sink = { v: "" };
  return {
    mount() {
      dispose = createRoot(d => {
        for (let i = 0; i < n; i++) {
          const label = createMemo(() => format(count()));
          createRenderEffect(() => label(), v => { sink.v = v; });
        }
        return d;
      });
      flush();
    },
    update() { setCount(c => c + 1); flush(); },
    unmount() { dispose(); }
  };
}`,
  block: `${HEADER}
const format = x => "#" + x;
export function make(n) {
  const [count, setCount] = createSignal(0);
  let dispose;
  const sink = { v: "" };
  return {
    mount() {
      dispose = createRoot(d => {
        for (let i = 0; i < n; i++) {
          const label = createMemo($(function* () { return format(yield* count); }));
          createRenderEffect($(function* () { return yield* label; }), v => { sink.v = v; });
        }
        return d;
      });
      flush();
    },
    update() { setCount(c => c + 1); flush(); },
    unmount() { dispose(); }
  };
}`
};

export const SCENARIOS = [flags, typed, objects, unprovable];

/**
 * Variants. `handwritten` compiles the handwritten source (a no-op for the
 * block pass); the others compile the `$` source (then apply `rewrite`, if
 * any).
 *   transformed       compat lowering (`$(fn)` + perform) — no fusion, no proofs
 *   fused             strict baseline: host fusion (handwritten-equivalent code)
 *   optimized         strict baseline + Track A stage-1 proofs (fusion + statusFree)
 *   optimizedUnfused  compat lowering + proofs ($(fn, flags) + host options)
 */
export const VARIANTS = {
  handwritten: { source: "handwritten", options: {} },
  transformed: { source: "block", options: {} },
  fused: { source: "block", options: { hostFusion: true } },
  optimized: { source: "block", options: { hostFusion: true, blockProofs: true } },
  // Ablation: the same proofs, but every proven host receives `syncOnly`
  // (the SYNC proof alone: the existing `sync: true` path, no status-free
  // module) — isolates what the NOTHROW proof's status erasure adds.
  optimizedSyncOnly: {
    source: "block",
    options: { hostFusion: true, blockProofs: true },
    rewrite: code => code.replace("statusFree as _$statusFree", "syncOnly as _$statusFree")
  },
  optimizedUnfused: { source: "block", options: { blockProofs: true } },
  // Ablation for compat (unfused) output: `$(fn, flags)` keeps BLOCK_SYNC's
  // probe skip, hosts get `syncOnly` instead of the status-free path.
  optimizedUnfusedSyncOnly: {
    source: "block",
    options: { blockProofs: true },
    rewrite: code => code.replace("statusFree as _$statusFree", "syncOnly as _$statusFree")
  }
};
