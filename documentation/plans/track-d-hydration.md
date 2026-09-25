# Track D — Strict SSR/Hydration Optimizations

Status as of 2026-09-25. Track D implements, in strict sequence:

1. **Prerequisite** — JSX `$` block server/client hydration-id parity.
2. **Slice 5** — server-authoritative replay elimination.
3. **Slice 6** — inert-region hydration elimination.

Each step is a separate commit. Slice numbering follows "Optimization
Prototype Slices" in `typed-generator-compiler.md`. Resumable events (slice 8)
and deferred feature regions are out of scope. The general bundler/linker is
Track C; this track only defines and consumes a narrow summary contract.

Environment for every number below: Linux container, Node v22.22.2,
rustc 1.95.0, vitest 4.1.6, jsdom 25. Timings are wall-clock in a shared
container and are noisy; each is reported with its raw samples.

---

## Prerequisite: JSX `$` block hydration-id parity

### Reproduction

Ten block scenarios were added to the hydration parity harness
(`packages/web/test/harness/block-scenarios.tsx`, spread into
`scenarios.tsx`). Both harness halves compile the same source, one with the
ssr generate and one with the dom generate. On the unfixed runtime the client
half failed 5 tests:

| Scenario | Symptom |
|---|---|
| `block-in-element-hole` | Server `<b _hk=4>`, client asks `1`. Server `<h4 _hk=20>`, client asks `40`. |
| `block-loading` (loaded, streamed) | Server `<div _hk=0002>`, client asks `0010`. The DOM went detached, so the post-hydration refresh never showed. |
| `block-errored` | Server fallback `<p _hk=21>`, client asks `20`. |
| `block-list` | A scenario selector bug, not a parity defect. |

### Root cause

A component returning `$(function* () { return <…/> })` returns an
unevaluated block. The JSX is created only when a sink runs the block.

- **Client:** `insert(parent, block)` runs it immediately, in source order.
  A flow control's `flatten` runs it inside that control's computation.
- **Server:** `escape(block)` defers it to `ssr()` hole resolution. That
  happens after later siblings have registered and taken their id slots.

Content ids came from the sink's counter at different moments, under
different owners.

A second, server-only defect surfaced in `block-errored`. An error thrown
while a lazy hole resolves is rethrown through every enclosing resolver
catch, and each catch re-invoked the `<Errored>` handler. The fallback was
rendered twice, spending an extra id slot. Any lazily resolved hole could hit
this; blocks made it common.

### Fix

- **Compiler (`packages/compiler/src/block_scope.rs`).**
  - Wraps every `$` block whose function body contains JSX:
    `$(fn)` becomes `$(_$blockScope(fn))`.
  - Adds `blockScope as _$blockScope` to the `$` import.
  - The decision is syntactic and runs in one pass shared by every
    generate, after generator lowering and host fusion and before JSX
    lowering. The dom and ssr outputs therefore wrap exactly the same blocks.
  - It runs only for `hydratable` builds.
- **Client runtime (`@solidjs/signals`).**
  - `blockScope` lives in `generator.ts`.
  - `reserveIdScope`, `runInIdScope`, and `idScopeEndCount` live in
    `core/owner.ts`.
  - One child-id slot is reserved at block creation. Every run swaps the
    counter owner's `id` and `_childCount` to `(scopeId, 0)` and restores
    them after, the same virtual scope as the server's `ssrScope`.
  - A generator (runtime-driven) body keeps the scope across its steps.
  - Outside an id-carrying tree it returns the body untouched.
- **Server runtime (`solid-js` server `signals.ts`).**
  - `blockScope` is a slot-for-slot twin of the client implementation.
  - `createErrorBoundary` handles an error once per pass.
  - It serializes under the boundary id captured at creation. A block scope
    may have the owner's id swapped while the error surfaces.
- **Exports.** `blockScope` is exported from `@solidjs/signals`, `solid-js`,
  and `solid-js` server. Both entries export it, so export parity holds.

### Tests

Commands, run from the repo root unless noted:

```sh
# compiler pass unit tests (5)
cd packages/compiler && cargo test --lib block_scope
# client/server runtime id parity (5 new tests in the file)
cd packages/solid && npx vitest run test/id-parity.spec.ts
# parity harness: server half writes artifacts, client half hydrates them
cd packages/web && npx vitest run --config vite.config.server.mjs test/server/hydration-harness.spec.tsx
cd packages/web && npx vitest run --config vite.config.hydrate.mjs test/hydration/parity-harness.spec.tsx
```

The harness now has 14 block scenarios covering:

- nested block components,
- branches inside blocks and a block chosen by a branch,
- lists of block rows,
- `<Show>` with block children, including one followed by id-allocating
  siblings,
- `<Loading>` with a block that reads async data in a JSX hole, and one that
  reads it directly in its body so the server retries it,
- `<Errored>` with a block, plus a plain-component control,
- stores: a direct path read, `readStore` driving a list, and block rows
  reading store paths.

The runtime tests cover deferred runs, reruns, a failed-then-retried run,
generator stepping, nesting, and the no-id passthrough.

**A/B proof.** With `blockScope` forced to return the body unchanged on both
sides, the client harness failed 6 of 117 tests:

- `block-in-element-hole`
- `block-loading` in both replay modes
- `block-direct-async` in both replay modes
- `block-show-then-siblings`

With the fix, all 117 pass.

**Suites after the change:**

| Suite | Result |
|---|---|
| signals | 1803 passed, 1 skipped |
| solid | 600 passed |
| web client | 748 passed |
| web hydrate | 184 passed |
| web server | 804 passed, 1 failed, 2 skipped |
| compiler Rust | 80 passed |
| compiler fixtures | 5820 passed, 3 failed |
| `todos-blocks` | 6 passed, and its `solid-tsc` typecheck passes |
| type tests | solid and web `test-types` pass |

Both failures are pre-existing and unrelated:

- **Web server.** `server-functions-adapter-request` expects Node to reject
  a duck-typed `AbortSignal`, and Node 22.22 accepts it.
- **Compiler fixtures.** The `fusion-memo-effect`, `fusion-paths`, and
  "erases path reads" fixtures belong to the uncommitted host-fusion
  `readValue` work already in the working tree. Their outputs were not
  regenerated. The fixtures are not hydratable, so this pass never runs on
  them.

### Measurements

**Bundle cost.** Measured only where an app imports the helper: a
hydratable build with at least one JSX block. esbuild `--minify`, gzip -9.

| Entry | Min bytes | Gzip bytes |
|---|---|---|
| client `{ $, renderBlock }` | 21597 | 8693 |
| client `+ blockScope` | 22320 (+723) | 8990 (+297) |
| server `{ $, renderBlock }` (signals external) | 699 | 421 |
| server `+ blockScope` | 1784 (+1085) | 929 (+508) |

**Per-run overhead.** Client prod build, 1,000,000 calls of a trivial body,
15 alternating samples after warmup, two process runs:

| Variant | Run 1 min / median / max (ns) | Run 2 min / median / max (ns) |
|---|---|---|
| plain body | 3.9 / 4.0 / 7.5 | 3.9 / 3.9 / 4.3 |
| `blockScope` | 20.4 / 20.8 / 33.8 | 19.5 / 20.3 / 21.6 |

That is about 16 ns per block run. A first version allocated a closure and a
state object per run and measured 26–31 ns median; the version kept passes
arguments instead. The overhead is negligible next to one template claim.

### Limitations

- **Shared scope.** One block value rendered at two live positions at the
  same time shares its scope, which produces duplicate keys. Create one
  block per position.
- **Babel and `generators: false`.** Babel-JSX mode (`JSX_COMPILER=babel`)
  and `generators: false` emit no wrapper on either side. That is
  consistent, but the original drift remains in those modes.
- **Syntactic trigger.** A block that returns JSX created elsewhere is not
  wrapped. That JSX was already allocated at its own creation point, so the
  gap only matters for manual `createComponent` calls inside a block.
- **Virtual scope.** The swap has the same envelope as `ssrScope`: code
  reading the counter owner's `id` for non-allocation purposes during a
  block run sees the scope id. The only such reader found, `<Errored>`
  serialization, now captures its id.

### Decision

**KEEP.** Strict SSR is unblocked, and slices 5 and 6 build on it.

---
