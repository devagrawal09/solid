# Building the Compiler Heuristics

Status: 2026-09-27. Builds the heuristics that earned a compiler proof in
[heuristic-oracles.md](./heuristic-oracles.md) and the strategy that won in
[resumability.md](./resumability.md). Each stage is:
- a real compiler pass behind an experimental option, off by default;
- shipped runtime support (no `__ORACLE__` arms);
- Rust tests, runtime equivalence tests, and the repo's suites;
- a Tier-1 bench of the compiled form.

| Stage | Feature | Status |
| --- | --- | --- |
| 1 | A1 sync actions (`syncActions`) | **Done** |
| 2 | H1 memo fusion (`memoFusion`) | **Done** |
| 3 | Per-island hydration + compiler handler → island map (F) | **Done** |
| 4 | S2 store scalar replacement (`storeScalars`) | **Done** (narrow coverage) |
| 5 | C pruned resumability | Next |

## Stage 1: sync actions

The option `syncActions` (DOM output only) is implemented in `packages/compiler/src/sync_actions.rs`, with the runtime helper `syncAction` in `packages/signals/src/core/action.ts` (exported from `@solidjs/signals` and `solid-js`).

- **Proof** (syntactic, per call site):
  - `action` imported from `solid-js` / `@solidjs/signals`, not shadowed;
  - one argument: a non-`async` generator function expression with no `yield` in its own body;
  - if named, the name is not referenced inside.
- **Rewrite:** `action(function* (…) { … })` → `_$syncAction(function (…) { … })`.
- **Server output is untouched:** the server's `action` never runs bodies.
- **What `syncAction` keeps:** the owned-scope guard, the provenance stamp, the flush-in-action guard, the attribution brackets, and a returned promise that resolves with the value or rejects with a throw. It drops only the transaction.
- **Equivalence** (`packages/signals/tests/sync-action.test.ts`, 6 tests): plain writes and resolved value; throw → rejection with earlier writes kept; optimistic signal and store writes; writes to a node an in-flight action holds; a body that starts another async action; the owned-scope guard.
- **Tests:**
  - Rust: 5 unit tests (rewrite; `yield`/`yield*` refused; nested generators ignored; async generators, references and self-named functions refused; shadowing, foreign `action`, SSR and flag-off left alone).
  - Full suites: compiler Rust 103 tests (3 feature configurations), compiler JS 5,897, signals 1,895.
- **Tier-1 bench** (`heuristic-oracles.bench.ts`, prod tier, two runs): `action` 0.457 ms → `syncAction` **0.370 ms (−19%)** per call with 400 readers, the same as the hand-written batch (0.380 ms).

## Stage 2: memo fusion

The option `memoFusion` (all outputs) is implemented in `packages/compiler/src/memo_fusion.rs`. Its runtime support is effect `equals`, now shipped: `EffectOptions.equals` in `packages/signals/src/signals.ts`, with the flag `CONFIG_EFFECT_EQUALS` in `core.ts` and `status-free.ts`. This replaces the `CONFIG_ORACLE_FUSED` oracle arm.

- **Runtime:** an effect created with `equals` compares each new compute value with the previous one. When they are equal, the effect phase does not run, so a fused memo's cut-off survives in its reader. The first run always goes through: `CONFIG_EFFECT_EQUALS` keeps tracked effects, which set their own `_equals`, on their old first-run rule. Cost: +121 B in the tree-shake budget (conscious bump to 23,100).
- **Candidates:** `const m = createMemo(fn)` with one argument, where `fn` is a non-async arrow or function with no parameters. `createMemo` must be imported from `solid-js` / `@solidjs/signals`.
- **Proof** (per memo, repeated in rounds until nothing changes, so chains collapse from the inside out):
  - **Pure, synchronous body:** refused if it contains `await`, `yield`, `this`, `new`, `super`, JSX, `arguments`, tagged templates, or a call to a runtime import (`untrack`, `createX`, …). Calls are allowed only to zero-argument accessors, known sync globals, or known sync methods.
  - **Exactly one reference:** a zero-argument call `m()`, located after the declaration.
  - **The reader is one of:**
    - **(a)** a JSX expression in the same component, with no callback in between;
    - **(b)** the compute of another `createMemo`;
    - **(c)** the compute of a `createEffect` / `createRenderEffect` that is exactly `() => m()`, with no `equals` in its options.
- **Rewrite:** the read becomes the memo's body (an IIFE for block bodies) and the declaration is removed. An effect reader also gets `{ equals: _$isEqual }`, imported as `isEqual`.
- **Policy** (performance, not safety). Every rule here was priced by the bench below:
  - **Narrowing memos are kept.** A body whose result is a comparison or `!` exists for its cut-off. Most writes leave it unchanged, and a fused reader would re-run on every one of them.
  - **Shared sources are kept.** Every accessor the body reads must be declared in the memo's own scope; for JSX, that is the component, which must not read `props`. JSX grouped-attribute effects are also kept, because fusing one part would cost every part its cut-off.
- **Tests:**
  - Rust: 6 unit tests:
    - chain into an effect with `equals`;
    - two readers, an escape, options, or a wrapped read are all kept;
    - impure, async and parameter bodies are refused;
    - local JSX reads are fused on DOM and SSR, while the shared-source `isSel` is kept;
    - narrowing memos and shared sources are kept;
    - nothing happens when the option is off.
  - Full suites: compiler Rust 109, compiler JS 5,897, signals 1,895.
- **End-to-end bench:** `scripts/heuristics/fusion/bench.mjs`; data in [compiler-heuristics-build/fusion-{1,2}.json](./compiler-heuristics-build).
  - **Method:** the same source is compiled with `memoFusion` off and on, and both run on the shipped prod runtime.
  - **Gate:** values and effect-phase run counts must be identical after mount and after every op (7 rounds).
  - **Timing:** median of 15 interleaved reps; the A/A control stays within ±3% except one mount row at 6.9%. Two runs, n = 1,000:

| Program | Op | Unfused | Fused | Δ (run 1 / run 2) |
| --- | --- | ---: | ---: | ---: |
| chain (compiled) | mount | 1.06 ms | 0.39 ms | **−64% / −64%** |
| chain (compiled) | update all | 0.73 ms | 0.29 ms | **−60% / −62%** |
| chain (compiled) | update every 10th | 0.071 ms | 0.031 ms | **−57% / −58%** |
| cutoff (kept; hand twin) | mount | 0.67 ms | 0.36 ms | −47% / −47% |
| cutoff (kept; hand twin) | writes the cut-off absorbs | 0.196 ms | 0.216 ms | +10% / +12% |
| cutoff (kept; hand twin) | writes that cross it | 0.100 ms | 0.055 ms | −45% / −43% |
| select (kept; hand twin) | mount | 0.62 ms | 0.31 ms | −49% / −47% |
| select (kept; hand twin) | select | 0.134 ms | 0.162 ms | +21% / +14% |

Fusion removes a node per memo, so mount always wins. The loss is on writes a memo would have absorbed: a fused effect re-runs its compute on each of them, and an effect recompute costs more than a memo recompute. The two keep rules give up the mount win to avoid that per-write loss on the shapes where it is likely.

## Stage 3: late-island hydration and the handler → islands map

Lazy hydration is correct only under the hydrate-before-write rule ([resumability.md](./resumability.md)). Before a handler writes, every island that reads what it writes must be hydrated while the state still equals the server's. Stage 3 builds both halves: a runtime that can hydrate an island late, and a compiler map of who reads what.

- **Runtime** (`packages/web/src/client.ts`, `hydrate`):
  - Once the first hydration pass completed (`_$HY.done`), later `hydrate()` calls used to client-render, silently re-creating a late island's DOM.
  - Now a root that still holds unclaimed server markup for its `renderId` reopens hydration:
    - the `hydrating` setter resets the done state and turns snapshot capture back on;
    - `_$HY.r` is never cleared;
    - completion closes hydration again.
  - Roots hydrated before (a `WeakSet`) and roots without server markup keep the render fallback.
  - Test: `packages/web/test/hydration/late-island.spec.tsx`, 3 tests. It fails before the fix: the late island's `<span _hk=b0>` was replaced by a fresh node. The web suites pass (client 818, hydration 207).
- **Compiler: `summarizeIslands(code, { filename })`** (`packages/compiler/src/islands.rs`). Per module, it reports:
  - **Cells:**
    - `[r, w] = createSignal / createStore / createOptimistic*` pairs;
    - *families*, a binding whose initializer creates cells, such as `rows.map(l => createSignal(l))`;
    - *opaque* cells, created any other way.
  - **Records:** every function, plus handler expressions that are not functions. Each record lists its reads, writes, calls and nested records, the imported bindings it references, its escapes, and whether it makes unknown calls.
  - **JSX `on*` handlers**, **module-scope bindings** and **exports**.
- **Compiler: `linkIslands({ modules, resolve, islands })`** (`@solidjs/compiler/islands`). It resolves imports across the graph and closes each record over its calls and nested records. Reads do not flow out of event handlers, because handlers run untracked. It returns:
  - the islands affected by each exported function and each JSX handler;
  - `onEvent`: the islands to hydrate before the first event in an island, meaning the island itself plus everything its handlers can affect.
- **Soundness** (over-approximation):
  - Any reference to an accessor counts as a read.
  - A setter can only run through a reference, and each reference is either a direct call (a write) or an escape.
  - An accessor referenced without a call is a read escape.
  - Families and opaque cells escape both ways.
  - Any record that calls unknown code (a parameter, a member, a module outside the graph) is assumed to write every write-escaped cell and read every read-escaped cell.
  - An island root the summaries do not cover is an error, not a guess.
- **Tests:**
  - Rust: 1 summary test.
  - JS (`__tests__/islands.test.js`), 4 tests:
    - the challenge-2 map, derived exactly;
    - escaped setters through props and unanalyzed imports;
    - opaque state and a read escape through a module object;
    - an unresolvable island root is an error.
  - Full suites: compiler Rust 110, compiler JS 5,901.
- **End to end** (`scripts/heuristics/resume`, strategy **F-linked**):
  - The linker derives the map from `app-islands.jsx`, which has the same DOM as `app.jsx` with state at module scope.
  - Hydration uses the shipped runtime, with no oracle.
  - It passes the equivalence and node-identity gate.
  - It matches the oracle F within ±5% on total CPU at every footer size and throttle ([resumability.md, Stage 3](./resumability.md#stage-3-f-with-the-compiler-map-and-the-shipped-runtime)).

## Stage 4: store scalar replacement

The option `storeScalars` (all outputs) is implemented in `packages/compiler/src/store_scalars.rs`. It needs no new runtime: a replaced store becomes `createSignal` pairs.

- **Proof** (per store; any failure keeps the store):
  - **Declaration:** `const [s, setS] = createStore({ … })` (or `[s]`), with `createStore` imported from `solid-js` / `@solidjs/signals`.
  - **Initial value:** an object literal of `key: <provably primitive>` properties, with no spread, computed or duplicate keys, methods or accessors.
  - **Reads:** every reference to `s` is `s.key` of a known key, in a read-only position: not written, deleted, called, destructured, optional, or `yield*`-delegated.
  - **Writes:** every reference to `setS` is a call `setS(d => …)` whose body is only whole-field writes: `d.key = e`, `d.key op= e`, `d.key++` / `--`. Logical assignments are refused.
  - **What counts as provably primitive** (`e`):
    - a literal, a template, or a unary, binary, update or `typeof` expression;
    - an unshadowed `String`, `Number`, `Boolean` or `BigInt` call;
    - a read of another replaced store's field;
    - a conditional, logical or sequence expression made of those.
  - **Draft use:** the draft appears only as reads of the field being written. There are no closures over it and no nested setter calls.
- **Why this is equivalent** (checked with probes against the runtime):
  - Every field only ever holds a primitive, so a store read returns the value itself (no nested proxy) and compares with `===`, as a signal does.
  - Stores and signals both hold writes until flush; before flush, reads return the committed value.
  - Inside a setter callback, the store's proxy *is* the draft: `d.key` and `s.key` both read the latest value, while other stores and signals read committed values. The rewrite therefore turns a read of the written field into a functional updater's `_$p` (the latest value). A read of any *other* field of the same store inside its setter is refused, because signals have no latest-value read.
  - Returned values: a non-object return from a store setter callback is ignored, and the rewrite discards it too.
- **Rewrite:**
  - The declaration becomes `[_$s_key, _$set_s_key] = createSignal(init)` per field, and reads become `_$s_key()`.
  - A setter call becomes an IIFE of `_$set_s_key(…)` calls. A right-hand side is hoisted into a `const` when it does not read its own field, and moved into the updater when it does.
  - Replacements are generated from source text and parsed (the pass runs first, on the authored program). Every fragment must parse before anything is rewritten.
- **Tests:**
  - Rust: 3 tests:
    - the rewrite, including hoisted and updater forms, cross-store reads, and same-store draft reads;
    - 18 refusals (escapes, unknown or dynamic keys, nested or non-primitive values, `let`, non-field or conditional writes, returned objects, a setter passed as a value, a closure over the draft, another field read inside the store's own setter);
    - JSX on DOM and SSR, and nothing when the option is off.
  - Full suites: compiler Rust 113, compiler JS 5,901.
- **End-to-end gate and bench:** `scripts/heuristics/fusion/stores.mjs`; data in `compiler-heuristics-build/stores-{1,2}.json`.
  - **Method:** the same source is compiled with `storeScalars` off and on, and with `memoFusion` added; everything runs on the shipped prod runtime.
  - **Gate:** values and effect runs must be identical after every op. Ops include an async `action` whose writes are held by the transition.
  - **What the gate caught during development:** a same-store read inside the setter (`d.label = "c" + s.count`) diverged, with 3 in the store against 1 in the signal. That led to the draft rule above.
  - **Refusal control:** a store that escapes (`JSON.stringify(s)`, a stored setter) compiles unchanged.
  - **Timing:** 15 interleaved reps × 40 iterations, n = 1,000, two runs:

| Program | Op | Store | Signals | Δ (run 1 / run 2) |
| --- | --- | ---: | ---: | ---: |
| rows (per-row `{ label, selected }`) | mount | 4.12 ms | 1.89 ms | **−54% / −60%** |
| rows | update every 10th label | 0.121 ms | 0.035 ms | **−71% / −71%** |
| rows | select (2 rows) | 0.006 ms | 0.003 ms | **−51% / −49%** |
| rows | append to every label | 1.68 ms | 0.49 ms | **−71% / −72%** |
| counter (module store, action) | mount | 0.49 ms | 0.39 ms | **−21% / −19%** |
| counter | click (2 fields) | 0.40 ms | 0.27 ms | **−33% / −35%** |

The A/A control is within ±3%, except rows mount at −9% / −12% (GC-heavy). Adding `memoFusion` on top, where a replaced read makes `createMemo(() => row.selected ? … )` fusable, stays within noise of `storeScalars` alone.

- **Coverage** (the real limit, as the oracle study predicted): on the 206-file corpus of round 3 (`r3/store-census.json`), the pass replaces **0 of 15** stores. Real stores are arrays (`createStore<LogEntry[]>([])`, todo lists) or nested objects, are exported, or pass their setter around. The census's looser "S2 full" count of 1 was an exported array store. The pass therefore fits flat UI state (counters, form fields, toggles, per-row flag objects). Array- and row-level replacement would need `<For>` / `mapArray` integration and is not built.
