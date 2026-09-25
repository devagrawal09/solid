# Track B, Slice 2: Proxy-Free Strict Stores

Status: 2026-09-25. Two measured stages on `experiment/iterable-signals`
(base `1fc0b873`). Part of the optimization slices listed in
[`typed-generator-compiler.md`](./typed-generator-compiler.md) ("Proxy-free
strict stores"). Raw data: [`track-b-slice-2-data/`](./track-b-slice-2-data/).

## Decisions

| Item                                                                                               | Decision                                              | Why                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stage 1: lowered typed paths read through store handles (`readPath1`–`readPath4`, `readPathN`)     | **KEEP**                                              | 4-key reads 0.76x and dynamic `items[i].name` 0.66x of handwritten proxy reads; 3–7x faster than the previous lowering (which ran 2.1–5.1x handwritten); zero allocations per read (previous lowering: 665–707 B/read). One-key reads 1.07–1.11x (the root's trap remains). Handwritten reads unchanged; +97 B brotli for `createStore` bundles. |
| Fixed-arity readers over a generic reader                                                          | **KEEP** (1–4 keys)                                   | 2–5% faster than `readPathN` with a hoisted key array, and the only allocation-free form for dynamic keys (`readPathN` with an inline `[…, i, …]` array allocates ~41 B/read).                                                                                                                                                                   |
| Token registry (`WeakMap`) instead of trap-probing roots                                           | **KEEP**                                              | Required for exactness without touching foreign proxies; also makes the runtime driver's path reads 1.5–2.6x faster.                                                                                                                                                                                                                             |
| Stage 2 runtime: lazy compatibility proxies, handle-mode trap, handle API                          | **KEEP; ITERATE on its cost**                         | Handle-rooted reads 0.62–0.69x of handwritten (no Proxy trap at all), a no-escape store's mount 0.83x (~65 B/row fewer allocations), sparse updates 0.77–0.80x. Cost: stage-1 proxy-rooted walks 5–7% slower than in stage 1, handwritten reads ≤3% (noise; isolated 1.01x), +138 B brotli more than stage 1 for `createStore` bundles.          |
| Stage 2 compiler (`storeHandles`, opt-in): handle stores, `Borrowed<T>` contracts, store summaries | **KEEP as experimental opt-in**                       | Conservative: every unproven use deoptimizes to the lazy proxy; bundles with handle stores shrink below base (no derived-form projection engine). +37% transform time when enabled on a store-dense module; nothing when disabled or when a module imports neither `createStore` nor `Borrowed`.                                                 |
| Handles across modules                                                                             | **Compiler side done; BLOCKED on the Track C linker** | Summaries and `storeLinkFacts` are implemented and tested; nothing joins them yet.                                                                                                                                                                                                                                                               |
| Omitting the proxy RUNTIME (code) for a graph that never escapes                                   | **BLOCKED (Track C + write lowering)**                | Needs a whole-graph proof and a lowering of setter drafts; see "Blocked". Per-store proxy CREATION is omitted today.                                                                                                                                                                                                                             |

Details, numbers and raw data follow.

## Stage 1 — allocation-free handle reads for typed paths

### What changed

The compiler lowered `yield* root.a.b` to `perform(readPath(root, ["a","b"]))`:
an operation object, a path array, a closure, a `WeakMap`-free token probe (a
full `get` trap run on the root under a guard/untrack bracket), then a proxy
walk. It now emits one call, by key count:

```js
yield* store.user.name        →  _$readPath2(store, "user", "name")
yield* store.items[i].name    →  _$readPath3(store, "items", i, "name")
yield* props.count            →  _$readPath1(props, "count")
yield* s.a.b.c.d.e            →  _$readPathN(s, ["a", "b", "c", "d", "e"])
```

Store and prop roots share the readers (the runtime read is identical; the
`StoreRead`/`PropRead` distinction exists only in the typecheck projection,
which is unchanged).

Each reader:

1. resolves a path-token root (an in-block alias `const u = store.user`)
   through the previous operation path, so tokens are consumed and prefixed
   exactly as before;
2. lowers the strict guard (try/finally), as the operation did;
3. walks: the root's first key is an ordinary `[[Get]]` (the only Proxy trap
   left); every later hop whose value is the store child the trap just served
   runs the store's `get` trap function on that child's target as a plain
   call. The store records the last child target it served (`lastServed`,
   one variable store per served child); a value is that child exactly when
   it is the target's proxy (a proxy has one target), so no stale record can
   be mistaken for it;
4. reads through an accessor or block found at the path (`readThrough`), as
   `yield*` does.

Everything that is not a served store child — props objects, raw or
raw-marked values, `merge()`/`omit()` proxies, the SSR pending store,
primitives — takes the ordinary `value[key]`, the exact access the proxy walk
made. Numeric keys are coerced exactly as a Proxy coerces them; any other key
type (symbol, object) goes through the proxy. A foreign proxy is never probed.

### Runtime details worth reviewing

- The store `get` trap became a named three-parameter function (`getKey`).
  **An extra declared parameter slowed every trap call by ~15% on deep
  reads** (arity mismatch with the engine's 3-argument trap call) — measured,
  and the reason the handle mode (stage 2) is selected through the receiver.
- The node wrap cache (`px`/`pxv`) now holds the child TARGET (null for a
  raw-marked child) instead of the proxy.
- Path tokens are registered in a `WeakMap` (the reader's token check, and
  `tokenOf`, no longer run a trap). The uncompiled runtime driver keeps the
  plain proxy walk so store-only bundles do not retain the handle walk.

### Tests

- `packages/signals/tests/store-handle-paths.test.ts` (22): every scenario
  runs handwritten proxy access, the previous lowering, the new reader inside
  a block, and the new reader in a plain (host-fused) computation side by
  side, asserting identical values, **identities** and **re-run counts** over
  a sequence of writes: deep objects (sibling writes, container
  replacement), array index/length/dynamic index with reverse/push, absent
  keys subscribing and picking up insertions, own getters, class prototype
  getters/methods and pollution keys, shallow stores, platform objects
  (`Map`, `Date`), stores held in stores, 5-key paths, `merge()` props over a
  store, props getters, read-through of accessors and blocks, identical
  throws, identity of every served object, a getter serving another store
  mid-hop, in-block aliases (tokens), guard restoration on throw, draft
  reads (read-your-writes) and draft admission, untracked committed reads, an
  async projection (pending + refetch), an optimistic store during an action.
  A mutation check (untracked raw read in place of the trap) fails 10 of them.
- `packages/signals/tests/block.type-tests.ts`: reader result types.
- Compiler: Rust unit tests and `generators-fixtures` snapshots updated;
  host fusion now keeps the reader calls (the previous member-chain erasure
  dropped read-through).
- `packages/web/test/server/store-paths.spec.tsx` (SSR) and a
  `strict-store-paths` scenario in the shared hydration parity harness
  (server render → hydrate, no warnings, node identity, post-update pass).

## Stage 2 — handles across boundaries, lazy proxies, escape contracts

### Runtime

- **Lazy compatibility proxies.** A store target's proxy is created on first
  need (`proxyOf`): a trap read serving it, a getter or prototype read (the
  receiver), `storeProxy` at an escape, a setter draft. Identity checks
  (`t.px === v`) need none. Targets carry a pre-shaped `$PROXY` slot so lazy
  and eager targets share a hidden class.
- **Handle mode.** Passing a sentinel receiver (`HANDLE_READ`) to the `get`
  trap function makes it hand children back as TARGETS and create them
  without proxies. A walk keeps the mode it started in: from a handle root
  children stay targets; from a proxy root they stay proxies (the stage-1
  walk). A target never leaks to user code: the proxy-root hop reads a
  target as its proxy, and a walk ending on a child target materializes that
  child's proxy.
- **API** (compiler targets, `@internal`; typed):
  `createStoreHandle(init, options?) → [StoreHandle<T>, setter]`,
  `storeHandle(store)`, `storeProxy(handle)`, `readHandle1..4`, `readHandleN`,
  `readHandleChild(handle, keys)` (a child handle for a `Borrowed` prop),
  `readBorrowed(props, keys)` (walks a handle when a compiled caller passed
  one, anything else exactly like `readPathN`), `markHandle`. Handles are
  recognized through a `WeakSet` — never by touching a value.
- **Types.** `StoreHandle<T>` (opaque), `Borrowed<T> = T` (the typed escape
  contract; callers pass stores or plain values as usual).
- **Server.** Server stores are plain objects; server handles are marked
  `{ v }` wrappers that the shared readers walk as plain objects.
- Development/observability builds register a store's graph at creation with
  its proxy, so there a handle ROOT is materialized eagerly; production builds
  keep it lazy. Children created by handle walks are lazy in every build.

### Compiler (`storeHandles: true`, off by default)

Runs after the generator lowering (paths are already `_$readPathK(root, …)`)
and before JSX lowering. Everything not proven is left exactly as stage 1
emitted it.

**Supported (a handle store):**

```ts
const [s] = createStore({ … } | [ … ]);            // literal initializer
const [s, setS] = createStore({ … }, options?);     // with setter / options
```

in any scope, `const`, not exported, and with at least one lowered read.
Then:

| Use of `s`                                                                                                                                                                                                                                                                                                                                    | Lowering                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `yield* s.a.b` (lowered `_$readPathK(s, …)`)                                                                                                                                                                                                                                                                                                  | `_$readHandleK(s, …)` — 0 traps                                          |
| `<C prop={s}>` / `<C prop={s.a[i]}>` where `C.prop` is a verified `Borrowed` prop of a same-module component, or of an import the linker vouched for (`storeLinkFacts`)                                                                                                                                                                       | `s` / `_$readHandleChild(s, ["a", i])` — the handle crosses the boundary |
| anything else that is an expression position: call argument, member access in plain code, alias/destructuring, spread, object value (shorthand expanded), array element, return, JSX attribute/spread, `for…in/of`, `readStore(s, …)`, operators, `typeof`, TS `as`/`!`/`satisfies`, a `yield*` the generator pass left to the runtime driver | `_$storeProxy(s)` — the lazy proxy, the same object at every escape      |
| `createStore(…)`                                                                                                                                                                                                                                                                                                                              | `_$createStoreHandle(…)`                                                 |

**Refused (stays `createStore` + stage-1 readers), reported in the summary:**
`exported` (declaration or `export { s }`), `derived-form` (function first
argument), `non-literal-initial` (an identifier or call could hold a
function — the derived form), `not-const`, `pattern` (anything but `[s]` /
`[s, set]`), `arguments` (spread or >2 arguments),
`unsupported-reference:<kind>` (a reference in a non-expression position:
`export { s }`, `<s.X />`, assignment targets, computed keys, …),
`no-lowered-reads` (nothing to gain).

**`Borrowed<T>` contract.** A component (function declaration or
`const C = (props) => …`, capitalized, first parameter an identifier) whose
props annotation — inline type literal, same-module interface or object type
alias, intersections — declares `x: Borrowed<T>` (resolved to the runtime
import, type or value) is VERIFIED for `x` when every use of `props.x` is a
lowered path read (`yield* props.x.…`) or a JSX forward to another verified
`Borrowed` prop (greatest fixed point; forwards to linked imports count).
Violations deoptimize (ordinary readers; callers pass the proxy) and are
reported: `prop-escape` (`props.x` in plain code), `props-escape` (`props`
spread, passed, or otherwise used whole), `dynamic-prop-read`,
`forward-to-unverified`. A verified prop's reads become `_$readBorrowed`,
which accepts a handle or any other value, so uncompiled callers stay
correct.

**Deoptimizations by construction:** unknown calls, spreads, enumeration
(`for…in`, `Object.keys`), reflection, structural selectors (`readStore`),
dynamic components (`<Dynamic component={X} prop={s}>` — not a resolvable
component), external libraries and uncompiled modules all receive
`_$storeProxy(s)`; getters and prototype reads materialize the receiver
proxy at runtime; setter calls materialize the root draft proxy.

### Store summary (the Track C contract)

Every module compiled with `storeHandles` returns `storeSummary` (JSON,
`version: 1`; TypeScript type `StoreSummary` in `@solidjs/compiler`):

```jsonc
{
  "version": 1,
  "module": "src/app.tsx",
  "stores": [{
    "binding": "store", "loc": "18:10",
    "handle": true, "refused": null,            // or the refusal reason
    "reads": 2, "setter": true,
    "proxyFree": false,                          // handle && no escapes && no setter use
    "handoffs": [{ "component": "Row", "prop": "todo", "via": "local" | "import:./row" }],
    "escapes": [{ "kind": "call-arg", "loc": "22:7", "detail": "log" }]
  }],
  "components": [{
    "name": "Row", "exported": false,
    "borrowed": [{ "prop": "todo", "verified": true, "reads": 2, "violations": [] }]
  }],
  "requires": [{ "source": "./row", "export": "Row", "prop": "todo", "status": "unknown" | "linked" }]
}
```

What a linker does with it (not implemented here — see Blocked):

1. **Contracts across modules.** For each `requires` entry, resolve
   `source`/`export` to the callee module's summary and check
   `components[].borrowed[].verified` for that prop. Recompile the caller
   with `storeLinkFacts: { borrowed: { [source]: { [export]: [props] } } }`
   to hand handles across the import (implemented and tested: the caller
   then emits `_$readHandleChild` and marks the entry `linked`).
2. **Proxy creation.** Per store, `proxyFree` already says no proxy is ever
   created for it in production.
3. **Proxy runtime.** Only if EVERY store in the complete client graph is
   `proxyFree` (and no uncompiled module, `createStore` outside the analysis,
   `createProjection`/`createOptimisticStore` family, `storeHandle`, or
   dynamic import can create one) could a build flag drop the proxy traps and
   the draft machinery. See Blocked.

The facts are conservative in the unsafe direction only: a linker that
supplies a wrong `storeLinkFacts` entry would hand a handle to a component
that does not expect one — facts must come from the callee's own summary.

### Stage 2 tests

- `packages/signals/tests/store-handles.test.ts` (17): reads at every depth
  with exact re-run counts and sparse updates; agreement with proxy reads
  across index changes, writes, reverse; absent keys; **no proxy is created**
  for children (and the root, in production — also run under
  `SIGNALS_TIER=prod`); `storeProxy` materializes once and agrees with trap
  identities; a walk ending on a child materializes only that child; getters
  (receiver materialized, tracked); class prototypes and platform objects;
  setter drafts, returned replacements and keyed `reconcile` (child handle
  identity survives); shallow handles; `storeHandle` over an async projection
  and an optimistic store (every frame equal to the proxy's); plain handles;
  `readBorrowed` over a handle, a proxy and a plain object with identical
  tracking; reading the borrowed prop itself (proxy handed out); the lowered
  caller/callee pair against the handwritten spelling; guard lowering.
- `packages/compiler/__tests__/store-handles.test.js` (23): positive lowering
  (reads, every escape kind, shorthand expansion, structural selectors keep
  the proxy, output parses), proxy-free detection, import specifiers, SSR,
  every refusal, off-by-default, Borrowed verification (inline, interface,
  alias), each violation kind deoptimizing both sides, forwarding fixed point,
  undeclared props, linker facts (unknown → proxy, linked → handle,
  malformed facts rejected), and the web end-to-end module's lowering.
- `packages/web/test/store-handles/` compiled with `storeHandles`
  (`vite.config.store-handles*.mjs`, wired into `pnpm test`): client render
  and five updates (sparse title/flag, root, push, splice) against a
  handwritten twin, DOM identity of handed-off rows, no row block re-runs,
  escapes returning the one proxy; SSR markup equal to the twin.

## Measurements

Environment: Linux 6.18 (Firecracker VM), Intel Xeon @ 2.80GHz, 4 vCPUs,
Node v22.22.2 (V8 12.4), production builds (`dist/prod`, property-mangled),
esbuild 0.27 for bundles, Rust 1.97.1 release bindings for compile cost.

### Commands

```sh
# builds
pnpm --filter @solidjs/signals build                       # dist/prod (mangled) for the runtime benches
cd packages/compiler && cargo build --release --lib        # release binding for compile cost (Rust 1.97.1)

# runtime: 3 full runs per build, alternating base / stage 1 / stage 2 builds
node packages/signals/scripts/bench-store-paths.mjs --dist <build>/dist/prod/index.js \
  --samples 15 --ops 150 --json time-<build>-<run>.json
# allocations (a --trace-gc child; only zero-scavenge windows are reported)
node packages/signals/scripts/bench-store-paths.mjs --dist <build>/dist/prod/index.js --alloc --json alloc-<build>.json
# isolated compat check (one workload per process), 5 alternating runs
node packages/signals/scripts/bench-store-paths.mjs --dist <build>/dist/prod/index.js --only deep --samples 11
# bundle size (esbuild minify, gzip -9, brotli -q11); --handles compiles with storeHandles
node packages/signals/scripts/size-store-paths.mjs --label <name> [--repo <checkout>] [--handles]
cd scripts/size && npx size-limit --json                   # the repo's size scenarios
# compile cost + emitted/minified bytes of a 200-component strict module, base vs stage 1 vs stage 2
node packages/compiler/scripts/bench-store-handles.mjs --native <release .node> \
  --base-dir <base>/packages/compiler --base-native <base release .node> --components 200 --samples 15
```

"base" is a worktree of `1fc0b873` built the same way. Each runtime cell
below is the median of three run medians (each run: 15 samples × 150 ops
after 400 warm-up ops, variants interleaved with a rotating order).
Ratios are to handwritten proxy reads on the base build. Workloads:
`shallow` 1 key, `deep` 4 keys, `dynamic` `items[i].name` over 1000
indices, `list` 1000 row memos re-run after a 1000-row write, `mount`
creating a 1000-row store plus a reader per row, `update` one sparse leaf
write among 1000 row readers.

### Read and update throughput

| Workload          | handwritten (base) | previous lowering (base) | handwritten (stage 1) | stage 1 reader | stage 1 reader, fused | handwritten (stage 2) | stage 1 reader (stage 2 build) | handle root  | no-escape store |
| ----------------- | ------------------ | ------------------------ | --------------------- | -------------- | --------------------- | --------------------- | ------------------------------ | ------------ | --------------- |
| shallow (ns/read) | 105 (1.00x)        | 534 (5.07x)              | 104 (0.99x)           | 117 (1.11x)    | 113 (1.07x)           | 105 (1.00x)           | 120 (1.14x)                    | 68 (0.64x)   | 69 (0.66x)      |
| deep (ns/read)    | 407 (1.00x)        | 924 (2.27x)              | 408 (1.00x)           | 308 (0.76x)    | 309 (0.76x)           | 421 (1.03x)           | 327 (0.80x)                    | 280 (0.69x)  | 278 (0.68x)     |
| dynamic (ns/read) | 562 (1.00x)        | 1159 (2.06x)             | 615 (1.09x)           | 370 (0.66x)    | 398 (0.71x)           | 615 (1.10x)           | 394 (0.70x)                    | 349 (0.62x)  | 364 (0.65x)     |
| list (ns/read)    | 3100 (1.00x)       | 5132 (1.66x)             | 2884 (0.93x)          | 2728 (0.88x)   | 2544 (0.82x)          | 2937 (0.95x)          | 2703 (0.87x)                   | 2582 (0.83x) | —               |
| mount (ns/row)    | 7869 (1.00x)       | 10243 (1.30x)            | 7946 (1.01x)          | 7194 (0.91x)   | —                     | 8090 (1.03x)          | 7256 (0.92x)                   | 6523 (0.83x) | 6530 (0.83x)    |
| update (ns/op)    | 6628 (1.00x)       | 6460 (0.97x)             | 5629 (0.85x)          | 6017 (0.91x)   | —                     | 5299 (0.80x)          | 5022 (0.76x)                   | 5132 (0.77x) | 5294 (0.80x)    |

Run-to-run spread (max−min of the three run medians, relative): median 6.4%, max 70.4%.

- **Noise.** Interleaving removes most drift, but cells that depend on
  process history move between runs (the `list` and `update` workloads, and
  `dynamic` handwritten reads, where isolated one-workload processes gave
  **0.90x** for stage 1 vs base while the mixed run above shows 1.09x).
  The isolated compat check (5 alternating processes per build) is the
  better regression signal: deep **1.00x**, dynamic **0.90x** (stage 1 vs
  base). Differences under ~5% are within noise here.
- `generic`/`inline` (below) decide the fixed-arity question: fixed arity is
  2–5% faster for constant keys and the only allocation-free option for
  dynamic keys.

| Stage 1 build | fixed arity (fused) | `readPathN`, hoisted keys | `readPathN`, inline array |
| ------------- | ------------------- | ------------------------- | ------------------------- |
| shallow       | 113                 | 119                       | 117                       |
| deep          | 309                 | 315                       | 307                       |
| dynamic       | 398                 | —                         | 405                       |

### Allocations (bytes per read / row / op, zero-scavenge windows)

| Workload (B per read/row/op) | handwritten (base) | previous lowering (base) | handwritten (stage 1) | stage 1 reader | stage 1 reader, fused | handwritten (stage 2) | stage 1 reader (stage 2 build) | handle root | no-escape store |
| ---------------------------- | ------------------ | ------------------------ | --------------------- | -------------- | --------------------- | --------------------- | ------------------------------ | ----------- | --------------- |
| shallow                      | 0.7                | 665.6                    | 0.7                   | 1.0            | 0.6                   | 0.7                   | 1.0                            | 0.3         | 0.3             |
| deep                         | 0.6                | 665.4                    | 0.3                   | 0.6            | 0.3                   | 0.3                   | 0.6                            | 0.3         | 0.3             |
| dynamic                      | 1.8                | 706.5                    | 1.5                   | 1.8            | 1.5                   | 1.5                   | 1.8                            | 1.5         | 1.5             |
| list                         | 619.7              | 2062.2                   | 619.7                 | 732.7          | 619.7                 | 619.7                 | 732.7                          | 619.7       | —               |
| mount                        | 2600.7             | 4427.7                   | 2594.7                | 2595.2         | —                     | 2594.5                | 2593.8                         | 2530.9      | 2530.1          |
| update                       | 2877.2             | 3308.0                   | 2670.4                | 2293.2         | —                     | 2670.4                | 2293.2                         | 2150.4      | 2150.4          |

The previous lowering allocated 665–707 B per read on the base build
(operation object, path array, closure, and the trap-probe bracket); the
stage-1 token registry alone cut that to ~281–322 B for code still on the
old operation path. Every new reader allocates nothing beyond the workload's
fixed per-flush cost (the handwritten column). No-escape stores save ~65 B
per mounted row (two child proxies never created). `readPathN` with an
inline dynamic key array allocates ~41 B per read — why dynamic paths use
fixed arities.

### Size

Bundles of one representative strict module (`size-store-paths.mjs`:
shallow/deep/dynamic/list reads) with esbuild, minified; bytes:

| Build                   | app module min / gzip / brotli | app + runtime min / gzip / brotli | store-only compat app min / gzip / brotli |
| ----------------------- | ------------------------------ | --------------------------------- | ----------------------------------------- |
| base                    | 1038 / 505 / 444               | 52545 / 19247 / 17440             | 49887 / 18336 / 16637                     |
| stage 1                 | 1034 / 528 / 463               | 53611 / 19582 / 17703             | 50201 / 18474 / 16735                     |
| stage 2                 | 1034 / 528 / 463               | 54023 / 19735 / 17852             | 50574 / 18618 / 16853                     |
| stage 2, `storeHandles` | 1097 / 558 / 498               | **49850 / 18262 / 16537**         | 50574 / 18618 / 16853                     |

With `storeHandles` the bundle is smaller than base: a handle store never
takes `createStore`'s derived (function) form, so the projection engine
drops out of the bundle (verified: no projection module in the output).

The repo's size-limit scenarios (brotli bytes, delta vs base):

| Scenario                           | base  | stage 1 | stage 2 |
| ---------------------------------- | ----- | ------- | ------- |
| signals core floor                 | 8526  | −6      | −4      |
| signals + createStore              | 16852 | +97     | +235    |
| signals + isPending/latest         | 10786 | +7      | −4      |
| simple app floor                   | 11537 | −5      | +2      |
| hydrating app, no stores           | 18937 | −16     | +31     |
| hydrating app + every store family | 29898 | +100    | +242    |
| CSR app                            | 14333 | −2      | −28     |
| CSR app, observe tier              | 15666 | +47     | +55     |

(Every scenario is already over its checked-in limit on this experiment
branch at base; the deltas are what matter.)

Compiled output of a 200-component strict module (157 KB source) —
`bench-store-handles.mjs`:

| Compiler                 | emitted | minified | gzip | brotli | store summary |
| ------------------------ | ------- | -------- | ---- | ------ | ------------- |
| base                     | 306056  | 138947   | 3536 | 2133   | —             |
| stage 1                  | 288886  | 133966   | 3540 | 2164   | —             |
| stage 2 (`storeHandles`) | 301368  | 130691   | 3617 | 2222   | 85980 B JSON  |

(Identical hoisted key lists share one module constant; before that
deduplication stage 2 compressed to 5971 B gzip.)

### Compiler cost

Same module, release bindings, 15 samples × 5 transforms, interleaved;
medians of three runs: **base 15.35 ms, stage 1 14.43 ms, stage 2
19.84 ms** (+37% over stage 1 when enabled — a second semantic analysis and
the escape classification). Disabled, the pass costs nothing; enabled, a
module that imports neither `createStore` nor `Borrowed` skips it with a
syntactic gate. (An early version spent 2.9x here: locations were computed
by rescanning the source per report; a line index fixed it.)

## Limitations

- **One-key reads from a proxy root** stay ~1.1x of handwritten: the root's
  first key is still a Proxy [[Get]]; only handle roots remove it (0.64x).
- **Stage 2 cost on stage-1 walks.** The handle-mode check in the trap and
  the split hop make proxy-rooted stage-1 readers ~5–7% slower than in stage
  1 (deep: 327 vs 308 ns) and handwritten proxy reads ≤3% (within noise;
  isolated runs 1.01x). A diagnostic build with handle mode compiled out
  recovered handwritten parity, so the trap-side cost is the mode check.
- **Handle stores need a literal initializer** in the same module and
  `const [s] | [s, set]`. Stores created elsewhere (imported, returned from
  functions, derived/projection/optimistic families) are reachable only
  through `storeHandle(proxy)` (runtime API; the compiler does not emit it).
- **Lists through `For`** receive proxies (`<For each={store.rows}>` is an
  escape); a handle-aware list primitive would be needed to keep row handles.
- **Development/observability builds** materialize a handle root eagerly
  (graph registration); only production builds omit it.
- **Setter drafts** always materialize the root proxy; draft mutations are
  arbitrary code.
- **Dynamic keys in `Borrowed`/child handoffs** (`readHandleChild(s,
["rows", i])`) allocate a two-element array per prop read; all-literal key
  lists are hoisted and allocation-free.
- **Components** are recognized only as top-level function declarations or
  `const C = (props) => …` with an identifier first parameter; destructured
  props never verify a `Borrowed` contract.
- **Pre-existing, outside this slice:** a `$` JSX-block row under `For`
  re-renders its element after a `push` (visible as a dropped empty
  `class=""`), with or without store handles and with the base commit's
  compiler; the web store-handles spec normalizes that attribute and asserts
  the handed-off rows' identity instead.

## Blocked (Track C)

- **Handles across modules** need a linker that joins `requires` entries to
  callee summaries and recompiles callers with `storeLinkFacts`. The
  compiler side (summary emission, fact consumption, handle handoff to
  linked imports) is implemented and tested; the linker is not.
- **Omitting the proxy runtime** (the Proxy handler's non-`get` traps, the
  draft machinery) needs (1) that linker proving every store in the complete
  client graph `proxyFree`, with no uncompiled modules, dynamic imports,
  projection/optimistic families or runtime `storeHandle` calls, and (2) a
  lowering of store writes that does not hand a draft proxy to user code
  (setters take arbitrary callbacks). Neither exists; per-store proxy
  CREATION is omitted today (`proxyFree` stores in production).
- **Typed facts from TypeScript.** `solid-tsc` does not yet emit typed
  summaries (resolved symbols across re-exports); the compiler recognizes
  `Borrowed` syntactically within a module.

## Remaining work

- Recover the ~5–7% stage 2 cost on proxy-rooted walks (e.g. a separate
  handle-mode trap entry that the proxy never calls).
- A handle-aware `For`/`mapArray` path so list rows stay handles.
- `storeHandle` emission for stores imported from compiled modules once the
  linker exists; wider component recognition; fixed-arity child handoffs.
- Validate against the Tier-2 suites (js-framework-benchmark, UIBench) —
  not run for this slice.

## Changed files

Stage 1 (commit `perf(signals,compiler): proxy-free handle reads for strict
store paths`): `packages/compiler/src/generators.rs`, generator fixtures and
`generators-fixtures.test.js`; `packages/signals/src/generator.ts`,
`src/store/next/store.ts`, `src/core/core.ts` (comment), `src/index.ts`;
`packages/solid/src/index.ts`, `src/server/index.ts`, `src/server/signals.ts`;
tests `packages/signals/tests/store-handle-paths.test.ts`,
`block.type-tests.ts`, `packages/web/test/server/store-paths.spec.tsx`,
`packages/web/test/harness/scenarios.tsx` (+ artifact); scripts
`packages/signals/scripts/bench-store-paths.mjs`, `size-store-paths.mjs`.

Stage 2 (commit `feat(signals,compiler): store handles, Borrowed contracts
and store summaries`): `packages/compiler/src/store_handles.rs` (new),
`compiler.rs`, `config.rs`, `node_adapter.rs`, `lib.rs`, `lazy.rs`,
`refresh/mod.rs` (result field), `index.js`, `types.d.ts`,
`scripts/bench-store-handles.mjs` (new), `__tests__/store-handles.test.js`
(new); `packages/signals/src/generator.ts`, `src/store/next/store.ts`,
`src/store/index.ts`, `src/index.ts`, tests `store-handles.test.ts` (new),
`block.type-tests.ts`, the two scripts; `packages/solid/src/index.ts`,
`src/server/index.ts`, `src/server/signals.ts`; `packages/web/package.json`
(test script), `vite.config.mjs` (exclude), `vite.config.store-handles.mjs`,
`vite.config.store-handles-server.mjs`, `test/store-handles/` (new).
