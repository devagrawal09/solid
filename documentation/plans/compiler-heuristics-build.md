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
| 3 | Per-island hydration + compiler handler → island map (F) | Next |
| 4 | S2 store-free compilation | Planned |
| 5 | C pruned resumability | Planned |

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
