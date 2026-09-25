# Resumable event blocks — first-interaction-correct vertical slice

Status as of 2026-09-25: experimental, private prototype on
`experiment/resumable-event-first-interaction` (branched from
`experiment/iterable-signals` at `f1ee7fd6`). Off by default everywhere. Not
part of the accepted RFC scope ([`compiled-signals-rfc.md`](../compiled-signals-rfc.md)
still lists resumability under later decisions); this document records what
was built, what it proves, what it refuses, and what it measured.

## Findings first

1. **Both required fixtures are implemented and run the first event exactly
   once without invoking the component.** Fixture 1 (event-only strict handler
   with a props-derived value, a module literal and a registered server action
   as captures) and fixture 2 (a local `createSignal(0)` counter with an exact
   text binding) are exercised end to end — server render, inline bootstrap,
   cold click, module load, scope reconstruction, later warm clicks — in
   `packages/resumable/test/client/resume.spec.js:80-422` and in the web
   conformance harness (`packages/web/test/conformance/scenarios/resumable.ts`,
   modes `server/resumable` and `hydrate/resumable`). The conformance trace
   pins the timing difference explicitly: the html recorded inside the first
   dispatch still shows `0`; the handler's `run inc` lands after the module
   settles; the second click is warm and synchronous.
2. **One graph controls everything, as Marko's design demands.** The compiler
   pass (`packages/compiler/src/resumable.rs`) produces, from the strict
   `$(fn)` analysis it already has, a per-module plan: which handlers resume
   and why, each handler's captures with a reason code, its synchronous
   prelude, the exact event fields it reads, the per-instance values the
   server must serialize, the exact text bindings the client may
   reconstruct, and the element coordinates. The same plan drives the SSR
   rewrite (`resumable.rs:2289`), the separate event module
   (`resumable.rs:2504`), the manifest, the bootstrap and the runtime.
   Nothing is derived twice.
3. **Fail-closed at every layer, visibly.** Compile time: any capture that is
   not a serialized value, a literal constant, a link-verified import or a
   signal the scope reconstructs is refused with a reason at its site
   (`resumable.rs:1902`), and `require` turns that into a build error.
   Render time: a value that is not data refuses the instance
   (`packages/resumable/src/server.js:63-125`) and emits `data-sr-refused`
   instead of a coordinate. Dispatch time: a missing or stale record, a
   schema mismatch, a module whose handler hash or action id differs from
   the manifest, a chunk that fails to load, a DOM that no longer matches
   the scope descriptor — each is reported through one channel
   (`packages/resumable/src/bootstrap.js:212-296`, `376-425`, `456-477`), never a silent drop.
4. **Measured: initial JavaScript drops from ~19.6–30.6 KB gzip (ordinary
   hydration entry for the same fixtures) to 2.9 KB gzip (inline
   bootstrap), plus ~0.5–0.7 KB of manifest and 130–180 B of coordinates and
   records per page. The first interaction then pays 10.7 KB gzip for the
   event-domain runtime (the reactive core) plus the event chunk (0.2 KB for
   the counter; 4.6 KB + 14.8 KB shared server-function client for the
   action fixture).** In-process cold first-click latency is ~7.5 ms; warm
   is 0.3–1.5 ms. See [Measurements](#measurements) — and the caveat there:
   for an event-only page the runtime chunk is dead weight the prototype
   does not yet split, and a real network round-trip dominates the cold
   number.
5. **What was refused rather than faked.** Nested components in a resumable
   template, any dynamic attribute, props read reactively, stores, memos,
   mutable closure state, event escapes, unverified imports, module-level
   functions, and any signal that is read anywhere the client will not run —
   all refuse with a code. The prototype does not attempt streaming, frames
   integration, prefetch policies, hydration/resume mixing on one page, or a
   hydrated `Errored` receiving a resumed failure (the coordinate is recorded
   and routed; the receiver registration is a runtime seam the prototype
   only exercises from tests).

## Scope of the slice

Required by the task and implemented:

| Requirement | Where |
| --- | --- |
| Opt-in private prototype, DOM generate untouched, off by default | compiler option `resumableEvents` (`packages/compiler/index.js:415`, `src/compiler.rs`); `packages/resumable` (`private: true`) |
| Fixture 1: event-only strict handler, scalar / action captures | `packages/resumable/test/fixtures/buy/`; compiler fixture `__tests__/resumable/fixtures/buy` |
| Fixture 2: `createSignal(0)` counter, exact text binding, first click 0→1 once | `packages/resumable/test/fixtures/counter/`; compiler fixture `__tests__/resumable/fixtures/counter` |
| Stable event / owner / boundary coordinates and versioned manifest | `data-sr="<hydration key>/<element index>"`, `_hk`, record `sr:<key>` with `b: <boundary id>`; manifest `schema: 1`, `build` hash, per-handler `source` hash |
| Minimal delegated bootstrap: snapshot, synchronous prelude, separate module, liveness, owner/error route, exactly once | `packages/resumable/src/bootstrap.js` (7.1 KB raw / 2.9 KB gzip minified, no imports) |
| Narrow resume-scope IR (signal + existing text binding, no component run, no re-render) | `ScopePlan` in `resumable.rs:236`, `reconstruct` in `packages/resumable/src/runtime.js:96` |
| Conformance adapter with explicit timing differences | `packages/web/test/conformance/harness/modes.ts` (`server/resumable`, `hydrate/resumable`), `harness/runner.ts` `observeResume`, `scenarios/resumable.ts`, `COVERAGE.md` |
| Mutation tests: swallowed / duplicated first click | `test/client/resume.spec.js` "mutation tests" |
| Prod / dev comparison | `test/client/resume.spec.js` "prod / dev parity" |
| Measurements, full-route accounting, baseline | `packages/resumable/scripts/measure.mjs`, `measurements/results.json` |

## Architecture

```
authored .tsx ─┬─ strict analysis (strict.rs) ──► BlockSpans + StrictAnalysis
               │
               └─ resumable::analyze (resumable.rs) ──► Plan
                       │  scopes: values, signals, text bindings, elements
                       │  handlers: captures[reason], prelude, snapshot, source hash
                       │  diagnostics: resumable | hydrated(reason)
                       │
          ┌────────────┼──────────────────────────────┐
          ▼            ▼                               ▼
   emit_module()   rewrite() (SSR only)         Plan::to_json()
   event module    _$srScope / $sr / $srel      per-module manifest
   (verbatim AST,  → server runtime emits       (schema 1)
   source map)     _hk, data-sr, sr:<key>
          │            │                               │
          ▼            ▼                               ▼
   build driver / Rollup plugin: chunks + runtime + whole manifest (build hash)
          │
          ▼
   page = HTML + <script>_$HY.r["sr:<key>"]=…</script> + inline bootstrap(manifest)
          │
          ▼ first event on [data-sr]
   bootstrap: prelude (live) → snapshot → queue → import(runtime, module) → verify
              → reconstruct scope once → invoke once per queued event, flush between
   later events: invoke synchronously with the live event
```

### The graph contract (manifest, schema 1)

Per module, from `transform()` as `result.resumable`
(`packages/compiler/types.d.ts` `ResumableManifest`):

- `module`: xxhash32 of the root-relative filename (the same hash family the
  server-function ids use, `src/shared/xxhash.rs`), so server and client
  builds of one checkout agree.
- `scopes[]`: `id` (`<module>.s<n>`), `component`, `values` (keys the server
  serializes per instance, in order), `signals`, `bindings[]`
  (`{ kind: "text", path: [element child indexes], hole: n | null, signal }`),
  `elements[]` (`{ path, on: { <event>: <handler id> } }`).
- `handlers[]`: `id` (`<module>.h<n>`), `scope`, `block` (the strict summary
  id), `event`, `export`, `source` (xxhash32 of the callback text), `async`,
  `captures[]` with `kind` ∈ `value[reason]` | `constant` | `signal-setter` |
  `signal-accessor` | `import[action|trusted]`, `prelude[]`
  (`preventDefault` / `stopPropagation` / `stopImmediatePropagation` /
  `guard{path,test,value?}`), `snapshot[][]` (approved event paths).
- `diagnostics[]`: per handler and per scope, `resumable` or `hydrated` with
  a reason code and the authored site.
- `eventModule`: `{ name, code, map }`.

The route manifest the driver assembles adds `build` (hash of every module
id and handler source hash), `runtime` (URL) and `modules[id].url`. The
event module exports `__sr = { schema, module, handlers: { hN: source },
actions: { local: id } }`; the bootstrap refuses a module whose record does
not match the manifest (`bootstrap.js:376`).

### Compiler pass (`packages/compiler/src/resumable.rs`)

Runs inside `transform_strict_blocks` on the authored program, before
marker erasure, using the strict classifier for every captured binding
(`strict.rs` `Classifier`, `BindingKind`). A handler is resumable when:

- its host sites are all `on*` attributes on intrinsic elements of the
  returned template of one named component whose body ends in
  `return <element>` (`component_info`, `resumable.rs:861`);
- the template is static: intrinsic elements, literal attributes, text,
  and expression children that are either exact `signal()` reads of a
  signal the component declares with `createSignal` or plain value holes
  (`TemplateWalker`, `resumable.rs:1364`);
- every free variable of the callback classifies as a signal of the scope,
  a literal-shaped component `const`, a `const` alias of a props path, a
  module-level literal `const`, or an import a link fact vouches for
  (`HandlerWalker::capture_reference`, `resumable.rs:1902`);
- the event parameter is used only as approved scalar fields or
  `target`/`currentTarget` sub-fields, plus the leading prelude
  (`prelude_statement`, `guard_test`, `approved_path`);
- no `this`, `super`, class, JSX, `yield`, `import()`, `import.meta`,
  `new.target`;
- every signal a handler or binding uses is referenced nowhere else in the
  module (`resumable.rs:1220`).

The SSR rewrite inserts `const _sr$N = _$srScope(id, () => ({ … }))` right
before the return, `$sr={_sr$N}` on the root and `$srel={_$srEl(_sr$N, n)}`
on handler elements, and drops the handler attributes; the SSR transform
turns `$sr` into the hydration-key hole `_$srRoot(_sr$N)` and `$srel` into a
whole-attribute hole (`src/ssr/transform.rs` `ssr_template`,
`append_planned_attribute`). Nothing else moves: the values thunk runs when
the key is allocated, in the same synchronous render, reading the same
signal the text hole reads.

The event module is a new `Program` over the same allocator holding the
cloned callback nodes (original spans → source map to the authored file),
wrapped as `export const hN = ({ captures }) => <callback>`, with the
verified imports copied and the identity record appended.

### Server runtime (`packages/resumable/src/server.js`)

`srRoot` allocates the same hydration key `ssrHydrationKey()` would,
evaluates the values, validates them (`checkData`: primitives, Date, plain
objects/arrays, Map, Set; cycles and shared references allowed because the
hydration serializer keeps identity), records the nearest error boundary
(the server `createErrorBoundary` now stamps its owner with `_boundary`,
`packages/solid/src/server/signals.ts`), and writes
`{ s, v, b }` under `sr:<key>` through `sharedConfig.context.serialize` —
the existing seroval substrate, which escapes `<` and U+2028/9. `srEl`
renders ` data-sr="<key>/<n>"`. `generateResumeBootstrap` inlines the built
bootstrap with the manifest JSON (`jsonForScript` escapes `<` and the line
terminators) and an optional CSP nonce.

### Bootstrap and runtime

The bootstrap (`src/bootstrap.js`) listens at `document` for every event
type the manifest names — the same position ordinary Solid delegation uses.
Cold path: prelude on the live event, snapshot of exactly the manifest's
paths (node sub-fields read from the coordinate element), queue in dispatch
order, `import()` of the runtime and the module, verification, drain: each
item checks liveness (`disposed` set, `isConnected`), reconstructs the scope
once per hydration key, invokes once, and `flush()`es before the next item so
queued events observe each other's writes as separate native tasks would.
Warm path: synchronous invocation with the live event and a `currentTarget`
getter pointing at the coordinate element.

The runtime (`src/runtime.js`, the only part that imports
`@solidjs/signals`) rebuilds a scope as a `createRoot` owner, one
`createSignal(value)` per recorded signal and one `createRenderEffect` per
text binding wired to the server's text node (or a new empty text node
between `<!--$-->` / `<!--/-->` when the value was empty). Handlers run with
no owner, like ordinary handlers; a synchronous throw or an async rejection
routes to the receiver registered for the recorded boundary id, else is
surfaced (`reportError`, a `solid:resume-failure` DOM event).

## Marko: adopted and avoided

Reference: `marko-js/marko` at `4bdd83c18f377d7a9b513ed2b32ced675afccbd7`
(`@marko/runtime-tags` 6.3.55, `@marko/compiler` 5.42.8), inspected read-only
from a sibling clone; no code was copied. Marko is MIT licensed (root
`LICENSE`, "Copyright 2024 eBay Inc. and contributors"); the ideas below are
attributed here, and nothing in this branch reproduces Marko source.

Adopted:

- **Serialize reasons, not values by default.** Marko's
  `serialize-reasons.ts` / `references.ts` `finalizeReferences()` emit a
  scope property only when a client-observable root (effect, handler,
  closure) reads it, solved to a fixed point. This slice records, per
  handler capture, the reason it is data (`component-const`, `props-path`,
  `constant`, signal) and serializes only the scope's `values`.
- **Registered ids instead of function source.** Marko resolves
  `_resumed[id]` factories (`dom/resume.ts` `_(scopeId, registryId)`); the
  event module exports factories keyed by handler id and rebinds captures
  from the scope object. No closure source is serialized anywhere.
- **Scope reconstruction attached to existing DOM.** Marko's resume walks
  comments to attach nodes to scopes and rebuilds branches without a
  rerender. Here the scope descriptor's element paths and hole ordinals
  locate the server's text nodes; the template is never re-created.
- **Stable identities**: hashed module ids (Marko: `getTemplateId`, a hash
  of the relative path plus a child key) and per-handler source hashes.
- **One delegated listener per event type at the document** (`dom/event.ts`),
  handler lookup by an element marker, manual walk up the tree.
- **Readiness ordering**: Marko's `ready(readyId)` channels drain buffered
  resume data once a lazy module registers; here the per-module queue drains
  only after both the runtime and the module verify.

Avoided (Marko behaviour the task ruled out, and what this slice does
instead):

- **Load-on-event drops the event.** Marko's `_load_event_trigger`
  (`dom/load.ts`) and the SSR trigger script (`html/assets.ts`) use a
  `{ once: true }` listener that only starts the import; the triggering event
  is never re-dispatched, and no fixture asserts otherwise. This slice
  snapshots and queues every cold event and runs each exactly once after
  load (mutation tests prove both a swallowed and a duplicated first click
  are caught).
- **No capture before the runtime is live.** Marko's inline walker installs
  no listeners; events before `init` are lost. The bootstrap here is an
  inline classic script before the body.
- **Events during rendering are dropped** (`handleDelegated`'s `rendering`
  check). Not reproduced; there is no client render during resume.
- **Unserializable values silently omitted in production**
  (`serializer.ts` `writeNever`). Here they refuse the instance visibly.
- **Eager per-scope resume effects.** Marko re-creates every handler closure
  at resume; this slice reconstructs a scope only on its first event.

## Semantics and declared deviations

- **First event**: prelude effects (`preventDefault`, `stopPropagation`,
  guards) apply to the live event synchronously; the body runs once, later,
  against a snapshot whose methods are inert and whose approved fields carry
  the dispatch-time values. Dev builds report a body that calls an event
  method outside the compiled prelude (`runtime.js` `invoke`).
- **Ordering relative to eager ancestors**: the bootstrap listens at
  `document` (bubble phase). A native listener between the target and the
  document runs before the prelude, cold or warm; listeners above the
  document (window) do not run after `stopPropagation`. Asserted in
  `test/client/resume.spec.js` "applies stopPropagation live". Ordinary Solid
  delegation has the same shape; the deviation from an eager component
  handler is only that the cold body runs after the dispatch task.
- **Queued cold events** drain in dispatch order with a `flush()` between
  items, so the second sees the first's write — matching two native tasks.
  Ordinary hydration's `runHydrationEvents` replay (`client.ts:2079`) drains
  its queue without flushing between events; the conformance golden
  `event-reads-writes.hydrate.trace` shows the resulting lost update for two
  synchronous clicks, which the resumable warm path reproduces for two
  clicks in one task and the cold drain deliberately does not.
- **Error routing**: an erased strict handler is a plain delegated handler,
  so a throw is uncaught. A resumed handler's throw or rejection goes to the
  receiver registered for the recorded boundary id when one exists
  (`registerBoundary`), else to `reportError` and a DOM event. Recording the
  coordinate is exact; delivering to a not-yet-hydrated `Errored` is not
  implemented (it would need the boundary to hydrate or resume).
- **Ownership**: handlers run with no owner, as `dispatchBlock` does; the
  scope's effects live under a `createRoot` created at reconstruction, not
  under a creation-time owner captured by `$()`.
- **Disposal / supersession**: `controller.dispose(key)` and a disconnected
  element both drop queued work and refuse later events for that key.
- **Stale records and builds**: schema, scope id, element index, handler id,
  per-handler source hash and action id are all checked; a stale module is
  not retried, a failed load is.
- **Not covered**: streaming renders (records ride the existing
  serializer, but the inline bootstrap timing was only exercised with
  `renderToString`), frames, prefetch policies, mixing hydration and resume
  on one page, controlled inputs' value catch-up, `stopImmediatePropagation`
  between two resumable handlers on one element.

## Security and deployment

- The bootstrap is a classic inline script (`generateResumeBootstrap`,
  `nonce` supported); it evaluates no strings and loads modules only with
  dynamic `import()` from manifest URLs. No `eval`, no `new Function`, no
  function-source serialization anywhere in the product path (the test
  harness evaluates the server's own data scripts the way a browser would).
- Records go through the hydration serializer (`<` → `\x3C`, U+2028/9
  escaped, `</script` impossible); the inline manifest is escaped by
  `jsonForScript`. Asserted with a `</script><!-- -->` sku.
- Module identity: `__sr.module`, per-handler source hashes and action ids
  are verified before any queued event runs; a mismatch refuses the module
  permanently and reports every queued event.
- Server-function ids are the ones the directive transform derives
  (`<name>-<xxhash32(path)>`); the client stub, the manifest and the server
  registry are asserted equal, and the `"use server"` body is untouched.
- Production invariant failures surface: `console.error`, `reportError`, a
  `solid:resume-failure` event on the element, and the `report` hook.

## Measurements

`pnpm --filter @solidjs/resumable measure` (Node v22.22.2, this container;
raw / gzip / brotli bytes; production conditions, esbuild-minified; latencies
are jsdom medians of 7 runs with in-process `import()`, so they exclude the
network). Raw data: `packages/resumable/measurements/results.json`.

| artifact | raw / gzip / brotli |
| --- | --- |
| inline bootstrap (minified) | 7059 / 2924 / 2603 |
| inline bootstrap (unminified) | 13752 / 3967 / 3486 |
| ordinary hydration inline script (`generateHydrationScript`) | 387 / 290 / 229 |
| buy: event chunk | 11400 / 4594 / 4145 |
| buy: shared chunk (server-function client + codec) | 47850 / 13962 / 12494 |
| buy: shared chunks (small) | 1599 / 802 / 713; 253 / 207 / 189 |
| counter: event chunk | 296 / 207 / 170 |
| runtime chunk (both fixtures; `@solidjs/signals` core) | 26504 / 10673 / 9691 |
| buy: HTML with coordinates + records / without | 1394 / 395 / 305 vs 876 / 218 / 161 |
| counter: HTML with coordinates + records / without | 679 / 295 / 236 vs 342 / 161 / 119 |
| buy: inline bootstrap + manifest | 9481 / 3488 / 3091 |
| counter: inline bootstrap + manifest | 8620 / 3324 / 2949 |
| buy: ordinary hydration client entry (component + solid-js + @solidjs/web + server-function client) | 86245 / 30577 / 27336 |
| counter: ordinary hydration client entry (component + solid-js + @solidjs/web) | 51874 / 19584 / 17801 |

| fixture | SSR transform | + `resumableEvents` | + source map |
| --- | --- | --- | --- |
| buy | 1.86 ms | 2.51 ms | 2.94 ms |
| counter | 1.53 ms | 2.13 ms | 2.55 ms |

| fixture | compile + bundle (driver) | cold first click | prefetched | warm |
| --- | --- | --- | --- | --- |
| buy | 216 ms | 7.5 ms | 0.9 ms | 0.3 ms |
| counter | 75 ms | 7.4 ms | 3.7 ms | 1.5 ms |

Full-route accounting (gzip):

- **Counter route.** Initial: 3.3 KB (bootstrap + manifest) + 0.13 KB HTML
  overhead, versus 19.6 KB + 0.3 KB for the hydration entry and its script.
  First click: +10.9 KB (runtime + event chunk). Total by first interaction:
  ~14.3 KB versus ~19.9 KB — a win only if the interaction happens; a page
  the user never touches ships ~16 KB less.
- **Buy route.** Initial: 3.5 KB + 0.18 KB, versus 30.6 KB. First click:
  +30.2 KB (runtime 10.7 + event chunk 4.6 + shared server-function client
  14.8). Total by first interaction ~33.9 KB versus ~30.9 KB: **no win once
  the user interacts**, because the runtime chunk (the reactive core) is
  loaded for an event-only scope that creates no signal, and the
  server-function client is loaded either way.
- **Bootstrap cost.** At 2.9 KB gzip the bootstrap is ten times the
  hydration script and ~15% of the counter's hydration entry. It carries
  verification, queueing, snapshots, reporting and the controller API; a
  production version would trim the controller and dev paths, but it will
  not approach 300 B while it verifies identities and queues snapshots.
- **Latency.** Cold in-process is ~7.5 ms (two `import()`s plus
  reconstruction); a real cold click adds at least one network round-trip
  for the runtime and the chunk unless prefetched. Warm dispatch cost (0.3
  ms buy, 1.5 ms counter incl. flush) is in line with a delegated handler
  plus a signal write in jsdom.
- **Compile cost.** The option adds ~0.6 ms per module to the SSR
  transform on these fixtures (+35–40%), and source maps ~0.4 ms more.
- **Not measured**: allocations (no stable in-process counter here), real
  browser timings, streaming renders, prefetch strategies.

Verdict on the numbers: the slice reduces initial JavaScript substantially
and keeps the first interaction correct, but the first interaction's cost is
dominated by the event-domain runtime (`@solidjs/signals` core, 10.7 KB gzip)
even for scopes without signals, and by the server-function client for
action handlers. Without splitting the runtime by scope capability (no
signals → no reactive core) and without prefetch, "resumable" trades
initial bytes for first-interaction bytes and latency rather than removing
work.

## Tests

- Rust: `cargo test` (default, `--no-default-features`,
  `--no-default-features --features tsrx`) — 103 / 58 / 97 lib tests plus
  integration suites, all passing; `resumable::tests` covers the counter
  scope, the DOM generate, a mutable capture refusal, `require`, prelude and
  snapshot extraction. Clippy is clean on `resumable.rs`; the remaining
  clippy findings are pre-existing in `store_handles.rs` and
  `shared/validate.rs`.
- Compiler JS: `__tests__/resumable-fixtures.test.js` (20 tests): SSR
  output, manifest and event-module snapshots for `counter`, `buy`,
  `refused`; off by default; DOM untouched; stable ids across generates and
  roots; source hash depends on the callback text only; `require`; the
  `generators` / `hydratable` prerequisites; option validation; trusted vs
  unverified imports; every documented refusal reason at its site.
- `packages/resumable` server project (14 tests): build driver, action id
  identity across manifest / client stub / server registry, coordinates and
  records, boundary coordinate, serializer escaping, handler bodies absent
  from the page and present in the chunk, source maps, nonce, compile-time
  and render-time refusals, `require`, versioned manifest, Rollup plugin.
- `packages/resumable` client project (18 tests): cold click once + prelude
  live, queue order with distinct input snapshots, guard drop,
  `stopPropagation` ordering, disposal / detachment drop, sync throw and
  async rejection routed to the nearest boundary (and surfaced outside
  one), stale manifest / record / module refusal, chunk failure with retry,
  no component load and no handler body in the initial page, action
  identity, counter 0→1 exactly once without re-render, marked hole binding
  shared by two handlers, no hydration warnings, fail-closed DOM mismatch,
  prod/dev parity, mutation tests (swallowed and duplicated first click).
- Web conformance: `resumable-counter` scenario across the 14 modes (12
  existing modes equivalent to their oracles; `server/resumable` and
  `hydrate/resumable` declared with exact traces); all other scenarios
  unchanged. Web package suites: 831 passing (one pre-existing
  server-functions adapter test is order-sensitive in the full run; it is
  unrelated to this branch — see the report).

## Track C / D / E as negative evidence

The excluded tracks were inspected on their branches only. Track C's
`packages/linker/src/runtime.js` shows the failure modes this slice avoids
by construction: the deferred run used the live event object when no
snapshot list existed (mutated by later dispatches), captures were read at
load time (`env()`), and a load failure was re-dispatched as a throwing
block. Here the snapshot is taken per dispatch from a compiled path list,
captures are serialized at render, and failures are reported, never
re-dispatched. Track D's replay/inert slices and Track E's selected entries
were not reused; the only integrated prerequisite (block hydration-id
scopes) is untouched.

## Verdict

Keep as a private, off-by-default prototype with the two fixtures as its
proof, and do not widen the RFC. The correctness bar the task set —
exactly-once first interaction, ordered queues with distinct snapshots,
synchronous prelude, fail-closed captures and identities, no component
invocation — is met and tested. The measurement bar is not: a resumable
route wins on initial bytes but pays a runtime chunk on first interaction
that hydration would have paid up front, and for action handlers pays the
server-function client either way. Before any wider use: split the runtime
by scope capability, add prefetch, wire a hydrated/resumed boundary
receiver, cover streaming, and re-measure in a browser.
