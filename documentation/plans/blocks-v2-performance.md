# Generator blocks v2 — runtime and bundle cost

Status: measured and optimized (2026-09-27); client lowering landed
(2026-09-28, section 9); lowering gaps closed — async bodies, contexts and
helpers, attribute holes, `$settled`, path readers without `perform`
(2026-09-28, section 10). Companion to
[generator-blocks-v2.md](./generator-blocks-v2.md). Harness: `scripts/blocks-v2/`.

## Summary

Before this work a compiled v2 app paid **1.2–9×** the instructions of the same
program written as plain Solid on the measured paths (event dispatch 9.2×,
effects 2.8×, component creation 2.5×), and **every `solid-js` client bundle
carried the block runtime and the store module** whether or not it used blocks
(a counter app: 81.4 kB min / 25.5 kB gzip).

After:

- **Bundles.** A `solid-js` + `@solidjs/web` app that builds no block is back to
  the pay-for-use floor: the counter is **41.9 kB / 14.1 kB gzip (−49% / −44%)**,
  a plain store app **75.7 kB / 23.6 kB (−8% / −8%)**. A small compiled v2 app is
  **89.7 kB / 27.7 kB (−1.7% / −2.7%)** despite carrying more runtime than
  before (the path-token machinery is now attributed to blocks, not to stores).
- **Compiled v2 vs plain Solid** (instructions per op, n=100 / n=300, default
  lowering): memo 1.09× / 1.00×, component creation 1.67× / 1.54× (was
  2.4×), whole-view re-run 1.14× / 1.08×, JSX holes 1.05×, event dispatch
  1.24× (was 9.2× / 6.8×), effect 1.52× / 1.58× (was 2.8×), path reads 0.99×,
  async memo 1.12× / 1.06×. With `hostFusion`: creation 1.47× / 1.41×, effect
  1.36× / 1.41×, holes 1.03×.
- **Uncompiled v2** (the runtime generator driver): up to ~8× plain Solid
  (creation 7–8×, effects 7–8×, path reads 3×), down from up to 12×; event
  dispatch 12.2× → 1.9×, whole-view re-run 3.2× → 1.8×, memo 1.9× → 1.3×.

Much of what is left in component creation is structural: a v2 component's
view is rendered by its own insert effect, as a plain component that returns
`() => <…/>` is (measured: that alone costs 1.27× plain Solid).

## Methodology

**Programs.** `scripts/blocks-v2/scenarios.mjs` defines eight programs, each
written three ways — handwritten Solid; v2 source; v2 as it must be written
without the compiler's generator pass (a `yield*` cannot sit in a JSX hole, so
the view reads into a `const` first, or passes a bare accessor where that keeps
the hole's granularity) — and compiled four ways:

| variant | source | compiler |
| --- | --- | --- |
| handwritten | plain Solid | JSX only |
| compiled | v2 | default lowering (`generators` on) |
| fused | v2 | default lowering + `hostFusion` |
| uncompiled | v2, driver form | `generators: false` (JSX only); the runtime driver runs every body |
| lazyView (create only) | plain Solid, components return `() => <…/>` | JSX only |

| scenario | one op |
| --- | --- |
| memo | write a signal read by n `$memo`s (n recomputes + n hole updates) |
| create | mount + unmount n components (a signal, a memo, an `$event`, a view with 2 holes) |
| view | write a signal read at the top of n views (n whole-view re-runs) |
| holes | write a signal read by 3 JSX holes in each of n views |
| event | dispatch a click to n `$event`s (read + write their own signal), flush |
| effect | write a signal read by n `$effect`s (+ a prop; `$cleanup` each run) |
| paths | toggle a field of n store rows read as `props.item.done` / `.label` |
| async | write the signal n async memos read, flush, let them settle, flush |

The programs are compiled by the real native compiler (`generate: "dom"`) and
run against `scripts/blocks-v2/fake-web.mjs`, a jsdom-free stand-in for the
parts of `@solidjs/web` the compiled output calls (`insert` renders a `$` block
child through `renderBlock` in a render effect, event handlers that are blocks
are dispatched with `dispatchBlock`, as in `@solidjs/web`), so the measurement
is the reactive and block machinery, not a DOM. `check.mjs` renders every
variant and compares trees and sinks after mount and after three updates; all
variants agree on every scenario, against the dev and the prod runtime.

**Instruction counts** (`icount.mjs`, `compare.mjs`) follow Track A: each cell
runs twice under `valgrind --tool=cachegrind --cache-sim=no`, `node
--predictable --single-threaded`, with the same warmup and `ops` vs `2·ops`
operations; `(twice − once) / ops` is instructions per op with startup, module
load and warmup cancelled. Deterministic: re-running a cell reproduces it to
within a few hundred instructions.

The warmup matters more than it looks. With `--single-threaded`, optimizing
compiles run on the main thread and are counted; with the first warmup (60
updates, 20 ops) the measured window still contained tier-up work, and cells
were inflated up to 2× (the compiled `view` cell measured 710k at 20 ops and
351k at 80). Final settings: 300 update warmups / 60 mount warmups, 50 ops
(30 at n=300). At those settings a cell moves by ≤3% between 50 and 150 ops.

**Noise band.** JIT inlining and GC placement still differ between code
shapes: two variants whose costs are within ~4% can swap order between n=100
and n=300 (the fused vs compiled `memo` cell does: +3% at n=100, −7% at n=300).
Differences under ~5% are reported but not relied on; every headline number
is reproduced at both sizes.

**Wall clock** (`bench.mjs`): fresh process per cell and rep, shuffled order,
forced GC between batches, median of per-process medians. The machine is shared
(other builds running), so wall time is a sanity check of the instruction
counts, not a measurement of its own; the spread column says how noisy.

**Bundles** (`size.mjs`): the #2883 treeshake harness — vite library build of
each fixture with production defines, `@solidjs/signals` resolved to its source
(per-module retention visible), `solid-js` / `@solidjs/web` to their built
browser prod entries, then esbuild minify with `_`-property mangling and gzip
-9. JSX fixtures are compiled by the native compiler first.

**Reproduce.** Build `packages/signals` (prod tree: `node
scripts/blocks-v2/build-prod.mjs [--snapshot name]`), `packages/compiler`, and
for bundles `packages/solid` / `packages/web`; then

```sh
node scripts/blocks-v2/check.mjs                  # every variant renders the same
node scripts/blocks-v2/icount.mjs                 # Ir/op, one runtime, ratios to handwritten
node scripts/blocks-v2/compare.mjs --runtimes before+before-compiler,current
node scripts/blocks-v2/bench.mjs --scenarios event,effect   # wall clock
node scripts/blocks-v2/size.mjs                   # bundle fixtures
node scripts/blocks-v2/profile.mjs create compiled          # self-time profile of a cell
```

(`compare.mjs` / `bench.mjs` runtime names are snapshots under
`node_modules/.cache/blocks-v2/runtimes/`; `name+compiler` pairs one with a
saved compiler binary `runtimes/<compiler>.node`, so "before" rows use the old
compiler too.)

## Baseline (before)

Instructions per op, n=100 (×: vs handwritten).

| scenario | handwritten | compiled | fused | uncompiled |
| --- | ---: | ---: | ---: | ---: |
| memo | 564k | 670k (1.19×) | 670k (1.19×) | 1050k (1.86×) |
| create | 1056k | 2689k (2.55×) | 2689k (2.55×) | 12851k (12.17×) |
| view | 254k | 393k (1.55×) | 393k (1.55×) | 800k (3.15×) |
| holes | 578k | 672k (1.16×) | 672k (1.16×) | 596k (1.03×) |
| event | 276k | 2548k (9.23×) | 2548k (9.23×) | 3368k (12.20×) |
| effect | 268k | 739k (2.76×) | 739k (2.76×) | 2332k (8.70×) |
| paths | 1613k | 1606k (1.00×) | 1606k (1.00×) | 5213k (3.23×) |
| async | 7334k | 8411k (1.15×) | 8411k (1.15×) | 8398k (1.15×) |

`hostFusion` did nothing for v2 (`fused` = `compiled`): the fusion pass only
recognized `createMemo($(fn))`-style hosts.

Bundles (min / gzip, bytes):

| fixture | min | gzip |
| --- | ---: | ---: |
| `@solidjs/signals` core floor (5 primitives) | 23,090 | 9,306 |
| signals + one lowered `$` memo | 29,650 | 11,850 |
| `solid-js` + web counter, no blocks | 81,369 | 25,462 |
| `solid-js` + web app with a store, plain Solid | 82,137 | 25,768 |
| same app, v2 compiled | 91,209 | 28,453 |
| same app, v2 compiled + `hostFusion` | 91,209 | 28,453 |
| same app, v2 uncompiled | 89,818 | 28,062 |

What the bundles dragged in:

- **Every `solid-js` client bundle** carried the block runtime and the store:
  `solid-js`'s client runtime called `setBlockPrimitives({ createSignal,
  createMemo, createStore, createEffect })` at module load. A top-level call can
  never be shaken; it retained `block-api.ts`'s primitives table, and through it
  `createStore` — the whole store module — whose `get` trap references the
  path-token machinery, which references `perform` and the whole operation
  dispatch. The counter app, which uses neither stores nor blocks, paid 39.5 kB.
- **Every store app** retained ~10 kB (unminified) of `generator.ts`: the store
  trap's `pathToken` → token traps → `pathRead` → `readThrough` → `perform` →
  host checks, diagnostics, stepping.
- **Compiled v2 output** imports `$` and `perform`, so it carries the runtime
  driver (`drive` / `step` / `settle` / `resume`: 2.85 kB min / 0.9 kB gzip,
  measured by stubbing it out) even when every body was lowered, the
  typed-props Proxy, and every diagnostic string (`[INVALID_YIELD]`, the
  per-host rule texts, …: 3.0 kB min / 1.2 kB gzip).
- The core floor (the treeshake test's fixture) did not grow: its 265 bytes of
  `generator.ts` are the accessor iterator from the v1 blocks.

## Optimizations

Each row is measured against the state just before it (n=100 unless noted).
Runtime snapshots `r1`…`r6` are kept by `build-prod.mjs --snapshot` so any two
can be compared with `compare.mjs --runtimes a,b`.

### 1. `solid-js`: register block primitives on first use (bundle)

`$signal` / `$memo` / `$store` / `$effect` / `effectBlock` are now `solid-js`
wrappers that register the one hydration-aware primitive they need the first
time they are called; `@solidjs/signals`' constructors reference their default
primitive only at the use site (`primitives.createStore || createStore`).

| fixture | before | after |
| --- | ---: | ---: |
| counter, no blocks | 81,369 / 25,462 | 41,874 / 14,145 (−49% / −44%) |

### 2. Runtime: per-operation allocations (`@solidjs/signals`)

| change | evidence |
| --- | --- |
| Setter receipts: one class with a prototype iterator. The receipt was an object literal with a `*[Symbol.iterator]` method — a new generator *function* (with its own `prototype` object) per write — then stepped as a generator by `perform`. `perform` now returns `receipt.value`. | profile: `receipt` + `stepSync` were 52% of the event scenario; event −87% |
| v2 operations (`$signal`, `$memo`, `$cleanup`, …) are one class sharing the iterator. `op()` was `Object.assign(fields, { delegated, [Symbol.iterator] })`. | profile: `op` 7% of creation |
| `perform`'s non-function branch moved to `performValue`. Its closures (`() => target.target(target.value)`, …) capture the parameter, so V8 allocated a closure context on **every** `perform` call — accessor reads included. | adding an accessor fast path to the old `perform` made `holes` **+48%** (672k → 998k); with the split, the fast path is a win (removing it again: holes +7%, event +7%, memo +4%) |
| A block run tracks path tokens on a shared stack (`tokenBase`), not a fresh array per run. | — |
| One result-shape probe per run, only for object results (was two probes, each a closure + guard + untrack bracket); the probe lives in `objectShape` for the same closure-context reason. | a first version with the closure inside the per-run function made `memo` **+33%** (614k → 818k); split: −8% vs baseline |
| `arguments[0]` instead of a rest parameter in the block wrapper. | no difference in optimized code (818,163 vs 817,985); kept (no array in the lower tiers) |
| Blocks, views and deferred views share one iterator function each (was a generator function allocated per block / per view). | — |
| A split effect's `$cleanup`s are collected lazily with no closure; a single cleanup is returned as is. | — |
| `dispatchBlock` skips `runWithOwner` (a closure) when there is no current owner (the common case: a DOM handler). | — |

Together (old compiler, r3 vs baseline): event −87%, effect −39%, create −20%,
view −13%, holes −10%, memo −8%; uncompiled event −82%, effect −11%, view −10%.

### 3. Compiler: `BLOCK_SYNC` for v2 bodies by default

The v2 pass synthesizes every `_$$(…)` it wraps, and after lowering most of them
provably return plain values (a view returns JSX, a memo arithmetic, an effect
compute an array literal). The Track A prover now runs on v2 bodies by default
(`ProofConfig::v2_only`) and only the SYNC flag is emitted, `$(fn, 1)`: `$`
skips the result-shape probe on every run (verified in dev,
`[BLOCK_SYNC_VIOLATED]`). NOTHROW and host options still need `blockProofs`.

view −16% (343k → 289k), effect −10% (452k → 409k, together with 4).

### 4. Compiler: `PROPS_COMPILED`

After lowering, a `$component(_$$(function (props) {…}))` whose `props` is only
ever argument 0 of a lowered path reader (`_$readPathK(props, …)`) is emitted as
`$component(body, 1)`, and the setup receives the raw props: no Proxy and no
`WeakMap` registration per instance, and — once no typed-props proxy exists in
the app — no proxy unwrap on every path read. Forwarding `props.x`,
destructuring the parameter, or a body left to the driver keeps the proxy.

create −13% (2148k → 1877k; the WeakMap registration alone was 10% of the
creation profile).

### 5. Compiler: host fusion for v2 bodies (`hostFusion`)

`const [a] = _$perform($signal(…))` and `const m = _$perform($memo(…))` now prove
accessors (`$store` a store) for the fusion pass, and three v2 positions fuse:

- `_$perform($memo(_$$(fn)))` in a lowered setup → `_$createMemo(fn)`, with
  `createMemo` imported from the module `$memo` came from (the primitive `$memo`
  creates with — `solid-js`'s hydration-aware one in a `solid-js` app);
- a split `$effect`'s compute block → a plain function (`effectBlock` hands it
  to `createEffect` as is);
- DOM output: `{_$perform(acc)}` as a child of an intrinsic element → `acc()`
  (the child becomes an `insert` effect, where the strict guard is already
  down). Attributes (an `on*` handler is evaluated in the block), component
  props (a getter may be read inside a running block) and reads in the view
  body keep `perform`; SSR output (holes evaluated inline) is untouched.

vs compiled: create −11%, effect −10%, holes −2%, event −2%; memo +3% at n=100
and −7% at n=300 (noise band).

### 6. Pay-for-use path tokens (bundle)

The store's `get` trap calls `makePathToken`, which the first `$` block installs
(the strict guard is only ever raised by a block run, so tokens are unreachable
before one exists). A store app that builds no block drops the tokens and,
through them, `perform` and the dispatch.

| fixture | before | after |
| --- | ---: | ---: |
| store app, plain Solid | 81,828 / 25,649 | 75,704 / 23,623 (−7.5% / −7.9%) |

### 7. Production error codes (bundle)

Block runtime errors keep their message under `__DEV__` and are a bare
`[CODE]` (`[OP_NOT_ALLOWED] <kind>` for host refusals) in production; the
per-host rule texts, host names and `describe` fold away.

| fixture | before | after |
| --- | ---: | ---: |
| v2 app, compiled | 92,594 / 28,875 | 89,591 / 27,661 (−3.2% / −4.2%) |

### 8. Driver: no probe for `function*` bodies, lazy stale marking

A `function*` body returns a fresh native generator on every call, so it is
driven without the shape probe (known at `$` time). `drive` registered a
stale-marking cleanup on every run of every driven block; it is only needed
once the run suspends, so it is registered at the first suspension (always
inside the synchronous `drive` call, under the run's owner).

Uncompiled (r4 → r6): view −37%, memo −20%, event −14%, create −14%, effect −7%,
paths −5%.

## After

Instructions per op; before = baseline runtime + baseline compiler.

n=100:

| scenario | handwritten | compiled | fused | uncompiled |
| --- | ---: | ---: | ---: | ---: |
| memo | 564k | 614k (1.09×, was 1.19×) | 632k (1.12×) | 781k (1.38×, was 1.86×) |
| create | 1056k | 1879k (1.78×, was 2.55×) | 1667k (1.58×) | 11302k (10.70×, was 12.17×) |
| view | 254k | 289k (1.14×, was 1.55×) | 289k (1.14×) | 456k (1.80×, was 3.15×) |
| holes | 578k | 608k (1.05×, was 1.16×) | 596k (1.03×) | 596k (1.03×) |
| event | 276k | 341k (1.24×, was 9.23×) | 333k (1.21×) | 532k (1.93×, was 12.20×) |
| effect | 269k | 409k (1.52×, was 2.76×) | 367k (1.36×) | 1917k (7.13×, was 8.70×) |
| paths | 1613k | 1594k (0.99×) | 1594k (0.99×) | 4880k (3.03×, was 3.23×) |
| async | 7308k | 8214k (1.12×, was 1.15×) | 8205k (1.12×) | 8219k (1.12×) |

create, structural share (150 ops): `lazyView` (plain components rendered
through a function child, as a v2 view is) costs 1312k — 1.27× plain Solid. Of
the compiled v2 gap (688k per 100 components), 282k is that and 406k block
machinery (fused: 198k).

n=300 (30 ops; the memo row's handwritten cell itself moved +8% between the
two runs — this is the noise band, not a change):

| scenario | handwritten | compiled | fused | uncompiled |
| --- | ---: | ---: | ---: | ---: |
| memo | 1823k | 1832k (1.00×, was 1.17×) | 1709k (0.94×) | 2335k (1.28×, was 1.85×) |
| create | 3337k | 5153k (1.54×, was 2.43×) | 4716k (1.41×) | 23104k (6.92×, was 9.03×) |
| view | 747k | 807k (1.08×, was 1.49×) | 807k (1.08×) | 1315k (1.76×, was 3.00×) |
| holes | 1763k | 1852k (1.05×, was 1.16×) | 1816k (1.03×) | 1816k (1.03×, was 1.03×) |
| event | 789k | 981k (1.24×, was 6.76×) | 958k (1.21×) | 1554k (1.97×, was 8.83×) |
| effect | 730k | 1155k (1.58×, was 2.89×) | 1028k (1.41×) | 5727k (7.85×, was 9.56×) |
| paths | 4859k | 4776k (0.98×, was 0.99×) | 4776k (0.98×) | 14620k (3.01×, was 3.21×) |
| async | 45261k | 48057k (1.06×, was 1.07×) | 48015k (1.06×) | 48057k (1.06×, was 1.07×) |

Creation allocates the most, so its cell is the most sensitive to where a GC
lands in the measured window; at n=100 with 150 ops (instead of 50) it reads:
handwritten 1030k, lazyView 1312k (1.27×), compiled 1718k (1.67×, was 2.39×),
fused 1510k (1.47×), uncompiled 8350k (8.1×, was 9.8×). The ratios move by a
few points; the ordering and the size of the win do not.

Wall clock, µs per op (n=100, 5 reps × 15 samples, median; ± is half the
max/min spread of the per-process medians). The machine was shared, so some
cells are noisy; the direction and rough size of every change match the
instruction counts. Wall-time ratios to plain Solid are larger than the
instruction ratios (e.g. compiled event 1.8× vs 1.24×): allocation and GC cost
more per instruction than the reactive core's loops.

| cell | before | after |
| --- | ---: | ---: |
| memo handwritten | 45.4 (±3%) | 44.8 (±51%) |
| memo compiled | 61.0 (±60%) | 52.1 (±6%) |
| memo fused | 56.8 (±4%) | 46.1 (±5%) |
| memo uncompiled | 172.5 (±9%) | 107.8 (±5%) |
| create handwritten | 128.0 (±53%) | 121.9 (±13%) |
| create compiled | 433.9 (±24%) | 260.0 (±14%) |
| create fused | 425.3 (±25%) | 249.8 (±44%) |
| create uncompiled | 1159.4 (±27%) | 953.2 (±27%) |
| view handwritten | 22.1 (±1%) | 22.2 (±5%) |
| view compiled | 42.3 (±36%) | 26.7 (±2%) |
| view fused | 42.9 (±8%) | 26.2 (±5%) |
| view uncompiled | 139.5 (±15%) | 89.9 (±8%) |
| event handwritten | 21.3 (±4%) | 21.8 (±3%) |
| event compiled | 188.2 (±6%) | 40.1 (±19%) |
| event fused | 193.6 (±26%) | 39.8 (±32%) |
| event uncompiled | 307.1 (±5%) | 73.0 (±79%) |
| effect handwritten | 21.8 (±45%) | 21.4 (±3%) |
| effect compiled | 97.6 (±7%) | 50.2 (±13%) |
| effect fused | 91.5 (±5%) | 44.2 (±21%) |
| effect uncompiled | 454.1 (±10%) | 422.6 (±6%) |

Bundles (min / gzip):

| fixture | before | after |
| --- | ---: | ---: |
| `@solidjs/signals` core floor | 23,090 / 9,306 | 23,090 / 9,306 |
| signals + one lowered `$` memo | 29,650 / 11,850 | 27,812 / 11,022 (−6% / −7%) |
| counter, no blocks | 81,369 / 25,462 | 41,874 / 14,145 (−49% / −44%) |
| store app, plain Solid | 82,137 / 25,768 | 75,704 / 23,623 (−8% / −8%) |
| same app, v2 compiled | 91,209 / 28,453 | 89,685 / 27,692 (−2% / −3%) |
| same app, v2 compiled + `hostFusion` | 91,209 / 28,453 | 89,246 / 27,597 (−2% / −3%) |
| same app, v2 uncompiled | 89,818 / 28,062 | 88,190 / 27,291 (−2% / −3%) |

The marginal cost of blocks in the small app is now 14.0 kB min / 4.1 kB gzip
over the same app in plain Solid (it was 9.1 / 2.7 before, but 6.1 / 2.0 of the
plain app's bytes were block machinery it did not use). Of `generator.ts`'s
retained code (unminified), the driver is ~3.5 kB, the path tokens ~2.4 kB,
`perform` and its dispatch ~3.4 kB.

## 9. Client lowering (2026-09-28)

Recommendations 1–3 below, and the effect-half fusion from "Evaluated and not
done", landed as one compiler pass plus compiled-only runtime entry points.
Compiler: `packages/compiler/src/blocks_v2_lower.rs` (DOM output), the default
v2 fusion (`generators.rs`, `compiler.rs`) and the control-flow effect split
(`blocks_v2.rs`). Runtime: `syncBlock`, `blockCleanup`, `withReceipts`,
`$componentCompiled`, `$eventCompiled` (+ `dispatchFused`),
`effectBlockCompiled`, `settledBlockCompiled` in `@solidjs/signals`, re-exported
by `solid-js` (whose `effectBlockCompiled` registers the hydration-aware
`createEffect`, as `effectBlock` does).

What the compiled `$component` of the size fixture becomes (`APP_V2`):

```js
const App = $componentCompiled(function () {            // setup block erased
  const [count, setCount] = createSignal(0);             // was _$perform($signal(0))
  const [store, setStore] = createStore({ items: [...] });
  const doubled = createMemo(function () { return count() * 2; });
  createEffect(function () { return [count()]; },        // was $effect(_$$(half), _$$(compute))
    function (_$v) { const c = _$v[0]; document.title = "count " + c;
      const _$cleanup0 = () => { document.title = ""; }; return _$cleanup0; });
  const inc = $eventCompiled(function () { setCount(count() + 1); });  // event block erased
  return _$$(function () { /* the view: still a block */ }, 1);
});
// import { syncBlock as _$$, createSignal, createStore, createMemo, createEffect,
//          $componentCompiled, $eventCompiled } from "solid-js"   — no `$`, no `perform`
```

The pieces, each exact by construction (anything unproven stays as lowered):

| change | why it is the same program |
| --- | --- |
| v2 host fusion on by default (`hostFusion: false` opts out; `true` also fuses plain `$` blocks) | the existing proof-driven fusion, restricted to the bodies the v2 pass synthesized; runs on every generate, so hydration ids agree |
| setup creations → direct primitive calls from the constructor's module (`$signal` → `createSignal`, `$store` → `createStore`, `$memo(block)` → `createMemo(block)`, `$effect` → `effectBlock`, `$settled` → `settledBlock`, `$cleanup` → `blockCleanup`, `$flush()` → `flush()`) | `perform` of a `create` / `cleanup` / `flush` op is its host check (the compile-time host rules already did it) plus the `make` call; the primitives do no reactive read outside their own computations, so the setup's raised guard is unobservable. Only at the body's own depth (a nested callback may run under another host) |
| a `$signal` / `$store` setter is the primitive's own setter unless it escapes; `_$perform(set(x))` → `set(x)`, or `set(x).value` for a receipt setter | a setter returns the written value, which is exactly the receipt's `value`; `perform` reads a receipt's value before any host check. A setter escapes when a use is not a call whose result is discarded or performed (`() => set(x)` returns it; `withReceipts` keeps the receipts) |
| `_$perform(raise(e));` → `throw e;` (memo, effect, event) | the host admits `raise`; `perform` throws it |
| fused effect half: `effectBlock(_$$(half, SYNC), compute)` → `createEffect(compute, half')` | when the half passes the fusion's body check, registers `$cleanup` only as top-level statements and never `return`s: `runEffectHalf` collects exactly those and returns the one cleanup, or a function running them in order |
| `$event(_$$(fn, SYNC))` → `$eventCompiled(fn)` when the body check passes (proven-accessor reads become calls) | `dispatchFused` keeps the handler contract of `dispatchBlock` (no owner context, failures to the boundary above the creation owner); nothing is left to run under the event host |
| setup `_$$(fn, SYNC)` erased (`$componentCompiled(fn)`) when no operation is left (nested blocks are their own bodies) and every `return` is a block | the setup runs untracked either way; with no operation left, neither the host nor the guard is observable |
| `_$$` imported as `syncBlock` when every block of the module is lowered and SYNC | `syncBlock` is `$`'s SYNC wrapper without the driver branches and the generator-body hook |
| the effect split keeps control flow (`if`/`else`, `?:`, `&&`, `\|\|`, `??`, early `return`) | the compute reads a slot only under the body's condition, evaluated over compute values and never-written outer bindings; an unevaluable condition is dropped (never inverted), so reads are a superset of the body's, never a subset. Compiled `blocks-effect` is now `=` handwritten Solid in the conformance matrix (was `≠ declared`) |

Only SYNC-flagged blocks are erased (a flagged `$` call is never wrapped in a
hydration id scope, `block_scope.rs`), a setup returning its view block is now
proven SYNC on every generate, and every primitive is created in the same
order, so client-only erasure keeps hydration ids aligned with the server.

**Instructions per op, n=100** (before = baseline runtime + compiler of
section "After", measured again on this machine; after = final runtime +
compiler; × = vs handwritten):

| scenario | handwritten | compiled before | compiled after | uncompiled before → after |
| --- | ---: | ---: | ---: | ---: |
| memo | 609k | 730k (1.20×) | 618k (1.01×, −15.3%) | 827k → 827k |
| create | 1122k | 1966k (1.75×) | 1657k (1.48×, −15.7%) | 11300k → 11259k |
| view | 272k | 310k (1.14×) | 321k (1.18×, +3.8%)¹ | 475k → 475k |
| holes | 648k | 677k (1.05×) | 665k (1.03×, −1.7%) | 669k → 670k |
| event | 306k | 370k (1.21×) | 322k (1.05×, −13.0%) | 561k → 572k (+1.9%)² |
| effect | 273k | 427k (1.56×) | 290k (1.06×, −32.0%) | 1934k → 1934k |
| paths | 1642k | 1623k (0.99×) | 1623k (0.99×) | 4901k → 4905k |
| async | 7372k | 8253k (1.12×) | 8259k (1.12×) | 8258k → 8258k |

`fused` (`hostFusion: true`) is now identical to `compiled` on every scenario
(the programs have no plain `$` block). The new `unfused` variant
(`hostFusion: false`, the opt-out) reproduces the old default on the new
runtime: memo 729k, create 1979k, view 309k, holes 679k, event 370k, effect
426k, paths 1623k, async 8253k.

n=300 (30 ops):

| scenario | handwritten | compiled before | compiled after |
| --- | ---: | ---: | ---: |
| memo | 1894k | 2028k (1.07×) | 2070k (1.09×, +2.1%)³ |
| create | 3536k | 5417k (1.53×) | 4673k (1.32×, −13.7%) |
| view | 800k | 869k (1.09×) | 904k (1.13×, +4.0%)¹ |
| holes | 1926k | 2016k (1.05×) | 1981k (1.03×, −1.7%) |
| event | 917k | 1070k (1.17×) | 901k (0.98×, −15.8%) |
| effect | 783k | 1207k (1.54×) | 839k (1.07×, −30.4%) |
| paths | 4919k | 4899k (1.00×) | 4899k (1.00×) |
| async | 45480k | 48264k (1.06×) | 48232k (1.06×) |

³ The memo cell's known noise band (section "After": it swapped order between
n=100 and n=300 before too); at n=100 it is −15.3%. The compiled memo program
is the same code as handwritten apart from the erased setup, so the remaining
difference is the component/view structure, not the memo.

¹ A microbenchmark artifact of the erased setup, not a cost: in `view` the
only body the block wrapper ever runs is the view, and V8's code for the
monomorphic wrapper is slower. The same compiled program with one other block
body run anywhere in the module measures 305k (A/B in the same process
configuration: 321k erased setup, 305k with the setup kept as a block, 305k
with the erased setup plus one unrelated block) — below the 310k before. Any
real app runs more than one body through the wrapper.
² Within the ~5% noise band but reproducible, with the old and the new
compiler alike (a runtime effect). No function on the uncompiled event path
changed; reverting the `$signal` tuple construction did not move it, and the
remaining candidates (new exports and helpers beside that path) were not
bisected further. A branding helper shared by `$` and `syncBlock` cost
uncompiled `paths` +3.5% and was reverted (blocks are branded inline).

**Bundles** (min / gzip, bytes; before = the same harness on the baseline):

| fixture | before | after |
| --- | ---: | ---: |
| signals + one lowered `$` memo | 28,098 / 11,122 | 28,098 / 11,122 |
| store app, plain Solid | 75,750 / 23,631 | 75,750 / 23,631 |
| same app, v2 compiled | 90,007 / 27,791 | 84,751 / 26,260 (−5.8% / −5.5%) |
| same app, v2 compiled, `hostFusion: false` (opt-out) | — | 90,172 / 27,835 |
| same app, v2 compiled, lowered but `$` kept (driver retained) | — | 88,319 / 27,303 |
| same app, v2 uncompiled | 88,898 / 27,512 | 89,059 / 27,553 (+0.2% / +0.1%) |
| `examples/sync-blocks` (fully lowered, `syncBlock`) | 64,085 / 23,308 | 60,883 / 22,145 (−5.0% / −5.0%) |
| `examples/todos-blocks` (async events and a `yield* useTodos()` helper keep `$`) | 92,034 / 32,984 | 91,944 / 32,917 |

After merging core runtime slicing (block renderer install-on-use, store
forms; same harness, same day):

| fixture | min / gzip |
| --- | ---: |
| store app, plain Solid | 67,362 / 21,379 |
| same app, v2 compiled (default) | 77,615 / 24,330 |
| same app, v2 compiled, lowered but `$` kept | 81,107 / 25,364 |
| same app, v2 compiled, `hostFusion: false` | 82,985 / 25,889 |
| same app, v2 uncompiled | 81,872 / 25,608 |
| `examples/sync-blocks` | 55,318 / 20,321 |
| `examples/todos-blocks` | 92,125 / 32,998 |

(the lowered `$store` creates with `createPlainStore`, as `$store` itself now
does; `syncBlock` installs the block renderer hooks as `$` does).

Attribution for the v2 app (numbers before the merge): the client lowering itself (direct creations,
fused halves, erased blocks, no operation objects) is 1.9 kB min / 0.5 kB gzip
(90,172 → 88,319); dropping the driver is 3.6 kB min / 1.0 kB gzip
(88,319 → 84,751 — `drive` / `step` / `settle` / `resume`, `$`, the
generator-body hook). The marginal cost of blocks in the small app is now
9.0 kB min / 2.6 kB gzip over the same app in plain Solid (was 14.3 / 4.2). The
uncompiled app pays +161 / +41 bytes for the shared component / effect
helpers. `perform` itself is still retained by a fully compiled app: the path
readers' token fallback and `readThrough` (reading through an accessor found
at a path) reference it.

**Not done:**

- A slimmer `perform` for operand kinds the compiler can name (recommendation 2,
  second half). After this pass the benchmark programs contain no `perform`
  except one view-top read in `view` (a proven accessor under the view's raised
  guard); a named reader would save the operand type test on that read only,
  and `perform` stays in bundles through the path readers. Not measurable.
- Attribute holes (`<input value={yield* draft}>` compiles to an `effect`
  whose compute is `_$perform(draft)`) keep `perform`: which attributes the JSX
  transform turns into effects (vs. evaluated inline: `on*`, `ref`, directives,
  `@static`) is decided after this pass. (Done in section 10.)
- Events and setups that read context (`yield* Ctx`) or call helpers keep their
  block (the context read needs the component host); their creations are
  direct regardless. Async `attempt` bodies keep `$` and the driver. (Done in
  section 10 for context reads, context-only helpers and async bodies.)
- `$settled` bodies stay blocks (`settledBlockCompiled`); fusing them like
  effect halves is possible but not measured by any scenario. (Done in
  section 10.)
- The linker (`@solidjs/compiler/capabilities`) reasons about authored source,
  so the new compiler-emitted names need no feature facts; if a compiled-output
  analysis is added, `syncBlock` and the `…Compiled` entries belong under the
  block feature.

## 10. Closing the lowering gaps (2026-09-28)

Section 9 left four things on the driver or on `perform` in fully compiled
apps: async `attempt` bodies, context reads and helper generators, attribute /
prop holes, and the path readers' references to `perform`. This pass closes
them, plus `$settled` fusion and one import defect. `examples/todos-blocks` now
ships **no generator driver** and its linker switches `ITERABLE` off; nothing in
a fully compiled bundle references `perform`.

Compiler: `generators.rs` ("async v2 bodies"), `blocks_v2_lower.rs` (sections 5–8
of its module doc, `fuse_computation_reads`), `block_proofs.rs`
(`plain_components`), `store_forms.rs`. Runtime (`@solidjs/signals`, re-exported
by `solid-js`): `asyncBody` / `AsyncRun`, `readAccessor`, `readSelected`,
`readContext`, `dispatchFused` (thenable results), path readers without
`perform`.

| gap | what landed | why it is the same program |
| --- | --- | --- |
| 1. attribute / prop holes | In every lowered v2 body, `_$perform(acc)` of a proven accessor → `_$readAccessor(acc)`, `_$perform(readStore(s, sel))` → `_$readSelected(s, sel)`. After the DOM JSX transform, inside the computations it created (`effect(compute, …)`, `insert(el, compute, …)`, `memo(compute)` from the renderer module, at the compute's own depth) those become `acc()` / `sel(s)`. A component prop getter keeps the helper. | `readAccessor` is `perform`'s accessor branch (the read with the guard lowered); `readSelected` is `perform(readStore(…))` (token consumed, host check, selector with the guard lowered) without the operation object. A computation run lowers the guard itself (`recompute`), so inside one the call is the read — the argument section 9 made for `insert` children, extended to the transform's attribute effects. |
| 2. `$settled` | `settledBlock(_$$(fn, SYNC))` → `onSettled(fn')` when the body passes the effect-half conditions (top-level `$cleanup`s only, no `return`, no parameter, no JSX): the cleanups become the returned cleanup. | `settledCallback` runs the block under the effect host and returns what `runEffectHalf` collected: exactly the fused body's return. `onSettled` calls the callback with no argument, as the block got `undefined`. |
| 3. context reads | In a setup, `_$perform(Ctx)` of `const Ctx = createContext(…)` (a runtime import) → `_$readContext(Ctx)`; a setup with no other operation loses its block (`$componentCompiled(fn)`). | `perform(Ctx)` steps the context iterator, which yields one context operation: host check (admitted at compile time: only a setup reads context) and `readGuarded(reader ?? getContext(Ctx))` — `readContext`'s body. |
| 4a. helper generators | A module-local, non-exported `function*` whose every `yield*` reads a proven context, and whose every reference is `_$perform(helper(…))` directly in a lowered setup, becomes a plain function (`yield* Ctx` → `readContext(Ctx)`), called directly: `const [, { addTodo }] = useTodos();`. | `perform` of the helper's generator steps it under the setup's host, performing each context read in order and returning the generator's return value; parameters are bound at the call either way, and nothing runs between the call and the `perform`. |
| 4b. async memo / event bodies | Client output: a `$memo` / `$event` (or generator `createMemo`) body whose only operations the call form cannot run are its `yield* attempt(…)`s compiles to `async function (input, _$a) { try { … } catch (_$e) { _$a.x(_$e); } }`, each attempt to `(_$a.t(ARGS) ? _$a.r(await _$a.p) : _$a.v)` and each `return v` to `return _$a.ret(v)`. When the body check passes, `$event(_$$(fn))` → `$eventCompiled(asyncBody(fn))` and `createMemo(_$$(fn))` → `createMemo(asyncBody(fn))`; otherwise the generator is restored exactly (`yield*`s, parameters and all) and runs on the driver as before. | Point by point in `generator.ts` ("compiled async bodies"): `t` runs the attempt with the driver's error unwrapping and awaits only a thenable, so a body whose attempts return plain values completes synchronously, and `asyncBody` hands back its value / throws its error synchronously; the first suspension registers staleness on the running owner, a superseded run never resumes (`[BLOCK_SUPERSEDED]`) and its rejection is reported as superseded; the continuation runs in the settled promise's reaction, the microtask the driver's `then` callback runs in. Memo bodies are refused when an `attempt` sits in a `try` (the driver closes a superseded generator, running only `finally`) or a loop, or a read follows the first `attempt` (`[READ_AFTER_WAIT]`). Bodies with JSX (hydration id scopes) and with more than one parameter, a default or a rest are refused. Only difference: with two or more suspensions, the driver's result promise adopts each step's promise (two extra microtasks per suspension); the async function's settles when the body returns. Server output keeps the driver. |
| 5. duplicate `createPlainStore` import | `storeForms` reuses an existing `createPlainStore` specifier from the same module (the lowered `$store`'s), else adds `_$createPlainStore` (suffixed when taken). The lowering's `_$plainStore` workaround is gone. | Import bookkeeping only. |
| 6. `perform` via the path readers | The token fallback of `readPath1…4` / `readPathN` is `readTokenPath` (the path operation's host check and guarded walk); `readThrough` reads a readable found at a path with `readFunction` (accessor, view, block, or an iterable stepped operation by operation) instead of `perform`. | `readTokenPath(root, keys)` is `perform(readPath(root, keys))` without the dispatch. `readFunction` is `perform`'s function branch, except that an iterable yielding something other than an operation fails with `[INVALID_YIELD]` (the driver's verdict for the same iterable) where `perform` would dispatch on the yielded value — the one semantic difference in this section, for malformed iterables only. |

Also: a view returning a `solid-js` flow component (`Show`, `For`, `Switch`,
`Repeat`, `Loading`, `Errored`) is now proven `BLOCK_SYNC` (each renders a
function: a memo / list accessor, a boundary accessor, or a deferred view
thunk; verified in dev by `[BLOCK_SYNC_VIOLATED]`). Before, `todos-blocks`'
`MainSection` and `Footer` views kept `$` for that reason alone. Such a view is
flagged on both generates, and Track E's `block_scope.rs` scopes flagged views
on both sides, so hydration ids are unaffected (hydrate config and the islands
example pass). Effect halves and settled bodies with JSX are no longer fused
(the server scopes them).

What `todos-blocks`' `app.tsx` compiles to now (excerpt):

```js
function useTodos() {                                  // was function* + _$perform(useTodos())
  const value = _$readContext(TodosContext);
  if (!value) throw new Error("TodosContext is not provided");
  return value;
}
const TodoItem = _$$componentCompiled(function (props) { // setup block erased
  const [, { toggleTodo, removeTodo, retryTodo }] = useTodos();
  const toggle = _$$eventCompiled(_$asyncBody(async function (e, _$a) {
    try {
      const id = _$readPath2(props, "todo", "id");
      _$a.t(() => toggleTodo(id, e.currentTarget.checked)) ? _$a.r(await _$a.p) : _$a.v;
    } catch (_$e) { _$a.x(_$e); }
  }));
  …
// MainSection's view (was `$`, now proven SYNC → syncBlock):
//   get when() { return _$readSelected(todos, (t) => t.length) > 0; }
//   get each() { return _$readAccessor(filtered); }
//   _$effect(() => allCompleted(), (_v$) => { _el$11.checked = _v$; });   // was _$perform(allCompleted)
// import { syncBlock as _$$, … } from "solid-js"   — no `$`, no `perform`, no `yield*`
```

`filter.ts` holds `onSettled(function* …)`; the example's Vite config now
routes `.ts` modules through the compiler (`extensions: [[".ts", { typescript:
true }]]`). Before, that module ran uncompiled and relied on `$` (called at
module load by `app.tsx`) having installed the generator hook; an app whose
compiled modules never call `$` must compile every module with a block (the
`[GENERATOR_BODY]` dev error names the case).

**Instructions per op** (before = the section 9 runtime and compiler; after =
this change; × = vs handwritten). Two scenarios are new to the harness:
`attrs` (n views with an attribute and a hole reading one signal) and
`asyncEvent` (n handlers that read their signal, wait for a resolved promise,
then write it).

| scenario, n=100 | handwritten | compiled before | compiled after |
| --- | ---: | ---: | ---: |
| asyncEvent | 402k | 925k (2.30×) | **550k (1.37×, −40.5%)** |
| async (memos) | 7371k | 8243k (1.12×) | **7942k (1.08×, −3.7%)** |
| attrs | 449k | 461k (1.03×) | 458k (1.02×, −0.7%) |
| view | 272k | 321k | 316k (−1.7%) |
| memo, create, holes, event, effect, paths | | | ±0.2% (no program in them uses what changed) |

| scenario, n=300 (30 ops) | handwritten | compiled before | compiled after |
| --- | ---: | ---: | ---: |
| asyncEvent | 1101k | 2664k (2.42×) | **1549k (1.41×, −41.9%)** |
| async (memos) | 45480k | 48239k (1.06×) | 47361k (1.04×, −1.8%) |
| attrs | 1357k | 1396k (1.03×) | 1385k (1.02×, −0.7%) |

The handwritten `effect` cell moved +4.7% (273k → 286k) between the section 9
runtime and this branch's base (Track E, measured with that base's runtime
snapshot); this change moves no handwritten cell. The remaining `asyncEvent`
cost over handwritten is the handler contract (`dispatchFused`: owner
bracket, boundary routing of the returned promise) and the run object; the
driver's generator, operation objects and host bracket per step are gone.

**Bundles** (min / gzip bytes; before = this branch's base, `ce813167`, same
harness, same day):

| fixture | before | after |
| --- | ---: | ---: |
| `examples/todos-blocks`, linker (sliced) | 91,920 / 32,963 | **89,888 / 32,313 (−2.2% / −2.0%)** |
| `examples/todos-blocks`, no linker | 92,291 / 33,072 | 90,281 / 32,434 |
| `examples/sync-blocks`, linker (sliced) | 55,484 / 20,387 | 55,245 / 20,303 (−0.4%) |
| `examples/sync-blocks`, no linker | 65,132 / 23,862 | 64,893 / 23,774 |
| size.mjs: web app, v2 compiled (default) | 77,831 / 24,395 | 77,547 / 24,308 |
| size.mjs: same app, `hostFusion: false` (keeps `perform` and the driver) | 83,181 / 25,951 | 83,641 / 26,050 |
| size.mjs: same app, uncompiled | 82,068 / 25,671 | 81,725 / 25,570 |
| size.mjs: web app, plain Solid | 67,533 / 21,442 | 67,533 / 21,442 |

- `todos-blocks`: the linker now switches `ITERABLE` off (compiled facts: no
  `yield*` in any module), and the bundle has no `drive` / `step` / `settle` /
  `resume`, no `$`, no `perform` (`[READ_AFTER_WAIT]`, the driver's, is gone
  from the minified output). `smoke-apps.mjs`: the sliced production bundle
  adds two todos through the async action and toggles one: ok (sync-blocks,
  todos, sierpinski: ok).
- `sync-blocks` was already driver-free; it drops `perform` (the path readers
  no longer reference it), `performValue`, `stepSync` and the generator-object
  probe. A fully compiled bundle keeps `performOp` (the operation switch) for
  iterables found at a path.
- A bundle that keeps `perform` (the opt-out, the `$`-only fixture: 28,151 →
  28,438) pays ~0.3–0.5 kB min for the second copy of `perform`'s function
  branch (`readFunction`) and `readTokenPath`.

**Behaviour.** `check.mjs`: every variant of every scenario (including the two
new ones) renders the same trees and sinks. Census differential
(`slices-differential.mjs`, 1,965 tests): 0 regressions in all eight
configurations (−OPTIMISTIC, −VERDICTS, −STORES, −SNAPSHOTS, −ITERABLE,
−COMPILED_SEAMS, full −all, sync −all).

**Tests.** Compiler: Rust `blocks_v2_lower` tests for each item (async erased,
restored and refused bodies; contexts and helpers, and what keeps `perform`;
view reads in computations and getters; settled fusion; the shared / suffixed
`createPlainStore` local), `capabilities.test.js` (an erased async event turns
`ITERABLE` off; an unprovable one keeps its `yield*`s). Signals:
`block-async-compiled.test.ts` compares each compiled form with the driver
event by event and microtask by microtask (sync completion, sync failure,
resume order, rejection routing, superseded memo runs, synchronous memo), and
`treeshake.test.ts` pins that a fully compiled module's entries retain neither
`drive` nor `perform`. Web: conformance scenario `blocks-async-event` (an
event that waits, a write after the wait, a context read through a helper):
compiled `=` the oracle. Its uncompiled mode differs (declared): after the
resumed write the `@solidjs/h` pipeline renders `done`, then `none`; the same
event on the driver under the Solid compiler matches the oracle, so the
difference is in the uncompiled rendering path — pinned, not fixed here.

**Not done:**

- SSR output: the lowering is client-only; server bundles keep `perform` for
  attribute holes and the driver for async bodies (the server never runs an
  event, and its memo bodies serialize through the driver as before).
- Helper generators with anything but context reads (reads, creations, nested
  helpers), exported helpers, and helpers in other modules (cross-module needs
  an exported summary the linker threads through; the compiler is per-module).
- An async event with a statement `$flush()` stays on the driver (restored
  exactly): erasing it is exact, but the restore path would have to undo the
  `flush` lowering.
- `readFunction` still retains the operation switch (`performOp`) for iterables
  found at a path (context providers); only the generic `perform` dispatch,
  `performValue`, `stepSync` and the generator-object probe are dropped.

## 11. Completing the lowering (2026-09-29)

Baseline for this section: `d3ed8cc2` (after section 10 and the islands
merge), runtime and compiler snapshotted as `preH` / `preH-compiler`
(`scripts/blocks-v2/build-prod.mjs --snapshot`); "current" is `7ac6f164`.

### What landed

- **Server output gets the v2 lowering** (setup creations, erased setups and
  events, async bodies through `asyncBody`, context reads, `readAccessor` /
  `readSelected` view reads). Hydration ids stay aligned (`block_scope.rs`;
  parity scenario `v2-helpers`).
- **Helper generators** beyond context reads: a `function*` whose every
  `yield*` is a context read, an accessor read, a creation, a `$cleanup`, a
  `raise` statement or another lowered helper becomes a plain function —
  in place when every reference is a lowerable call site, else as a twin
  (`name$lowered`) next to the generator. Exported twins are listed in the
  module's `helperSummary`; `helperSummaries` lowers imported helpers'
  call sites (`@solidjs/compiler/helpers-build`). **Function-scoped helpers**
  (declared inside a function: no `program.body` slot for a twin) lower in
  place only; one that escapes stays a generator, and so do its callers.
- **Async events with `$flush()`** compile to async functions too.
- **Driver-identical result promises.** `AsyncRun` rebuilds the driver's
  promise chain, so a compiled async body that suspends more than once
  settles its result promise in the same microtask as the driver
  (`tests/block-async-compiled.test.ts`). Cost: `asyncEvent` +5.3% below.
- **The operation switch** (`performOp`) is installed by the constructors of
  the operations it runs: fully compiled bundles drop it.
- **Static views (`BLOCK_STATIC`, flag 4).** A view that is a single
  `return` of JSX whose every `yield*` sits where the JSX transform defers it
  (a child hole, a dynamic intrinsic attribute, a component prop — not
  `ref`, `on*`, `use:` or a spread on an intrinsic element) is flagged
  `BLOCK_SYNC | BLOCK_STATIC`. Outside hydration, `insert` renders it once,
  untracked, instead of in a render effect with no sources: a compiled
  component then costs what a component returning DOM costs. Hydration keeps
  the effect (it carries the id scope the server rendered with).
- **Mixed builds.** The capability linker installs the block driver
  (`installBlockDriver`) in a module whose output still hands a generator
  body to `createMemo` / `createEffect` / `onSettled` (a module the compiler
  did not transform) and warns, instead of a production bundle running the
  body as a plain callback.
- **Hydration-aware imports.** In hydrating builds, names `solid-js`
  overrides (block constructors and `createSignal` / `createMemo` /
  `createEffect` / `createStore` / …) imported from `@solidjs/signals` are
  re-sourced to `solid-js` (`hydration_imports.rs`).

### Instruction counts (Ir/op, n=300; `compare.mjs --runtimes preH+preH-compiler,current`)

| cell | handwritten (current) | compiled, before | compiled, now | now vs handwritten |
| --- | ---: | ---: | ---: | ---: |
| create mount | 3,541k | 4,752k | **3,799k** (−20.0%) | 1.07× |
| helpers mount | 5,004k | 8,192k | **5,010k** (−38.8%) | 1.00× |
| helpers update | 2,860k | 4,087k | **2,899k** (−29.1%) | 1.01× |
| memo update | 1,804k | 1,886k | 1,821k | 1.01× |
| holes update | 1,926k | 1,981k | 1,926k | 1.00× |
| event update | 872k | 900k | 894k | 1.03× |
| attrs update | 1,357k | 1,385k | 1,357k | 1.00× |
| effect update | 821k | 810k | 772k | 0.94× |
| view update | 775k | 889k | 889k | 1.15× |
| paths update | 4,970k | 4,899k | 4,907k | 0.99× |
| async update | 45,465k | 47,276k | 46,247k | 1.02× |
| asyncEvent update | 1,111k | 1,549k | 1,631k (+5.3%) | 1.47× |

`view` re-runs its view on every update by construction (a top-level read),
so it keeps its render effect. `asyncEvent` pays for the handler contract,
the run object and (new) the driver-identical promise chain.

### Server output and bytes

- `scripts/ssr-redesign/blocks-ssr-bench.mjs --compare before,after`:
  hn-blocks and todos-blocks server output keep 0 `perform` calls, 0
  generator bodies and no `$` import (was 16 / 1 and 12 / 6); the HTML is
  identical; render time hn-blocks 23.97 → 23.10 ms (−3.6%), todos-blocks
  1.155 → 1.161 ms (+0.5%).
- `scripts/slices/measure-apps.mjs` (sliced, min / gz): sync-blocks
  62,838 / 23,043 → **54,844 / 20,179** (the linker again proves it
  async-free: `<For each>` over a lowered view is SYNC); todos-blocks
  89,888 / 32,313 → 89,791 / 32,284; todos and sierpinski unchanged.

## 12. Helper return facts (2026-09-29)

Section 11 turned helper generators into plain functions, but what they
returned stayed opaque: `const d = yield* useDoubled()` lowered to
`const d = useDoubled()` while `yield* d` kept `_$perform(d)`, and
`const k = yield* useCounter()` kept `yield* k.d` as `_$readPath1(k, "d")`
(a props-target probe, a token probe, a guard bracket and `readThrough`'s
function dispatch per read).

The helper lowering now records what each lowered helper returns
(`packages/compiler/src/blocks_v2_lower/helpers/returns.rs`), analyzed on the
generator form:

| the helper returns, on every path | fact |
| --- | --- |
| `yield* $memo(…)`, a `$signal` / `$memo` / `createSignal` / `createMemo` accessor binding, another helper's accessor | `accessor` |
| a `$store` / `createStore` store binding | `store` |
| an object literal `{ d, inc }` | `object`: per property `accessor`, `store`, `function` (an arrow or a setter) or `other` |
| an array literal `[a, setA]` | `tuple`: per element, as above |

The fusion (`FusionContext::binding_origin`) and the remaining-reads pass
consume it: `const d = h()`, `const [a] = h()` and `const { d } = h()` bind
proven accessors (`_$perform(d)` → `d()` in a computation, `_$readAccessor(d)`
elsewhere), and `_$readPath1(k, "d")` of `const k = h()` becomes `k.d()` in a
fused body or computation and `_$readAccessor(k.d)` elsewhere.

Why it is the same program: the helper's body alone decides the fact. Every
`return` at its own depth must yield the same shape and the body must end in
a `return` (no path falls off with `undefined`); property kinds that differ
between returns are `other`. An object or array fact requires a literal built
by the `return` itself, with plain data properties only (no getter, setter,
method, spread, computed key or `__proto__`), so nothing else holds it and
reading `k.d` runs no code. The caller's binding must be `const`; for
property reads every reference to `k` must be a lowered path read's root or a
member access that is never written (`k.d = …`, `k.d++`, `delete k.d`,
destructuring and `for` targets) and is called only for an `accessor` or
`function` property — `k` never escapes, so no unseen code can replace `k.d`.
`readPath1(k, "d")` on such a `k` (not a store, not typed props, not a path
token) is `readThrough(k.d)`, which for an accessor is `readAccessor(k.d)`.
The helper binding itself must be a function declaration nothing reassigns,
or an import.

Cross-module: an exported helper's summary entry carries the fact
(`"returns": "accessor"`, `{ "object": { "d": "accessor", "inc":
"function" } }`, `{ "tuple": [...] }`); `helperSummaries` threads it to
importers (flattened as a fifth field; a summary without it still lowers the
call sites, the results just stay unproven).

Instruction counts (n=300; before = the section 11 compiler, `preR-compiler`,
same runtime; `helperReads` is new: n components whose view reads a helper's
accessor and an object's accessor property, update writes the shared
signal):

| cell | handwritten | compiled, before | compiled, now |
| --- | ---: | ---: | ---: |
| helpers mount | | 5,056k | **5,026k** (−0.6%) |
| helpers update | | 2,925k | **2,895k** (−1.0%) |
| helperReads update | 3,740k | 3,821k (1.02×) | **3,781k** (−1.0%, 1.01×) |
| memo update, create mount | | | ±0.0% (identical output) |

The compiled `helpers` cell's memo is now
`_$createMemo(function() { return label() + k.d(); })`.

Not done: `yield* k.d` inside another helper (a member operand is not a
helper yield the lowering takes), nested objects (`k.a.b`), and facts for
helpers that stay generators.

## Evaluated and not done

| idea | measurement | why not |
| --- | --- | --- |
| Driver-free compiled output (a call-form-only `$`) | stubbing the driver out of the compiled app: −2.85 kB min / −0.9 kB gzip; no runtime effect | Done in section 9 (`syncBlock` and the `…Compiled` entries): −3.6 kB min / −1.0 kB gzip. |
| An accessor fast path in the old `perform` | holes +48%, memo/view regressions | Root cause: the closure-context allocation described in 2; done after the split instead. |
| Rest parameter → `arguments[0]` alone | ±0.02% | Kept for the unoptimized tiers, but not a win by itself. |
| Eager ("static") views | the structural share above: 282k per 100 components | A view with no top-level read could run once, untracked, when its component is called; but a view must stay a value `yield* Child(p)` can carry, and the renderer, not the component, owns where it runs. Needs a renderer-level contract. |
| Cheaper uncompiled prop chains | uncompiled `paths` 3.0×, `create` 10.7× | Each `props.x` access in an uncompiled body builds a Proxy chain and an operation object. A shared-prototype-Proxy design (own fields on a plain object, deeper keys through a prototype trap) would cut it; uncompiled is the interop path, so left as a recommendation. |
| Skip the typed-props WeakMap registration for uncompiled setups; one shared Proxy handler for typed props and prop chains | uncompiled create: +20% at n=100/50 ops, +0.2% at n=300, −1.3% at n=100/150 ops; paths −0.9% | Fewer allocations, but no win the harness can show above its GC noise for this cell: reverted. |
| Fusing the effect half | fused effect 1.36× | Done in section 9: effect 1.06× plain Solid. |

## Recommendations

1. ~~Keep `hostFusion`-style v2 fusion on the path to default.~~ Default since
   section 9 (`hostFusion: false` opts out).
2. ~~Add compiled-only constructors so fully compiled modules do not retain the
   driver.~~ Done (section 9). A slimmer `perform` was evaluated: nothing left
   to measure once creations, writes and events are lowered.
3. ~~Lower setup creations to direct runtime calls.~~ Done (section 9).
4. ~~Treat the view's own render effect as the cost floor of a v2
   component.~~ Static views (section 11) remove it where the view reads
   nothing itself: creation is 1.07× plain Solid.
5. Keep `scripts/blocks-v2` in the loop for block runtime changes: the closure
   context regressions above were invisible to the test suite and to casual
   timing, and obvious in instruction counts.

## Open problems

- Uncompiled v2 is still 3–11× plain Solid on creation, effects and path reads
  (typed-props proxy chains, generator delegation per `yield*`).
- Compiled v2 is within 0.94–1.07× plain Solid on every cell except views
  that re-run (1.15×: the view's own render effect) and handlers that wait
  (1.47×: the handler contract, the run object and the driver-identical
  promise chain; section 11). `blocks-effect`'s compiled mode
  now equals handwritten Solid.
- In the conformance matrix, `blocks-async-event`'s uncompiled mode (the
  `@solidjs/h` pipeline) re-renders the pre-write value after an awaited write;
  the same event on the driver under the compiler matches the oracle (section
  10). Not investigated further.
- ~~A `$memo` imported from `@solidjs/signals` in a hydrating `solid-js` app fused to the non-hydration primitive.~~ Resolved: hydrating builds re-source hydration-aware names imported from `@solidjs/signals` to `solid-js` (`packages/compiler/src/hydration_imports.rs`).
- `examples/sync-blocks`'s async-free assertion needs its typed summary
  (`pnpm test` runs `pnpm summary` first; a bare `vitest run` fails that one
  test, before and after this work).
