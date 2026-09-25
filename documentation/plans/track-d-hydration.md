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

## Slice 5: server-authoritative replay elimination

### Baseline behavior

A hydrating client re-ran every `ssrSource: "server"` memo.

- **Async memos.** The client adopted the serialized value but still ran the
  compute through `subFetch`, with `fetch` and `Promise` mocked, to trace
  dependencies. Sorting or formatting inside the compute ran again.
- **Sync memos.** They were never serialized, so the client recomputed them.
- **Consumers.** Every consumer linked to the memo node, and every rendered
  read got a binding effect.

### Mechanism

The compiler pass `packages/compiler/src/server_authority.rs` runs only with
the `serverAuthority` option on hydratable builds. It runs before JSX lowering
on the shared AST, so the dom and ssr generates make identical decisions.

A `const X = createMemo(fn, opts)` is **sealed** only when all of these hold.
Anything the pass cannot classify is rejected.

1. **Explicit authority.** `opts` is an object literal with a literal
   `ssrSource: "server"`, no spread or computed key, and no `transparent`.
   `"hybrid"` and `"client"` are rejected as revalidating or client-specific.
   A memo relying on the implicit default is not a candidate.
2. **Client-independent inputs.** Every free variable in `fn` must be one of:
   - another sealed memo, read as `Y()`;
   - a frozen signal or store: created from literal data, with its setter
     never referenced (the setter-escape proof);
   - a module-level primitive `const`;
   - a same-module function proven pure;
   - an import the cross-module summary declares `pure` or `server` (`server`
     only in call position);
   - an allowlisted pure global: `Math` without `random`, `JSON`, `Number`,
     `fetch`, and similar.

   Rejected: client globals (`window`, `document`, `Date`, `Intl`,
   `Math.random`, `isServer`), component props and outer parameters, and
   anything unknown.
3. **No invalidation.** Every reference to `X` is a read: `X()`, the lowered
   `_$perform(X)`, or `yield* X`. Passing the accessor to `refresh`, a prop, an
   argument, or an export rejects it. Generator computes, which are live
   sources, and scheduling APIs (`setInterval`, `setTimeout`, `EventSource`,
   and others) are rejected.
4. **Immutable authority.** The adopted value is shared by reference. Every
   read is followed through member chains, local aliases, iteration callbacks,
   `<For>`/`<Show>` render parameters, and same-module component props. It is
   rejected on:
   - a mutation;
   - a pass to an unknown function or unsummarized component;
   - a store into an escaping position.

   A fresh copy (`[...X()].sort(pure)`) may be mutated. Its elements may not.
5. **No client-visible side effects.** No assignment outside the compute's
   locals, and no JSX.

Sealed-ness is a fixed point. A memo that reads, or flows into, a rejected
memo is rejected too.

**Rewrites.** All are identical on both generates.

- **Sealed memos.** They get `$sealed: 1` in their options. A memo whose every
  read sits inside another sealed compute gets `$sealed: 2` (compute-only).
- **Accessor text holes.** `{X()}` as the whole child expression of an
  intrinsic element becomes `{X}`, so the renderer receives the accessor.
- **Row bindings.** Take a render callback whose parameter is exactly a sealed
  memo's data: `<For each={X()}>` or keyed `<Show when={X()}>`, not merged
  with other data and never reassigned. When it returns JSX unconditionally,
  its intrinsic-element child and plain-attribute expressions are hoisted into
  `const`s at the top of the callback. This applies only to expressions that
  read that parameter and constants through pure operations.

**Runtime.**

- **Server.** It serializes `$sealed: 1` synchronous values. `$sealed: 2`
  memos ship nothing, async values included.
- **Client.** `hydratedCreateMemo` adopts a present, settled record as
  `constantAccessor(value)`. That means no node, no compute, and no links. It
  still consumes the memo's id slot. A missing, pending, or rejected record
  falls back to the ordinary hydrated memo. A `$sealed: 2` memo falls back to
  a lazy hydrated memo, which computes only if some reader falls back.
- **Insert sink.** `insert()` inserts a `$sealed` accessor once, with no
  effect.

### Tests

```sh
cd packages/compiler && cargo test --lib server_authority          # 13 tests
cd packages/web
npx vitest run --config vite.config.server.mjs test/server/hydration-harness.spec.tsx
npx vitest run --config vite.config.hydrate.mjs test/hydration/parity-harness.spec.tsx test/hydration/track-d-authority.spec.tsx
# baseline: prefix both with SOLID_SERVER_AUTHORITY=0 (server first)
SOLID_AUTHORITY_REPORT=1 …    # prints every decision and rejection reason
```

- **Positive fixtures.** A fetch, sort, format, and title chain; a sync frozen
  store sorted and formatted; accessor text holes; row-binding hoists;
  compute-only marking; summarized readonly components.
- **Refusal fixtures.** Each of these is rejected with a specific reason:
  - client-specific inputs (`window`, `Date`, `isServer`, `Math.random`);
  - `"hybrid"`, `"client"`, and `transparent` sources, and the implicit
    default;
  - an escaped setter, and `refresh`;
  - an unsummarized import, props, `setInterval`, a generator, and a
    non-inline compute;
  - mutation by `.sort()`, member assignment, an aliased assignment, a mutating
    local component, and an update expression;
  - dependency and flow propagation;
  - unknown component children and props, and an escaped accessor.

  Row hoisting is refused for a merged `each`, `keyed={false}`, a
  conditional-return callback, component children, and a reassigned
  parameter.
- **Harness scenarios.** Parity passes with sealing on and off:
  - `authority-catalog`: 4 rows, each with a live button, plus a live cart
    signal;
  - `authority-bulk`: 200 rows;
  - `authority-sync`: a text hole and an attribute;
  - `authority-rejected-live`: a refusal that must still update.
- **Slice spec.** `track-d-authority.spec.tsx` asserts zero client calls of
  the fetcher, comparator, and formatter when sealed, and nonzero in the
  baseline. It clicks a row button to prove live descendants are retained.
  It passes in both modes.

Full suites with slice 5 applied:

| Suite | Result |
|---|---|
| signals | 1803 passed |
| solid | 600 passed |
| web client | 748 passed |
| web hydrate | 194 passed |
| compiler Rust | 93 passed |
| todos-blocks | 6 passed |

Two failures are pre-existing and unrelated: the Node 22 abort-signal test in
the web server suite (808 passed, 1 failed) and three host-fusion fixtures in
the compiler fixture suite.

### Measurements

Raw logs are in `documentation/plans/track-d-raw/slice5-*.txt`.

**Census.** Dev build, one hydration each.

| Scenario | Computations | Effects | Links | Client fetch / sort / format calls |
|---|---|---|---|---|
| bulk, baseline | 418 | 406 | 16 | 1 / 1266 / 200 |
| bulk, sealed | 15 | 5 | 10 | 0 / 0 / 0 |
| catalog, baseline | 26 | 14 | 16 | 1 / 5 / 4 |
| catalog, sealed | 15 | 5 | 10 | 0 / 0 / 0 |
| sync, baseline | 5 | 3 | 19 | — |
| sync, sealed | 3 | 2 | 0 | — |

Owners are unchanged, 208 on the bulk page, because rows keep their owners for
the live buttons.

**Hydration time and allocation.** Production bundles in jsdom (`--expose-gc`,
64 MB semi-space), 40 samples after 8 warmups, 3 interleaved rounds. This is
the synchronous `hydrate()` plus `flush()` walk.

| Scenario | Median ms, baseline | Median ms, sealed | Median allocated, baseline | Median allocated, sealed |
|---|---|---|---|---|
| bulk | 8.53 / 8.27 / 8.51 | 7.25 / 7.44 / 7.22 | 2.09 / 2.06 / 2.05 MB | 1.71 / 1.72 / 1.71 MB |
| sync | 0.89 / 0.87 / 0.90 | 0.68 / 0.72 / 0.68 | 83.8 KB | 37.4 KB |
| catalog | 1.20 / 1.23 / 1.27 | 1.19 / 1.23 / 1.15 | 123–125 KB | 106 KB |

The catalog timing difference is within noise; its p90 reaches 1.5–1.9 ms in
both modes. jsdom DOM claiming dominates small pages.

**Bytes.**

| Measure | Baseline | Sealed |
|---|---|---|
| Bulk data, raw | 11,226 B | 11,934 B |
| Bulk data, gzip / brotli | 3,144 / 1,865 B | 3,144 / 2,162 B |
| Catalog data, raw | 2,122 B | 2,049 B |
| Sync data, raw | 0 B | 55 B |
| Client runtime, hydrating-app entry, min / gz | 83,576 / 30,271 B | 84,003 / 30,383 B |
| Server `solid-js` dist | 73,015 B | 73,148 B |

- The bulk gzip size is equal by coincidence; brotli differs.
- The client runtime difference is +427 B minified and +112 B gzipped.
- HTML is unchanged in every scenario.

### Limitations

- **Intra-module proof.** Cross-module facts come only from the explicit
  summary option, the contract a Track C linker would produce. Props are
  never trusted.
- **Only `createMemo`.** Projections and function-form stores and signals are
  not sealed.
- **No adoption of rendered branches.** `<Show>` and `<For>` still create
  their memos, now with no links. Removing them needs a compiler branch
  rewrite.
- **Attributes.** Attributes reading a sealed accessor keep their effect,
  with no link. Only row-parameter attributes are hoisted.
- **Seroval de-duplication.** It is per payload. A value shared across modules
  with a mutating consumer is outside the proof.
- **No dev verification.** Development builds do not yet check the proof at
  runtime, for example by freezing adopted values.

### Decision

**KEEP.** Measurable CPU, allocation, node, and link reductions on data-heavy
pages. The data-byte cost is bounded by the compute-only rule. Every
uncertain case falls back to ordinary hydration.

---

## Slice 6: inert-region hydration elimination (smallest safe form)

### Baseline behavior

A hydrating client reruns every component, even one whose markup can never
change:

- it calls the function;
- it claims each template root from the key registry (`getNextElement`);
- it walks the claimed DOM;
- in dev and observe builds, it creates a component owner.

The server stamps a `_hk` key on every one of those roots.

### Proof

The pass is `packages/compiler/src/inert_regions.rs`, behind the
`inertRegions` option on hydratable builds. It is intra-module and syntactic,
and anything unproven keeps ordinary hydration.

A same-module component is **inert** only when all of these hold:

- **No caller input.** It takes no props: no parameter, or one never
  referenced. That also excludes `children`.
- **Nothing executes.** The body is exactly `return <jsx/>`, or an arrow's JSX
  body. No statements, calls, reads, writes, `onCleanup`, `useContext`, or
  `isServer` logic can run.
- **Static markup only.** It uses only intrinsic elements (custom elements
  with a `-` are refused because they may upgrade), fragments, text, and
  literal expression containers.
- **Plain attributes.** Every attribute is a plain name with a literal value.
  No `on*` events, no `ref`, no namespaced `use:` / `prop:` / `on:`
  directives, and no spreads.
- **Inert descendants.** Every nested component is itself inert, or is an
  import the summary declares `inert-component`. A runtime component (`Show`,
  `For`, `Loading`, `Errored`, context providers) is refused because it
  receives props or children. That rules out boundaries and interactive
  descendants.

A **use site** `<X />` (no attributes, no children) is rewritten only when it
sits unconditionally inside intrinsic elements of a function's returned JSX
root. It becomes a hole holding a hoisted
`const _$inertN = _$inert(() => <X />)`.

Not rewritten, so they keep full hydration:

- conditional and ternary positions;
- component children, such as `<Show><X/></Show>`;
- a component's own root;
- use sites inside inert components.

### Runtime

- **Server.** `@solidjs/web` `inert()` calls the new `solid-js` internal
  `runInert()`. It renders under a transparent owner, which consumes no id
  slot, with the no-hydration context set, so no `_hk` keys are emitted and no
  ids are allocated.
- **Client while hydrating.** `inert()` returns a sentinel. `insert()` leaves
  the server's nodes in place and returns. Nothing is called, claimed, or
  owned.
- **Client otherwise.** Client-only mounts, rows added later, and fresh clones
  render normally.
- **Id parity.** Neither side allocates ids for the region, so parity holds.
  The parity harness passes with the pass on and off.

### Tests

```sh
cd packages/compiler && cargo test --lib inert_regions     # 4 tests
cd packages/web && pnpm run test:track-d                    # harness + slice 5/6 specs, inert on
# baseline: the default configs (inert regions are opt-in, SOLID_INERT_REGIONS=1)
```

- **Compiler, proven and rewritten.** A static footer with a nested inert
  icon; an arrow component; a summarized imported inert component; use sites
  in a live component.
- **Compiler, refusals.** Each is refused with a specific reason:
  - a signal read, an `onClick`, a `ref` attribute or ref variable, and a
    `use:` directive;
  - `useContext`, `onCleanup`, a `<Show>` boundary, and `isServer`;
  - `props.children`, a spread, a custom element, and a nested non-inert
    child;
  - an unsummarized import, and non-literal attributes.
- **Compiler, use sites left alone.** A conditional use site, a
  component-children use site, a use site with attributes, and a
  component-root use site.
- **Harness scenarios.** Parity passes in both modes, and with inert on
  (`test:track-d`: 87 server renders, 141 client tests):
  - `inert-footer`: inert regions beside a live counter;
  - `inert-nested-live`: inert regions inside a live component, between live
    descendants;
  - `inert-in-for`: inert icons in live `<For>` rows, plus a row added after
    hydration;
  - `inert-in-loading`: an inert region inside a streamed `<Loading>`
    boundary, in both replay modes;
  - `inert-refused`: an event-handling component that keeps its key and
    handler;
  - `inert-bulk`: 60 cards.
- **Slice spec.** `track-d-inert.spec.tsx` asserts:
  - inert nodes keep their identity through hydration and a later update, and
    carry no `_hk`;
  - live parts update;
  - the refused handler fires;
  - client-only rendering still renders the regions.

**Why opt-in in the shared web configs.** With inert regions on, the existing
`ssr-stream.spec.tsx` "preserves hydration key order…" test fails. Its
`Sibling` component is static, so it is correctly proven inert and loses its
`_hk`, which that test asserts literally. The behavior is correct; the test
encodes the old key layout. It is left untouched.

**Full suites with slice 6 applied.** Default configs: signals 1803, solid
600, web client 748, web server 814 (1 known failure), web hydrate 208,
compiler Rust 97, todos-blocks 6. Solid and web type tests pass.

### Measurements

Raw logs are in `documentation/plans/track-d-raw/slice6-*.txt`.

**Census.** Dev build, one hydration each.

| Scenario | Keys, baseline | Keys, inert | Owners, baseline | Owners, inert |
|---|---|---|---|---|
| inert-bulk (60 cards) | 123 | 1 | 124 | 2 |
| inert-footer | 4 | 1 | 5 | 2 |
| inert-nested-live | 4 | 2 | 5 | 3 |
| inert-in-for | 5 | 3 | 8 | 6 |
| inert-in-loading | 2 | 1 | 6 | 5 |
| inert-refused | 4 | 2 | 5 | 3 |

Computations, effects, and links are unchanged: inert regions had none.
Production builds create no component owners, so there the savings are the
skipped component calls, key claims, and DOM walks.

**Hydration time and allocation.** Production bundles in jsdom, 40 samples
after 8 warmups, 3 interleaved rounds.

| Scenario | Median ms, baseline | Median ms, inert | Median allocated, baseline | Median allocated, inert |
|---|---|---|---|---|
| inert-bulk | 4.10 / 3.94 / 3.83 | 2.39 / 2.21 / 2.36 | 1.03–1.05 MB | 377 KB |
| inert-footer | 0.77 / 0.77 / 0.76 | 0.67 / 0.66 / 0.64 | 64.5 KB | 47.1 KB |
| inert-nested-live | 0.75 / 0.80 / 0.76 | 0.74 / 0.71 / 0.77 | 65.7 KB | 55.1 KB |

The nested-live timing difference is within noise; its p90 is about 0.8–1.0
ms in both modes.

**Bytes.**

| Measure | Baseline | Inert |
|---|---|---|
| inert-bulk HTML, raw / gzip | 16,675 / 724 B | 15,767 / 399 B |
| inert-footer HTML, raw / gzip | 366 / 267 B | 348 / 258 B |
| Client runtime, hydrating-app entry, min / gz | 84,003 / 30,389 B | 84,161 / 30,427 B |
| Compiled scenario module, min / gz | 8,531 / 2,609 B | 9,455 / 2,951 B |

The compiled module grows by 924 bytes minified (342 gzipped) because each
use site gets a hoisted thunk and the inert components' code still ships.
For comparison, slice 5's compiled module difference is +74 / +14 B.

### Limitations and blockers

- **Client code is not omitted.** Omitting it would need proof that a use site
  never renders outside hydration: no client navigation re-mount, no
  enclosing branch toggle. That is a whole-graph reachability fact.
  **Blocker: Track C linker.** The contract to consume is "use site S is
  hydration-only". This pass would then drop the thunk and let the bundler
  shake the component.
- **Use-site shape.** Only prop-less use sites in unconditional intrinsic
  positions qualify. Static components that take literal props, or sit inside
  flow controls, keep hydrating.
- **Cross-module facts.** They come only from the `authoritySummary`
  `inert-component` kind. Which components are proven is reported under
  `SOLID_AUTHORITY_REPORT=1` (`[solid inert]`), for a linker to lift into
  summaries.
- **Tooling interactions.** HMR (`hot`) wrappers and Babel-JSX mode don't
  combine with the pass. Both sides must compile with the same option.

### Decision

**KEEP**, as opt-in: a large win on static-heavy pages (the 60-card page is
42% faster with 64% less allocation) at a small byte cost. **ITERATE** on
code omission, which is blocked on Track C.

---

## Integration contracts and blockers for Track C

- **Summary interface.** `authoritySummary` maps
  `module → export → pure | server | readonly-component | inert-component`.
  The same object must reach the server and client compiles. Today it is
  hand-supplied; a linker should produce it from the per-module reports.
- **Needed from the linker:**
  - prop-authority facts, so sealed memos can read props;
  - hydration-only reachability of use sites, for slice 6 code omission;
  - cross-module mutation facts for shared adopted values.
- **Not done in Track D:** projection and store sealing, rendered-branch
  collapse for `<Show>`/`<For>`, resumable events, and deferred feature
  regions (the last two are out of scope).
