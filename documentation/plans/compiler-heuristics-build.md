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
| 2 | H1 memo fusion | Next |
| 3 | Per-island hydration + compiler handler → island map (F) | Planned |
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
