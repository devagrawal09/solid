# SSR and Hydration, Redesigned Compiler-First

Status: 2026-09-27. A design with measured prototypes. The only production changes are bug fixes that the measurements needed (see [Defects found](#defects-found)). The harness is in `scripts/ssr-redesign/` and the raw data is in `documentation/plans/ssr-hydration-redesign/`.

Update 2026-09-28: the compiler emits compiled islands (phases 3–4 for the constructs listed there): `compileIslands` output reproduces the P1 and tier prototypes at byte and time parity, behind the same gate. See [Compiler emission](#compiler-emission).

Update 2026-09-28 (later): islands for real apps — streamed boundary chunks, tier-2 islands over stores and async (adopted, not hydrated), islands spanning modules, component call forms, client error boundaries, a bundled prefetch budget and a dev verifier; `examples/todos-blocks` compiles to one island instead of falling back. See [Islands for real apps](#islands-for-real-apps).

This builds on, and does not redo:
- [resumability.md](./resumability.md): hydration vs pruned resumability, and the hydrate-before-write rule;
- [compiler-heuristics-build.md](./compiler-heuristics-build.md): per-island hydration F, the handler → island map, and compiled resumability C;
- [heuristic-oracles.md](./heuristic-oracles.md): H10 cold-scope bindings and the hydration overhead breakdown;
- [generator-blocks-v2.md](./generator-blocks-v2.md): the typed block model this design leans on;
- [track-d-hydration.md](./track-d-hydration.md): hydration-id parity for blocks.

## Summary

**Today, hydration re-runs the whole app to learn what the server already knew.** On the 1,406-comment HackerNews story page (the `hackernews-spa` components):
- The page ships **405.6 KB gz of HTML, half of it (204.7 KB) the serialized story** that the same HTML already shows.
- **Hydration does exactly a client render's reactive work:** 4,880 computations and 2,061 owners, against 4,879 and 2,061 for a render from scratch. On top of that come 2,712 key claims.
- It costs **1.2× the time and 1.6× the heap** of that render.
- The only interactive thing on the page is a collapse toggle on each comment with replies.

**The design: compiled islands over the v2 block graph.** A linker joins each component's block facts: what its setup creates, what its view reads, what its `$event` handlers write, and whether it has load-time effects. From them it proves which rendered regions are:
- **inert:** HTML only, with no code, keys, markers or data;
- **event islands:** only the handlers ship;
- **view islands:** activated with static addresses and only the live bindings;
- **hot islands:** activated at load.

Islands activate on the first event that can reach them (hydrate-before-write), or at load when hot. The server renders inert regions as plain strings.

**Measured on the HN page** (P1-static against today, Chromium, 4× CPU):

| | Today (A) | P1-static, eager | P1-static, lazy |
| --- | ---: | ---: | ---: |
| HTML gz | 405.6 KB | 189.7 KB (−53%) | 189.7 KB |
| JS gz at load | 32.1 KB | 9.6 KB (−70%) | **0.3 KB** (+9.6 KB on first click) |
| Script at load | 368 ms | 49 ms (−87%) | 8 ms |
| Heap after load | 13.7 MB | 2.4 MB | 1.5 MB |
| Ready (navigation → interactive) | 1,602 ms | 1,045 ms (−35%) | 959 ms (−40%) |
| First toggle click | 7 ms | 6 ms | 30 ms (chunk load + activation) |
| Server render | 27–31 ms | 0.5–0.9 ms as a string template | same |

The real server-components twin (`examples/hackernews`), which gets the same effect by hand, ships **55.5 KB gz of JS and 260.5 KB gz of HTML** for this page.

**When everything is live, it degrades to today's cost.** In todos-blocks, every component is live and a hashchange listener must run at load. The design then falls back to hydrating the live islands, with nothing to prune. On-interaction activation moves ~33 ms (1×) of load script to a ~60 ms first interaction, as the earlier E-lazy study found.

**Four defects came out of the measurements:**
- **Fixed:** the todos-blocks production build was broken. Every v2 app's view blocks mis-read stores in production.
- **Fixed:** v2 `yield* Ctx` could not server-render.
- **Not fixed:** the real `hackernews-spa` build leaves its toggles dead in 6 of 7 loads at 4× CPU.
- **Not fixed:** the server-components twin failed one load in seven with "Uncaught Client Exception".

## 1. Today's pipeline

```
SERVER                                             CLIENT
compiler (ssr): string template arrays             compiler (dom, hydratable): the SAME component
  + one thunk per hole                               code as a client render, with getNextElement /
runtime: an owner per component; a hydration         getNextMarker claims instead of cloning
  key (_hk) on every template root; <!--$-->       <script> _$HY bootstrap: captures click/input
  <!--/--> around every dynamic hole               hydrate():
serializer: every computation with an async or        gather: querySelectorAll('[_hk]') → Map
  serialized value, by owner id → _$HY.r              run the WHOLE component tree again:
streaming: shell, then <template> + $df swaps          every component body, memo, effect, For/Show
  per Loading boundary                                 claim each template root by key
                                                       serialized computations: re-run compute under
                                                         subFetch (fetch + Promise mocked) to learn
                                                         deps, discard the result, adopt the value
                                                    boundaries resume as their data lands
                                                    replay captured events
```

The client cost splits into four parts:
- the framework runtime, which a client render also needs;
- hydration-only runtime: key gathering, claiming, hydration-aware primitive wrappers, `subFetch`, snapshots, boundary resume;
- app code for every component, including components whose output can never change;
- the serialized data those components re-render from.

### 1.1 Measured current state

The harness is `scripts/ssr-redesign/measure.mjs`, with the real Rust compiler, the prod dists, esbuild minify, and Chromium 141. Byte and work numbers are identical across runs. Times are the median of 7 fresh loads per run, and the mean of two runs.

**HN story page**: the `hackernews-spa` Story, Comment and Toggle components, with the captured 1,406-comment thread.

| | A: hydrate (today) | CSR: client render of the same page |
| --- | ---: | ---: |
| HTML gz | 405.6 KB (1,423 KB raw) | 198.0 KB (the inline story JSON) |
| of which serialized data | 204.7 KB gz | – |
| of which `_hk` keys | 11.3 KB gz (2,712 keys) | – |
| hole markers | 5,632 (1.4 KB gz) | – |
| JS gz | 32.1 KB | 26.5 KB |
| min KB: signals / solid / web / app | 61.3 / 12.2 / 12.2 / 2.7 | 60.7 / 1.1 / 7.8 / 2.4 |
| owners / computations / compute runs | 2,061 / 4,880 / 13,775 | 2,061 / 4,879 / 13,774 |
| template claims | 2,712 | – |
| `_hk` gather | 5.5–6.1 ms | – |
| hydrate() / render(), 1× · 4× | 107 · 346 ms | 89 · 323 ms |
| script at load, 1× · 4× | 111 · 369 ms | 91 · 333 ms |
| heap | 13.7 MB | 8.3 MB |
| server render | 27–31 ms | – |

What the table shows:
- **Hydration-only code is 5.6 KB gz:** 11.1 KB min in `solid-js` (the hydration-aware wrappers) and 4.4 KB min in `@solidjs/web` (gather, claim, resume).
- **Almost none of it is avoidable per app today:** the page has one serialized computation, and its "re-run" is the only trace run.
- **The work is the render.** A page that is 98% static hydrates like a page that is 100% live.

**The real twins** are their own vite production builds and servers (`measure-twins.mjs`), on the same story:

| Twin | HTML gz (data, `_hk`) | JS gz | CPU | hydrated at | script | heap | dead toggles | failed loads |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |
| hackernews-spa | 406.6 (204.8, 12.0) | 46.0 | 1× | 504 ms | 151 ms | 13.6 MB | 1/7 | 0/7 |
| hackernews-spa | | | 4× | 1,679 ms | 736 ms | 13.6 MB | **6/7** | 0/7 |
| hackernews (server components) | 260.5 (9.5, 6.2) | **55.5** | 1× | 533 ms | 33 ms | 7.0 MB | 0/7 | **1/7** |
| hackernews (server components) | | | 4× | 1,429 ms | 129 ms | 3.7 MB | 0/7 | 0/7 |

- **Server components remove the data and 78–82% of the script.** They ship more JS than the SPA twin: the router plus the frame runtime.
- **Their HTML is still 37% larger than an inert page needs:** 260.5 against 189.7 KB gz, spent on frames, slot markers and keys.

**todos-blocks** (100 todos, generator blocks v2) and **sync-blocks** (async-free, v2):

| | todos A | todos CSR | sync A | sync CSR |
| --- | ---: | ---: | ---: | ---: |
| HTML gz (data, `_hk`) | 2.6 (1.2, 0.3) | – | 0.5 (0, 0) | – |
| JS gz | 39.3 | 33.5 | 34.1 | 27.4 |
| hydration-only JS gz | **5.8** | | **6.7** | |
| owners / computations / claims | 105 / 325 / 105 | | 2 / 9 / 2 | |
| trace re-runs (async compute re-run) | 1 | | 0 | |
| hydrate() 1× · 4× | 32 · 141 ms | | 8 · 44 ms | |
| first interaction 1× · 4× | 4.5 · 21.9 ms | | 1.2 · 5.0 ms | |

- For small live apps, the fixed hydration runtime (5.8–6.7 KB gz) is 15–20% of the JS.
- The signals core (61–77 KB min) dominates everything.

## 2. What the v2 block graph gives the compiler

Generator blocks v2 make every reactive fact syntactic, per component:

| Fact | Where the compiler reads it | What SSR/hydration uses it for |
| --- | --- | --- |
| Creations | `yield* $signal / $store / $memo / $effect` in the setup only | what state an island owns; what must be rebuilt or serialized |
| Reads | `yield*` in the view (reads only) and in memos | which holes are live; subscribers derived statically, not serialized |
| Writes | `yield* set(…)` and setter calls, only in `$event` / `$effect` | the live closure: a cell no handler, action or effect writes is server-authoritative |
| Async | `attempt(() => promise)` in memos and events; `Pending` in the types | every async read sits under a `Loading`; a streamed boundary's inputs are known |
| Failures | `raise` / `Failures` in the types | which `Errored` boundary a failure lands in; what to serialize for it |
| Load-time effects | `$effect`, `onSettled`, `onMount` (directly or through a factory) | which islands must activate at load |

The setup/view split is what makes the difference:
- A **setup runs once** and only creates.
- A **view only reads.**
- **Writes happen only in events and effects.**

So "does this rendered region ever change on the client" is a join over three syntactic sets. Compat Solid needed H10's runtime trace for this, and was unsafe on an unseen writer.

`scripts/ssr-redesign/analyze.mjs` is a prototype of that join over the three example apps, using the TypeScript AST and name-based resolution. It builds:
- the cells;
- the flows (props joined over call sites to a fixed point, context values over providers, `For` / `Show` parameters);
- each component's live reads, events, writes and load-time effects;
- the handler → island map.

The output is in `ssr-hydration-redesign/analysis.json`.

| App | Component | Class | Why |
| --- | --- | --- | --- |
| hn | Page, StoryPage, Comment | **inert** | `story` is an async memo that nothing writes or refetches (server-authoritative); every view read derives from it |
| hn | Toggle | view island, self-contained | `open` is written by its own `onClick`; the children slot is inert pass-through |
| todos | Header | **event island** | its view reads nothing live; `onKeyDown` writes `todos` |
| todos | MainSection, TodoItem, Footer | view islands | read `todos` (optimistic store; written by actions, `refresh`ed) |
| todos | App | **hot island** | `createHashFilter()` registers a `hashchange` listener in `onSettled` at load |
| sync | Converter | view island, self-contained | its handler writes only `celsius` |
| sync | App | view island | store and draft |

Handler → hydrate-before-write sets:
- **hn:** `Toggle.onClick` reaches only Toggle, so **each instance activates alone.**
- **todos:** every handler writes `todos`, which every live view reads, so the first interaction must activate all of them.
- **sync:** Converter and App are independent.

## 3. The design: compiled islands over the block graph

### 3.1 Classes and what each ships

| Class | Proof | Server output | Client at load | Client later |
| --- | --- | --- | --- | --- |
| **inert** | no live read, no event, no ref, no load-time effect, in this region or in slots it owns | string template: no owner, no `_hk`, no hole markers, nothing serialized | nothing | nothing (a navigation that replaces it renders fresh, see 3.7) |
| **event island** | events, no live view read, no load-time effect | HTML + one anchor; the handler's captures | nothing | on first event: the handler chunk runs; no view code, no view re-run |
| **view island** | live view reads, no load-time effect | HTML + one anchor; its live closure (cells reached by its handlers, and captures) | nothing (or idle, by policy) | before the first write that reaches it (the handler map): rebuild cells, bind **live holes only**, attach handlers |
| **hot island** | a load-time effect (listener, timer, measurement) | as view island | activate | – |

- **Liveness is per hole, not per component.** Inside an island, a hole whose expression reads nothing live is neither bound nor serialized. This is H10's inert binding, now sound: in strict v2 code the writers are enumerable, so there is no unseen writer.
- **Slots are pass-through.** Toggle's `{props.children}` is owned by the caller's class (inert here), so activating a Toggle never touches the reply list.

### 3.2 Addresses instead of hydration keys

- **One anchor per island instance:** `data-i=<island>` on its first element, or a `<!--i:…-->` comment when the root is a fragment.
- **Every other node is a static path from the anchor.** The compiler already emits `firstChild` / `nextSibling` walks per template; the island module keeps them, with no `getNextElement` key lookup and no gather.
- **Dynamic structure inside an island** (`For` / `Show` whose inputs are live) keeps `<!--$-->…<!--/-->` bounds, and only there.
- **Inert regions have no markers.**
- **Nested islands** in a slot are found through their own anchors: `closest()` on events, or a query for eager activation.

| On the HN page | Today | Compiled islands |
| --- | ---: | ---: |
| address bytes | 2,712 `_hk` = 11.3 KB gz | 652 anchors = 7.2 KB raw, **0.2 KB gz** |
| hole markers | 5,632 = 45 KB raw, 1.4 KB gz | 0 in inert regions |
| gather at load | 5.5–6.1 ms | none |

Address stability comes from one compiler pass producing both halves, and a versioned island manifest shared by the server and client builds. The linker refuses to link mismatched manifests.

### 3.3 What is serialized, per block kind

Only what a client-side reader or writer of an **island** needs.

| Block / value | Serialized | Why |
| --- | --- | --- |
| `$signal(literal)` / `createSignal(literal)` | nothing | rebuilt from its constant (Toggle's `open`: 652 islands, 0 bytes) |
| `$signal(expr)` from props or server data | its value, when live | the client cannot re-evaluate server inputs |
| `$store(…)` | the store paths live handlers or live holes read; the whole store only for a dynamic key | the store-summary / path facts (`store_handles.rs`) name the paths |
| sync `$memo` | nothing | recomputed on activation from its sources |
| async `$memo` / projection (pending-typed) | its settled value, **adopted without re-running the compute** | its reads before the first `attempt` are typed; subscribe to them statically (P2). A memo nothing writes or refetches is server-authoritative: its readers are inert |
| failure (`raise`, `Errored`) | the error value, only inside a live boundary | inert fallbacks are HTML |
| `$effect` | nothing | its first run is the server-rendered state; hot islands re-run it |
| `$event` | nothing at load; its captures when its island activates | see 3.4 |
| context value read by an island | by reference into the island's scope | the provider's value, once per request, not per reader |

### 3.4 `$event` handlers as lazy chunks

- **Extraction.** Each `$event` body becomes a module-level function `(captures, event) => …`. Its captures are its free variables:
  - cells (as setter/accessor handles resolved in the island's scope table);
  - props paths (`props.todo.id`);
  - context values.
- **Chunks.** Chunks are clustered per island. A handler that writes cells other islands read shares a chunk with those islands' activation code, because the handler map says they activate before the write.
- **Loader.** The loader is inline, ~0.3 KB gz (`islands-static/client-lazy.ts`). It is one delegated listener per event type. On an event it:
  1. finds the anchor (`closest('[data-i]')`);
  2. imports the chunk;
  3. activates the hydrate-before-write set, in manifest order;
  4. **replays the event.**

  Later events queue in order while a chunk loads. That queue is the fix for Track C's dropped-first-event failure.
- **Default actions.** A handler loaded after the event cannot `preventDefault()` it. When a `$event` body calls `e.preventDefault()` (a syntactic fact), the compiler marks the element (`data-pd`) so the loader prevents it synchronously and replays. Links and forms without such a handler keep their native behavior.
- **Prefetch.** Chunks are prefetched on hover, focus or viewport (policy), so the P1-lazy first click (18 ms at 1×, 30 ms at 4× from memory) does not pay a network round trip.

### 3.5 Async boundaries and streaming

- **Pending types place every async read** under a known `Loading`, and failures under a known `Errored`. The server streams as today (shell, then boundary chunks), with two differences:
  - A **boundary whose content is inert** streams HTML only: no `$df` resume bookkeeping, no serialized value, no client boundary object.
  - A **boundary containing islands** streams each island's live closure with its chunk. Islands inside a pending boundary cannot activate until the chunk lands. The loader simply finds no anchor yet, and a queued event waits.
- **Server-authoritative adoption (P2).** An async computation adopts its serialized value without the trace re-run (`subFetch`). Its reads before the first `attempt` are typed, so the compiler emits them as the node's static subscriptions. Today every serialized computation re-runs its compute on the client with `fetch` and `Promise` mocked. That wastes work, and it is unsound for libraries that do not go through `window.fetch` (the conformance goldens pin the restarted fetch).
- **Async-free islands** (every read in their graph `Pending = false`) select the async-free core (Track A stage 2).

### 3.6 SSR changes

- **Inert regions compile to string concatenation.** The compiler already emits template arrays; for an inert region it can also drop:
  - the owner per component;
  - the hole thunks and their `escape` wrappers;
  - `ssrHydrationKey`;
  - the serializer's record for anything only inert views read.
- **Islands keep today's SSR path,** with ids scoped to the island (its address namespace) and serialization limited to its live closure.
- **Measured on the HN page** (`ssr-bench.mjs`, gated on identical HTML modulo markers):
  - today's hydratable render takes **26.6–31.0 ms**;
  - the same components in a NoHydration zone take **5.7–8.4 ms**;
  - the compiled string template takes **0.54–0.87 ms**.

### 3.7 Navigation and client-only renders

An inert region is inert for the page state it was rendered with. When a navigation replaces its inputs (a new story id), there is nothing to hydrate: the region is replaced. Two supported paths:
1. **Route chunks.** The region's components ship as a lazy route chunk, loaded on navigation or on hover prefetch. A client render (CSR) is 1.2× cheaper than hydration, so replacing beats hydrating.
2. **Server components.** The server returns the region's HTML over frames (the `hackernews` twin's model). The compiler's inert proof is exactly the condition under which a component can be a server component automatically: it needs no `"use server"` annotation for markup.

### 3.8 Runtime shape

| Piece | Size | Notes |
| --- | ---: | --- |
| loader | 0.3 KB gz | delegated listeners, anchor lookup, chunk import, event queue and replay |
| island runtime | the signals core only: 23.5 KB min / **9.6 KB gz** for Toggle | no `_$HY`, `sharedConfig`, registry, gather, claim, hydration-aware wrappers, `subFetch`, snapshots |
| island chunks | per island | the setup cells, live bindings (static paths), handlers |
| hydration runtime (today's) | kept for compat apps and for view islands that need full hydration (stateful lists) | compat code keeps working unchanged |

## 4. Alternatives, compared

| Strategy | Code at load | Data | Work at load | First event | Correctness condition | Measured |
| --- | --- | --- | --- | --- | --- | --- |
| **A.** Full hydration (today) | everything | every async value | the whole tree (= CSR) + claims | cheap | none | HN: 32.1 KB / 405.6 KB / 369 ms at 4× |
| **E.** Runtime lazy hydration | loader | as A | none | hydrate **everything** (no map) | hydrate-before-write needs the whole tree | resumability.md: total unchanged, 131–321 ms first click at 4×; todos A-lazy: 181 ms first click at 4× |
| **F.** Per-island hydration + handler map | islands | island values | islands | hydrate the map's islands | compiler map | resumability.md: equal to A in total, moved to the first click |
| **P1-rt.** F driven by the block graph, on today's runtime | island components + hydration runtime | none here | 652 islands hydrated | cheap | inert proof + slot pass-through | HN: 29.3 KB / 199.6 KB / 227 ms at 4× |
| **P1-static.** Compiled islands (this design) | loader (lazy) or island chunks (eager) | live closure only (none here) | none (lazy) or live bindings (eager) | chunk + activation | inert proof, handler map, static addresses | HN: 0.3 (+9.6) KB / 189.7 KB / 8 ms (lazy), 49 ms (eager) at 4× |
| **C.** Pruned resumability (whole graph) | component-free client | live cells + instance table | none | wake subscribers | live-closure proof (over-approximate subscribers) | resumability.md: load + first click 3× less CPU than D/F; +5–8 KB gz when mostly live |
| **SC.** Server components (by hand) | router, frames runtime, client components | slot args | client components | cheap | author partitions | HN twin: 55.5 KB / 260.5 KB / 129 ms at 4× |

- **P1-static is C at component granularity, where it pays off.** Inert regions need no graph at all. A self-contained island (Toggle) is resumed from constants. Only stateful islands need C's serialized cells and subscriber derivation. The same proof covers both, because the live closure and the island set come from the same writes/reads join.
- **Whole-graph resumability** still wins CPU when most of the page is live. But it pays bytes for every live binding, and the resumability study put its break-even at 0.4–2.6 Mbps. Keep it as the compilation for stateful view islands (Phase 5), not as the page model.
- **Runtime-only laziness (E)** moves cost and cannot be sound without the map. The todos-blocks A-lazy numbers confirm it: 3 ms of load script instead of 148 ms at 4×, but a 181 ms first interaction. Script through the first interaction is 40 ms either way at 1×, and 131 vs 173 ms at 4×.

## 5. Prototype results

Two strategies were prototyped. Both run on the real compiler and runtime, and both pass the equivalence gate. The gate requires:
- the page equals A's after load and after every step of a session, with keys, markers, anchors and island wrappers normalized away;
- server nodes captured during parsing are the live nodes after load (node identity).

### 5.1 P1: compiled islands on the HN story page

Variants:
- **P1-rt** partitions with today's runtime. The server renders the page in a `NoHydration` zone and wraps each Toggle in a `<solid-island>` that re-enters `Hydration`. The client runs one `hydrate()` per island, and hands the reply list back as the server's own nodes. This is a stand-in for compiler output.
- **P1-eager** is compiled activation (`islands-static/toggle.island.ts`, a hand-written stand-in for the compiler's emission) run for every island at load. It has static paths, no keys and no hydration runtime. It rebuilds `open` from its constant and creates three render effects whose first run writes nothing, plus one handler.
- **P1-lazy** is the same activation per instance, on its first event, through the loader, with replay.

Bytes and work:

| Variant | HTML gz | JS gz at load | lazy JS gz | owners | computations | claims | gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| A | 405.6 | 32.1 | – | 2,061 | 4,880 | 2,712 | reference |
| P1-rt | 199.6 | 29.3 | – | 652 | – | 1,304 | pass, nodes kept |
| P1-eager | 189.7 | 9.6 | – | 652 | – | – | pass, nodes kept |
| P1-lazy | 189.7 | **0.3** | 9.6 | – (3 after a 4-click session) | – | – | pass, nodes kept |

Time (ms):

| Variant | ready 1× | ready 4× | activation 1× | activation 4× | script at load 1× | script at load 4× | heap | first click 1× | first click 4× |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A | 423 | 1,602 | 107 | 346 | 111 | 369 | 13.7 MB | 1.6 | 7.1 |
| CSR (reference) | 147 | 504 | 89 | 323 | 91 | 333 | 8.3 MB | 1.4 | 7.0 |
| P1-rt | 316 | 1,260 | 55 | 213 | 58 | 227 | 5.2 MB | 1.5 | 7.2 |
| P1-eager | 269 | 1,045 | 12 | 41 | 14 | 49 | 2.4 MB | 1.2 | 5.8 |
| P1-lazy | 277 | 959 | 0 | 0 | 1.6 | 8.1 | 1.5 MB | 18.0 | 30.3 |

Run-to-run spread on script at load is at most 13% at 1× and 22% at 4×.

- **Most of the saving is the partition, not the runtime.** P1-rt, with today's runtime, already halves the HTML (no data) and the hydration time. But it keeps 29 KB of JS: a hydration runtime per island costs almost as much code as the whole app.
- **Compiled activation removes the runtime.** It drops JS by 70% and activation by 88%.
- **Laziness removes the rest from load,** for 18–30 ms on the first click, or less with prefetch.
- **"Ready" is bounded by HTML parse.** Once script is near zero, halving the HTML is the remaining 35–40%.

### 5.2 P2: server-authoritative adoption (`adopt`)

An oracle patch (`lib.mjs`, `ORACLES.adopt`) skips the trace re-run for nodes the compiler would mark. The prototype marks the HN story memo and the todos projection, whose read sets before the first await are empty.

| App | trace re-runs | script at load 1× (A → adopt) | 4× (A → adopt) |
| --- | ---: | ---: | ---: |
| hn | 1 → 0 | 111 → 112 ms | 369 → 327 ms (inside the 22% spread) |
| todos | 1 → 0 | 33.6 → 33.2 ms | 148 → 141 ms |

- **It is equivalent** (the gate passes, nodes kept).
- **It is not a speed-up for these pages:** each page has one serialized computation, and its mocked re-run is cheap.
- **Its value is correctness.** It removes a duplicate fetch that does not go through `window.fetch`, and duplicate side effects in computes. Keep it in Phase 1 for that reason and for pages with many serialized computations; do not claim time for it.

### 5.3 On-interaction hydration of an all-live app (todos-blocks)

A-lazy uses the existing bootstrap's event capture and `runHydrationEvents` replay (no compiler map, whole app):

| | script at load 1× · 4× | first interaction 1× · 4× | script through the first interaction 1× · 4× |
| --- | --- | --- | --- |
| A | 33.6 · 148.2 ms | 4.5 · 21.9 ms | 39.6 · 173.1 ms |
| A-lazy | 0.9 · 3.2 ms | 59.6 · 180.6 ms | 40.4 · 131.0 ms |

The gate passes, including a replayed first click. With every view live, the design has nothing to prune. Laziness is a scheduling choice here: time-to-first-paint-interactive against first-interaction latency, and the default should be eager for such pages.

## 6. Migration plan

| Phase | Change | Gate to move on | Risk |
| --- | --- | --- | --- |
| 0 | **Fix the defects found here.** Done: the production block guard, and v2 context in SSR. Open: the `hackernews-spa` dead toggles under slow CPU, and the server-components twin's intermittent client exception | `probe-twin-toggle.mjs` 0/20 at 4×; the twins' failed loads 0/20 | low |
| 1 | **Hydration runtime overhead** (H10's list: `claimInitial` child-list copies, GC) and **`adopt`** as an option the compiler emits for computations with proven read sets | conformance goldens updated deliberately for the async re-run; `measure.mjs` todos/hn | low |
| 2 | **Liveness linker:** `islands.rs` summaries extended with the v2 block facts (setup creations, view reads, `$event` writes, load-time effects), joined across modules like `capabilities.rs`, emitting a versioned island manifest. First consumer: automatic `NoHydration` zones plus island roots on today's runtime (P1-rt), with a slot pass-through API in `hydrate()`. **Dev builds verify**: they hydrate everything and warn if an inert-classified region's DOM would change | P1-rt parity on the conformance scenarios and the three examples; the dev verifier silent | medium: an under-approximated writer is silent staleness (C-broken) |
| 3 | **Compiled island activation:** static addresses, constant-state rebuild, live-hole-only bindings, `$event` extraction with captures, the loader with queue/replay and `data-pd`, and hydrate-before-write from the handler map. Opt-in per build (`islands: "compiled"`) | P1-static gate on hn/todos/sync + new scenarios (nested islands, islands inside pending boundaries, forms, focus) | medium |
| 4 | **String-template SSR for inert regions:** ids and serialization only inside islands; inert boundary chunks stream as HTML only | byte-identical HTML modulo markers (`ssr-bench.mjs` gate) | low |
| 5 | **Stateful islands:** serialize setup cells and live store paths; adopt async memos with static subscriptions; compile stateful view islands resumably (C generalized to component instances, with lazy family members and per-member wake keys) | resumability study's gate + todos with lists | high: lists and stores |
| 6 | **Navigation:** inert regions as route chunks or automatic server components (frames), unifying the `hackernews` twin's model with the compiler's proof | the hackernews twins produce the same pages | medium |

Compat (non-strict) code stays on today's pipeline throughout. An unknown library, escaping setter or unanalyzable context makes its region live (conservative).

## 7. Risks

- **Soundness depends on a closed world.** A writer the linker does not see leaves an inert region stale: devtools, a library without a summary, or `eval`. Mitigations:
  - strict mode only;
  - escapes are live;
  - the dev verifier;
  - a runtime escape hatch (`<Live>` / an `ssrSource`-like opt-out).
- **Over-pruned closures fail silently** (C-broken in the resumability study). The proof must over-approximate subscribers and writers, and the gate must include "after every write" states, not only load.
- **Event semantics** for lazily loaded handlers:
  - `preventDefault` (needs `data-pd`);
  - input typed before activation (controlled inputs must read the DOM value on activation);
  - focus and selection;
  - ordering across two islands' chunks (one queue per page, not per island).
- **Chunk waterfalls:** many small islands with independent chunks. Cluster per route and per handler map; prefetch on hover/viewport.
- **Hot islands are unavoidable** where apps register listeners at load (todos' `hashchange`). Expressing such subscriptions as event sources (`$event` on `window`) would let the compiler defer them.
- **HTML dominates "ready" once script is gone.** The remaining wins are in HTML size (string templates, no markers, no data) and streaming, not JS.
- **Id and manifest stability** across separately built server and client bundles. Version-stamp the manifest and refuse mismatches at link time.

## Runtime tiers

Follow-up study: [island-runtime-tiers.md](./island-runtime-tiers.md). The compiled islands above still load the full signals core (9.6 KB gz for Toggle). The follow-up has the linker give each connected group of islands the smallest runtime its block graph allows:
- **tier 0**, no reactive runtime (cells as slots, holes as direct updates, the core's batching kept by a 0.3 KB gz helper) for islands whose cells only their own handlers write and whose holes read unconditionally — HN's Toggle;
- **tier 1**, a 2.1 KB gz kernel with the core's API and scheduling for memos, branches, lists, effects and shared cells;
- **tier 2**, the full core, for async, optimistic writes, stores and boundaries — todos-blocks.

Every tier is proven trace-equivalent to the core (a differential suite over random graphs, conformance runs of real compiler output on the kernel, activation stand-ins, and this document's browser gate), and measured with this harness (`measure.mjs` variants `T0-*`, `T1-*`, `T2-*` and the `todos-local` app).

## Compiler emission

Status: 2026-09-28. The compiler now **emits** compiled islands: the hand-written stand-ins of §5 and of the tier study are reproduced by `compileIslands` output, measured with the same harness and gated against today's hydrated page. Code: `packages/compiler/src/island_emit/` (Rust), `packages/compiler/islands-build.js` (entry/loader generator, Vite and esbuild plugins), `@solidjs/signals/kernel` and `@solidjs/signals/t0` (the tier runtimes, now published). Example: `examples/islands` (Vite client + SSR build, prerendered, driven in Chromium by `check.mjs`).

### What one compile produces

`compileIslands(code, { filename, idPrefix, t0Module, kernelModule, coreModule, tier1Core, minTier })` reads one v2-blocks module and returns, from one pass (so both halves agree on every address):

- **`server`**: the module with every component replaced by a string-template function `(props, $c) => string` (async only when it awaits a server-authoritative memo). No owner, no hydration keys, no hole thunks, no serializer. The only additions to the markup are what the islands need: the anchor (`data-i="<ids>"` on the island root's first element, or `<!--i:<ids>-->`), `data-s` with the island's serialized values (only when its client code reads them), `<!--$-->…<!--/-->` around live text holes that share their element and around live `Show` / `For` regions, and `data-pd` on elements whose lazily loaded handler calls `preventDefault()`. Context travels as a `Map` argument.
- **`chunks`**: one activation module per island group, `export function activate(anchor)`, plain JavaScript (the compiler erases TypeScript), importing only its tier's runtime.
- **`manifest`**: per island `{ id, root, members, tier, analysisTier, ownTiers, why, runtime, cells, events, windowEvents, anchor, nests, activation: "lazy" | "load", prefetch, preventDefault, serialized }`, per component `inert | island-root | island-member`, and `fallback` (why the module falls back, when it does).

HN's Toggle island, as emitted (tier 0; compare `apps/hn/islands-static/toggle.t0.ts`):

```js
import { cell as $cell, hole as $hole, set as $set } from "@solidjs/signals/t0";
export function activate($a) {
const $n2 = $a.firstElementChild;
const $n3 = $a.nextElementSibling;
const open = $cell(true);
const toggle = () => { $set(open, o => !o); };
$n2.addEventListener("click", toggle);
$hole([open], () => (open.v) ? "[-]" : "[+] comments collapsed", v => { $n2.textContent = v; });
$hole([open], () => ({ _0: !!(open.v), _1: (open.v) ? "block" : "none" }), (o, q) => { if (o._0 !== q?._0) { const v = o._0; $a.classList.toggle("open", v); } if (o._1 !== q?._1) { const v = o._1; $n3.style.setProperty("display", v); } });
}
```

### Partition and tier selection (`graph.rs`)

1. **Facts.** Each view hole, attribute, handler, `Show` / `For` input, effect and settled body is a site with the symbols and `props.*` members it references (reads in ternary branches, logical right operands, `if` branches and callbacks are marked conditional).
2. **Flows.** Every binding carries an abstract value — the cells and memos it may read and write when evaluated or called. Props join over every call site, context values over every provider, setup locals over their initializers; a fixpoint closes them. Any reference counts (over-approximation).
3. **Liveness.** A cell is live when an `$event` body, an inline handler, an effect or a settled body may write it, or when its setter **escapes** (a setup statement or a call-computed local stores it, a view hands it out, a component outside the module receives it). A memo is live when it reads a live key; a hole when it reads one. Everything else is server-authoritative, and its readers are inert HTML.
4. **Islands.** Live sites and the live cells / memos they touch are joined by union-find. Two unrelated cells in one component are two islands; one island spans a parent and its children when state flows down through props or context. The island's root is the component that creates its state and renders every member (dominance over the render graph). Two merges keep this sound: a component whose setup has side-effect statements keeps all its live parts in one island (so they run once), and an island rendered inside another island's live region joins it (the outer island creates its DOM).
5. **Tiers** (island-runtime-tiers.md §1): tier 2 for a store, an optimistic / projection / derived signal, a live async memo, `attempt` / `action` / `refresh` / `startTransition` in island code, or `Loading` / `Errored` inside a live region; tier 1 for memos, effects and settled bodies, cleanups, cells written by effects or escaped setters, conditional reads in live holes, live `Show` / `For`, and state shared across components; tier 0 otherwise. The group takes the highest tier of its members (`ownTiers` lists each member's own), and the group shares one runtime instance. The bundler plugin binds a page's tier-1 groups to the core when the page loads it anyway (`tier1Core: "auto"`, recommendation 3 of the tier study); `minTier` raises groups for measurement.

### Client emission (`client.rs`)

- **Addresses.** Nodes are reached by element index from the anchor (`firstElementChild` / `nextElementSibling` / `children[k]`, or from the end past a variable-size region) and by the k-th top-level marker pair (`$mk`); an element whose only child is a live hole is written with `textContent` (no markers). Component boundaries disappear: every member's view is inlined into the island's activation with its props bound to the caller's expressions (accessor, value, or getter for a reactive expression) and context bound to the provider's value (destructured names of a literal provider value keep their kinds, so `yield* todos` is `todos()`, not a dynamic read).
- **State.** Cells are rebuilt from their initializers when the client can evaluate them (literals, module functions, browser globals — as hydration re-evaluates them) and from `data-s` when they depend on props or server data; props the client code reads are serialized by name.
- **Holes.** Only live holes are bound. At tiers 1/2 each is a render effect whose first run writes nothing (the server DOM already shows it), with the DOM compiler's order: handlers, text inserts, then one combined attribute effect. At tier 0 each becomes `hole([cells], compute, apply)` on the t0 helper — activation reads and computes nothing. Class literals become per-token `classList.toggle`, style literals per-property `setProperty`, `checked` / `value` / `selected` / `innerHTML` / `textContent` DOM properties.
- **Structure.** A live `Show` / `For` becomes an adopt-or-create builder: at activation it adopts the server's node(s) (rows in order, keyed by item identity as `For` is), later it clones a client template (static markup with live-hole markers and `<!--!-->` placeholders for holes computed once per row) and binds the same holes. Rows over immutable items bind no effects at all (the item never changes for a keyed row).
- **Effects.** `$effect` is split as the block lowering splits it (every read hoisted, in order, into the compute half; `$cleanup` returned from the effect half). `$settled` bodies run once after activation; a settled body that only registers `window` listeners for `$event`s is a **lazy stub**: the loader listens instead, activates the island on the first such event and replays it (todos' `hashchange`).

### Loader, prefetch and entry (`islandsEntry`)

The page's only script. Hot islands (a load-time effect other than a listener stub; handlers outside the anchor element; comment anchors) are imported statically and activated at load. Lazy ones get the loader: one capturing listener per event type, `closest("[data-i]")` (walking up through nested anchors only when some island's anchor can contain another), the island's chunk imported and activated, and **every event that arrived meanwhile replayed in order — one queue per page** (the Track C fix). `data-pd` elements are prevented synchronously; a replayed click on a checkbox or radio is prevented at capture so it toggles once. Prefetch is configurable at the three levels of Decision 2: app default (`load | idle | visible | intent | interaction`), per island (`// @island-prefetch <policy>` on the component, or `overrides` by root component in the plugin), and budget / network (`budget` bytes of chunks; `saveData` or a 2G connection prefetches nothing). The generated loader only contains the features the page uses.

### Build integration

- **Vite** (`solidIslands({ root, prefetch, overrides, budget, mode, runtimes, tier1Core })`, `@solidjs/compiler/islands-build`): in the SSR build every matching module compiles to its server module; in the client build `virtual:solid-islands` is the entry and each island group a virtual chunk (code-split, lazily imported). `examples/islands` builds end to end (`vite build && vite build --ssr … && node prerender.mjs`) and `check.mjs` drives all three kinds of island in Chromium: a Toggle (tier 0, loaded on intent), a counter cut from the page component (tier 0), and a todo list (tier 1, the kernel), with no page errors. Client output: 1.45 KB gz entry (loader + visible/intent prefetch + budget), Toggle 0.38 KB, counter 0.41 KB, t0 helper 0.34 KB, todo list 3.05 KB (kernel included).
- **esbuild** (`esbuildIslands`) drives the measurement harness (`scripts/ssr-redesign/lib.mjs`, variants with `islands: { root, mode, minTier }`).
- **Fallback.** A module the compiler does not compile keeps today's pipeline: the plugin serves its hydratable SSR and DOM compiles, and the entry hydrates its root component (`rootExport`, `mount`). todos-blocks takes this path (its state is an optimistic async store behind a factory, with actions and boundaries: tier 2 by the rules, and read through a helper generator the partitioner does not follow).

### Measurements: compiler output against the hand-written prototypes

Same harness and methodology as §5 and the tier study (`measure.mjs`: prod dists, esbuild minify, Chromium, 7 fresh loads per run and CPU rate, median per run, mean of two runs; byte numbers exact). The compiler variants (`C-*`) compile the blocks-v2 source of each page (`apps/hn-blocks/story.tsx`, `apps/todos-local-blocks/app.tsx`, `examples/todos-blocks/src/app.tsx`) with `compileIslands` and bundle the generated entry and chunks; `minTier` raises HN's tier-0 islands to compare with the prototypes at every tier. Every variant passes the gate against today's hydrated page (after load and after every session step, server nodes kept). Tables: `node scripts/ssr-redesign/compiler-report.mjs`; data: `compiler-{hn,todos-local,todos}-{1,2}.json`, `compiler-ssr-bench-{1,2}.json`.

**HN story page** (1,406 comments; today: 405.6 KB gz HTML, 22.4 KB gz JS, 118 / 335 ms of script at load at 1× / 4×). Pairs are hand-written / **compiler**:

| Tier, activation | HTML gz | JS gz at load | + JS gz on first click | script at load 1× | 4× | first click 1× | 4× |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tier 0, eager (`T0-eager` / `C-eager`) | 189.7 / **188.3** | 0.56 / **0.62** | – | 4.2 / **4.2** | 12.5 / **7.4** | 0.7 / **0.7** | 3.2 / **1.7** |
| tier 0, lazy (`T0-lazy` / `C-lazy`) | 189.7 / **188.3** | 0.28 / **0.52** | 0.50 / **0.54** | 1.6 / **1.8** | 7.7 / **1.8** | 5.9 / **8.9** | 27.7 / **44.1** |
| tier 1 kernel, eager (`T1-eager` / `C-T1-eager`) | 189.7 / **188.3** | 2.21 / **2.29** | – | 8.6 / **7.8** | 18.1 / **23.9** | 1.4 / **1.4** | 4.1 / **4.9** |
| tier 1 kernel, lazy | 189.7 / **188.3** | 0.28 / **0.52** | 2.13 / **2.21** | 1.7 / **1.8** | 6.3 / **6.2** | 15.2 / **7.6** | 28.3 / **64.8** |
| tier 2 core, eager (`P1-eager` / `C-T2-eager`) | 189.7 / **188.3** | 9.70 / **9.78** | – | 18.0 / **20.6** | 45.9 / **36.6** | 1.5 / **1.6** | 5.0 / **6.6** |
| tier 2 core, lazy (`P1-lazy` / `C-T2-lazy`) | 189.7 / **188.3** | 0.28 / **0.52** | 9.63 / **9.70** | 1.5 / **1.5** | 3.1 / **5.6** | 17.9 / **24.3** | 34.0 / **30.6** |

**todos-local** (100 todos; today: 1.4 KB gz HTML, 22.9 KB gz JS, 11.6 / 58.7 ms of script at load). The compiler puts App, Header, MainSection, TodoItem and Footer in one island at tier 1, as the analysis did:

| Tier, activation | HTML gz | JS gz at load | + JS gz on first interaction | script at load 1× | 4× | first interaction 1× | 4× |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| tier 1 kernel, eager (`T1-eager` / `C-eager`) | 0.85 / **0.86** | 3.69 / **3.97** | – | 3.3 / **3.8** | 15.1 / **14.3** | 1.3 / **1.3** | 7.3 / **5.7** |
| tier 1 kernel, lazy (`T1-lazy` / `C-lazy`) | 0.85 / **0.86** | 0.45 / **0.67** | 3.64 / **3.90** | 0.7 / **0.8** | 2.5 / **3.8** | 19.6 / **14.3** | 46.9 / **48.5** |
| tier 2 core, eager (`T2-eager` / `C-T2-eager`) | 0.85 / **0.86** | 11.13 / **11.45** | – | 4.6 / **5.2** | 23.7 / **20.2** | 1.8 / **1.7** | 8.5 / **9.1** |
| tier 2 core, lazy (`T2-lazy` / `C-T2-lazy`) | 0.85 / **0.86** | 0.45 / **0.67** | 11.09 / **11.39** | 0.6 / **0.7** | 2.3 / **3.0** | 15.5 / **21.6** | 52.7 / **63.5** |

**todos-blocks** stays tier 2 and falls back: `C` serves the same page and the same JS (38.5 KB gz; script at load 38.9 / 141.5 ms for A, 36.9 / 132.3 ms for C, within noise). Its first-interaction probe timed out for A and C alike when these numbers were taken (104 key misses; fixed since, see Defects found: A now hydrates with 0 misses and its first interaction takes 5.2 / 16.3 ms at 1× / 4×).

**Server render** of the HN page (`ssr-bench.mjs`, median of 30 renders, two runs; HTML gated equal modulo markers and island ids):

| | today (hydratable) | NoHydration zone (P1-zone) | hand-written string template | **compiler string template** |
| --- | ---: | ---: | ---: | ---: |
| ms / render | 35.8 · 27.3 | 8.2 · 9.3 | 0.58 · 0.53 | **1.38 · 0.95** |
| HTML | 1,422.6 KB raw, 405.3 KB gz | 740.6 KB, 189.6 KB gz | 696.6 KB, 188.2 KB gz | 697.2 KB, 188.2 KB gz |

What the numbers say:
- **Bytes are at parity.** The compiler's chunks are within 0.1 KB gz of the hand-written ones at every tier on HN (0.62 vs 0.56 KB at tier 0), and within 0.3 KB on todos-local (3.97 vs 3.69 KB at tier 1: generic region / list / marker helpers instead of the stand-in's special cases). The HTML is 1.3 KB gz *smaller* than the prototypes', because the string templates drop the `<!--$-->` hole markers the prototypes' NoHydration server still emitted (740.6 → 697.2 KB raw).
- **The lazy loader is 0.52 KB gz against the prototype's 0.28 KB** (both with the harness's timing hooks). The extra bytes buy what the stand-in did not do: one ordered queue across islands (an event on an active island waits behind a loading chunk), replay of every queued event, nested anchors, `data-pd`, checkbox replay and window-event stubs — each included only when the page needs it.
- **Load-time script is at parity** (HN tier 0 eager 4.2 vs 4.2 ms at 1×; todos-local tier 1 eager 3.8 vs 3.3 ms at 1×, 14.3 vs 15.1 ms at 4×): the emitted activation does the same work — static paths, constant cells, live holes only, no work for inert holes, no roots for plain rows. First-interaction times of the lazy variants swing by tens of ms between runs at 4× in both columns (the chunk fetch and compile dominate them, as the tier study found); read them as ties.
- **The server render is 1.0–1.4 ms, 20–30× faster than today's hydratable render** and 7–9× faster than rendering the same components in a NoHydration zone; the hand-written template is still 1.8–2.4× faster (it inlines every escape and allocates no props objects).

### Behaviour evidence

- **Browser gate** (`measure.mjs --check`): every compiler variant — HN at tiers 0/1/2 eager and lazy, todos-local at tiers 1/2 eager and lazy, todos-blocks through the fallback — equals today's hydrated page after load and after every session step, and server nodes survive.
- **Conformance islands mode** (`packages/web/test/conformance/islands.spec.ts`): every component scenario with a blocks-v2 source is compiled by `compileIslands`; the server module renders the page (its markup must equal the oracle's initial DOM), the chunks activate it at the compiler's tier (tier 0 on an instrumented t0 helper that traces labelled cells like `h.signal`, tier 1 on the kernel) and at tier 2 on the core, and everything after mount must equal the oracle's trace, read for read. 25 pass: `tier-toggle` and `tier-two-cells` at tiers 0/1/2 (including the hole order the tier study's self-test plants), `tier-shared` (a new blocks source: props, a memo, a `Show` whose content is a component with setup side effects and a cleanup) and `blocks-counter` at tiers 1/2, `blocks-effect` (the effect split; against `client/blocks-compiled`, whose pinned difference from the reference is the v1 split itself), `blocks-props-child` (escaped setters), `blocks-context` (no island: inert), and `islands-list` (new: a keyed `For` adopting, creating and removing rows, a `Show` opening from a later write, memos, a marker-pair text hole, row handlers reaching the parent's actions through props). A self-test runs the Toggle chunk on a t0 helper without batching and must diverge. The async scenarios fall back (call-form `Errored(…)` / `Loading(…)` views), and are listed as skipped with the compiler's reason.
- **Rust unit tests** (`src/island_emit/tests.rs`, 23): the partitioner (inert components, two islands in one component, props / context flows, escaped setters, side-effecting setups, members rendered outside their root, islands inside live regions, recursion), the tier selector (tier 0 conditions, conditional reads, memos, effects and settled bodies, lazy listener stubs, stores and live async memos at tier 2, `minTier`), and both emitters (anchors, marker pairs, serialization, `data-pd`, awaited server-authoritative memos, TypeScript erasure, module state shared by two islands). JS tests (`__tests__/islands-build.test.js`, 11) cover the manifest surface, the loader's feature selection, the prefetch levels and the fallback entry.

### Supported constructs

- **Components:** `$component(function* (props) { setup; return function* () { return <jsx/> } })` (and `$component<P>()(…)`), and plain function components that compute locals and return JSX.
- **Setup:** `$signal` / `createSignal` (and probe hosts), `$memo` / `createMemo` (sync; async ones only as server-authoritative data), `$event`, `$effect` (split; not with reads in loops or of its own bindings), `$settled` / `onSettled`, `yield* Ctx` (a provider in the module, inside the island when an island reads it), `$cleanup` / `onCleanup`, local values and functions, side-effect statements.
- **Views:** intrinsic elements, static and dynamic attributes, `on*` / `on:*` handlers (`$event`s or inline functions), text holes, fragments, components of the module, `props.children` slots (pass-through), context providers, `Show` and keyed `For` over live or server data, `Loading` / `Errored` in inert regions (the server awaits the data).

### What falls back (whole module → today's hydration, reason in the manifest)

Updated for [Islands for real apps](#islands-for-real-apps): stores, optimistic stores, projections, live async memos, actions, `refresh`, async `$event`s, component call forms, helper generators, factories and components from other modules, a live `Show` with a render callback and an `<Errored>` around or inside live content no longer fall back.

- **Not modeled yet:** a `Loading` *inside* a live region (content the client creates under it needs a client pending fallback); a live keyed `Show` with a render callback; view statements before the return; JSX produced by a live expression (use `Show` / `For`); a live `Show` / `For` with a fallback; a live `For` with an index, or rows that are not one element; SVG / MathML inside live regions; `ref`, spreads (also in call forms), `Index` / `Switch` / `Match` / `Dynamic` / `Portal`, member-expression tags; island sites under a `Show` / `For` over server data and recursion inside an island, except as [Scopes](#scopes-component-boundaries-do-not-matter) supports them; a member component also rendered outside its island's root; a context an island reads with no provider inside it when a provider's value holds reactive state (otherwise its value at the island's root is serialized: `"$ctx:Name"` in `data-s`, checked JSON-plain on the server); module-level reactive state, or module-level mutable state two islands share; an element address that needs a path past two variable-size regions; serialized values on a comment anchor; an async memo whose value is not the result of its one final `attempt` (not adoptable); a derived cell (projection) that reads reactive state (its adoption would not subscribe); a `yield*` read of a value computed by a function from a module the compiler does not see (its reactive state is invisible).
- **Semantics to know:** side-effect statements in the setup of an *inert* component run on the server only (hydration would re-run them on the client); a setter stored in a module binding is reachable through the island chunk's exports, not through the module's own (empty) client export; a boundary's fallback is server HTML (its handlers are not island sites); an `<Errored>` routes the client errors of the **tier-2** islands in its content to its fallback (a client boundary), while tier-0 / tier-1 islands under it keep their runtime and a throw in their holes escapes (the kernel and the t0 helper have no error routing).

### Not done

See [Islands for real apps](#islands-for-real-apps) → Not done.

## Islands for real apps

Status: 2026-09-28 (Track G). The islands "not done" list above is closed for the constructs below, and `examples/todos-blocks` — the all-live app the tier study called "tier 2 by construction" — compiles to one island instead of falling back. Code: `packages/compiler/src/island_emit/` (`callforms.rs`, `inline.rs`, `store_paths.rs` new; `graph.rs`, `client.rs`, `server.rs`, `model.rs`, `tx.rs` extended), `packages/compiler/islands-stream.js` (new), `packages/compiler/islands-build.js`.

### Streaming boundary chunks

- **Server.** A `<Loading>` whose content awaits server data renders through `_$ld($c, content, fallback)`. Without a stream in the render context it awaits in place (the whole page, as before). With one (`renderIslandsStream(render)` / `renderIslandsToString(render)`, `@solidjs/compiler/islands-stream`), the shell carries the fallback between `<!--lN-->` … `<!--/lN-->`, the content renders concurrently, and it is written when it settles as an out-of-order chunk: `<template id="slN">…</template><script>$sl("lN")</script>`. The swap script (0.5 KB raw, once, before the first chunk) replaces the region, removes the markers and dispatches `solid-islands` on `document`. A nested boundary's chunk follows its parent's. A failure inside a streamed boundary renders the nearest `<Errored>` fallback on the server and swaps it over that boundary's region (`<!--eN-->`), dropping the region's other pending chunks; with no `<Errored>` it goes to `onError`.
- **Inert content streams as HTML only** — no serialized data, no client boundary object, no `$df` bookkeeping. Islands inside a chunk carry their anchors and `data-s` with it.
- **Per-boundary activation.** The entry activates eager islands at load and again on every `solid-islands` event (each anchor once); lazy ones are found by the loader once their anchor exists. An island whose static paths cross a boundary (its root renders a streamed `<Loading>`: `waits` in the manifest) activates only once no boundary around its anchor is pending — a lazy one loads its chunk at once and activates (and replays its queued events) when the boundary lands.
- **Limits.** A component's own async memo is awaited in its setup, so only boundaries *above* the awaiting component stream (HN's `Page` → `StoryPage` does; todos' projection is created in `App`, above its `<Loading>`, so the shell waits for it).

### Stateful islands over stores and async (tier 2 compiled, not hydrated)

Groups the tier rules put at tier 2 now compile against the full core instead of falling back (§3.3's per-block-kind rules):

| Block | Client | Serialized |
| --- | --- | --- |
| `$store` / `createStore(value)` / `createPlainStore` | the core's plain store; `yield* s.a.b` reads through the proxy, `readStore(s, sel)` is `sel(s)`, setters are called directly | nothing when its initializer is client-evaluable; otherwise the store, **pruned to the top-level keys its component's code reads or writes** (`S.key…`, `readStore` selectors and draft setters that only use `d.key…`; any other use serializes it whole) — `store_paths.rs` |
| `createOptimisticStore(fn, seed)` / `createProjection` / `createStore(fn, seed)` / `createOptimistic` / `createSignal(fn)` | the core's constructor over an **adopting** function: the first run returns the anchor's value instead of running `fn` (the fetch is not repeated), later runs (`refresh`) run it | its settled value (the server awaits it) |
| live async `$memo` (`… return yield* attempt(f)`) | adopted (P2): the first run evaluates the body up to the `attempt` (so it subscribes to what it reads there) and returns the anchor's value; later runs are the async body | its settled value |
| `$event` with `yield* attempt(f)` | an async handler awaiting `f()` (a rejection throws at the `yield*`, as in the driver) | – |
| `action(function* …)`, `refresh(x)` | the core's; `yield` inside an action generator is the transaction dialect, not a block operation; `refresh(x)` counts as a write of `x` for liveness | – |
| a `For` over a store | rows bind their item's fields (a row reads through the proxy), the list tracks the array's items | – |

Refusals keep this sound: an async memo whose value is not its one final `attempt`'s result, a projection function that reads reactive state (its adopting run would not subscribe), a derived cell outside the island's root component.

### Islands spanning modules

- **Summaries (pass one).** `islandExports(code)` summarizes a module: its exports by kind (`component`, `factory` — a function creating reactive state, `helper` — a generator read with `yield*`, `function`, `value`) and its relative imports with the names they import. `IslandsCompiler` caches it by content.
- **Inlining (pass two).** For each module, the plugin passes the sources of the relative imports whose used names are factories, helpers or components (`imports` option). `compileIslands` copies each such export's closure (the top-level declarations it reads, transitively) into the module, renamed apart; runtime imports merge into the module's, other imports become absolute paths; exported *values* it reads (a context, shared state) stay imported so they keep their identity, and the model reads a context imported from a provided module as a context. Then, in every component setup, `const x = f(args)` / `f(args)` / `const x = yield* g(args)` of a module-level factory or helper with one exit is replaced by its body (locals renamed, parameters bound, the `return` bound to the pattern); in a plain component a provider value that calls one (`<Ctx value={createTodos()}>`) is hoisted first. Imported components that receive live state (or that the island's DOM crosses) are inlined on a second pass when the first falls back for that reason. Flows, liveness, tiers, the server templates and the chunks all see the inlined code; the imported modules themselves are unchanged.
- **Soundness.** Without a module's source, a `yield*` read of a value that a function from it computed is refused (strict v2 code reads only reactive values with `yield*`, so the value is reactive state the compiler cannot see) — `islands-modules` and the Rust test `an_imported_factory_is_inlined_and_its_state_is_the_islands` pin both sides. The cache key of a module's compile includes its imports' contents.

### Component call forms, boundaries and their fallbacks

- `X({ … })`, `Loading({ … })`, `Errored({ … })`, `Show({ … })`, `For({ … })` in a view are read as the elements they stand for (a source pre-pass, inside out; a spread, a getter, a method or a computed key is refused). The `blocks-async-resolve` / `-reject` scenarios, skipped before, pass in the islands mode (streamed: the task resolves or rejects while the server streams).
- A boundary's fallback is server HTML: its holes and handlers are not island sites.
- **Client error boundaries.** An `<Errored>` around a tier-2 island's live content keeps a client boundary: the server marks its region with a marker pair, the content's activation runs inside `createErrorBoundary`, and a failure detaches the content (kept, still bound) and shows the fallback, built on the client from the fallback JSX with `err` / `reset`; a reset that recovers puts the same content back (`islands-errored`). The same holds for an `<Errored>` *inside* a live region — in rows the client creates, too: its region is part of the row's template and each row's content activates inside its own boundary (`islands-errored-rows`); a live hole in a fallback reads the fallback's live state. A `<Loading>` around adopted content is pass-through (its content is resolved at activation, and a settled boundary does not show its fallback again).

### todos-blocks compiles to islands

`examples/todos-blocks/src/app.tsx` with its imports (`createTodos` from `./todos`: an optimistic async store, five actions, `refresh`; `createHashFilter` from `./filter`: a signal written by a `hashchange` listener registered in `onSettled`) compiles to **one island at tier 2** rooted at `App` (members Header, TodoItem, MainSection, Footer): the store is adopted from the anchor's `data-s` (the 100 todos), the hash filter's settled body is a lazy window stub, the TodoItem rows bind their store fields, the retry button is a live `Show` render callback, and `App`'s `<Errored>` is a client boundary. The page's JS at load drops from 38.9 KB gz (today; 38.5 KB before this work, when the module fell back) to **0.66 KB gz** (lazy: the loader; the island's 25.2 KB gz chunk loads on the first event or `hashchange`), or 25.3 KB gz activated at load. Script time at load: 16.2 / 62.0 ms (eager, 1× / 4× CPU) and 0.6 / 3.3 ms (lazy) against today's 34.6 / 134.8 ms; the lazy page's first interaction (chunk fetch, parse, activation, replay) is 33.8 / 97.1 ms. HTML drops from 2.57 to 1.56 KB gz (no `_$HY` data or hydration keys; the store's `data-s` is pruned). The harness session was extended (toggle, delete, toggle all, filter by hash, add, filter back, clear completed) and the page equaled today's after load and after every step until the final merge, after which today's page stopped filtering by hash (see Measurements → Gate on todos).

### Prefetch budget from the bundle

The Vite plugin's entry carries a placeholder per lazy island; `generateBundle` replaces it with the bytes the island's chunk adds to the page — the chunk and its static imports the entry does not already load — and writes the sizes (raw and gzip) next to Vite's manifest (`.vite/solid-islands.json`). In `examples/islands` the Toggle island counts 1,007 bytes (its 0.43 KB chunk plus the t0 helper) instead of its source size.

### Dev verifier

`verify: true` (the Vite plugin's default in the dev server) makes each chunk export `verify(anchor)`: it walks the island's static addresses on the server markup — the same walk as `activate`, nothing activated — and reports each node that is not what the code expects, naming the element, its component and source line and its full path from the anchor (`expected <a> (App, line 13) at $a.firstElementChild.firstElementChild, found <span>`), a missing `data-s`, and client error boundaries' regions. The entry runs it on every anchor at load and as streamed boundaries land (an island that `waits` is checked once its boundary has landed), and reports anchors naming an island the build does not know (server and client built from different sources). The conformance islands mode checks it is silent on every scenario's own server markup and precise on a tampered one.

### Measurements

`scripts/ssr-redesign/trackg-report.mjs` over `trackg-<app>-{1,2}.json` (this work, one session, 7 loads per run and CPU rate) and `compiler-<app>-{1,2}.json` (the compiler emission before it, measured in an earlier session). Byte numbers are exact; times are means of the two runs.

#### hn

| | HTML gz | JS gz at load | + JS gz on first interaction | script at load 1× | 4× | first interaction 1× | 4× | server render (CPU ms) | gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| today: hydrate (A) | 405.60 | 22.32 | – | 94.1 | 325.0 | 1.5 | 6.8 | 70.7 | reference |
| before: compiled islands, tier 0, eager | 188.34 | 0.62 | – | 4.2 | 7.4 | 0.7 | 1.7 | 1.4 | pass |
| before: compiled islands, tier 0, lazy | 188.34 | 0.52 | 0.54 | 1.8 | 1.8 | 8.9 | 44.1 | 3.9 | pass |
| after: tier 0, eager | 188.34 | 0.69 | – | 3.8 | 17.6 | 0.8 | 3.2 | 4.6 | pass |
| after: tier 0, lazy | 188.34 | 0.52 | 0.54 | 1.4 | 7.5 | 10.0 | 79.3 | 8.1 | pass |
| after: tier 0, lazy, streamed boundary | 188.80 | 0.52 | 0.54 | 2.8 | 16.3 | 6.3 | 40.2 | 5.3 | pass |

(after: 2 run(s); before: 2 run(s); 7 loads per run and CPU rate.)

#### todos-local

| | HTML gz | JS gz at load | + JS gz on first interaction | script at load 1× | 4× | first interaction 1× | 4× | server render (CPU ms) | gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| today: hydrate (A) | 1.39 | 22.81 | – | 10.9 | 49.1 | 2.0 | 11.6 | 1.0 | reference |
| before: tier 1, eager | 0.86 | 3.97 | – | 3.8 | 14.3 | 1.3 | 5.7 | 0.3 | pass |
| before: tier 1, lazy | 0.86 | 0.67 | 3.90 | 0.8 | 3.8 | 14.3 | 48.5 | 0.2 | pass |
| after: tier 1, eager | 0.86 | 4.02 | – | 3.8 | 14.5 | 1.3 | 6.6 | 0.2 | pass |
| after: tier 1, lazy | 0.86 | 0.67 | 3.96 | 0.7 | 3.2 | 12.9 | 42.6 | 0.2 | pass |

(after: 2 run(s); before: 2 run(s); 7 loads per run and CPU rate.)

#### todos

| | HTML gz | JS gz at load | + JS gz on first interaction | script at load 1× | 4× | first interaction 1× | 4× | server render (CPU ms) | gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| today: hydrate (A) | 2.57 | 38.92 | – | 34.6 | 134.8 | 4.7 | 19.4 | 7.1 | reference |
| before: whole-module fallback (hydrate) | 2.62 | 38.50 | – | 36.9 | 132.3 | timeout | timeout | 7.4 | pass |
| after: one tier-2 island, eager | 1.56 | 25.29 | – | 16.2 | 62.0 | 3.2 | 16.4 | 0.9 | false |
| after: one tier-2 island, lazy | 1.56 | 0.66 | 25.22 | 0.6 | 3.3 | 33.8 | 97.1 | 1.2 | false |

(after: 2 run(s); before: 2 run(s); 7 loads per run and CPU rate.)

Reading the tables:

- **todos-blocks** is the change: from whole-module fallback (38.5 KB gz, today's hydration) to one tier-2 island — 25.3 KB gz eager, or a 0.66 KB gz loader with the chunk on first interaction. The chunk is the full core (stores, optimistic, projections, transitions, the error boundary) plus the app; the loader is the same as HN's.
- **Gate on todos.** After the final merge of `experiment/iterable-signals` the reference page (A) briefly stopped filtering by hash. Cause: the harness compiled only `.tsx`/`.jsx`, so `filter.ts` (`onSettled(function* …)`) reached the bundle uncompiled while every other module was compiled driver-free; nothing installed the block driver, and the production build ran the generator function as a plain callback (dev builds throw `[GENERATOR_BODY]`). The example's own Vite config compiles `.ts`; `lib.mjs` now compiles `.ts` app modules that hold a generator body the same way, and the gate passes again for A, C and C-eager (after load and every session step).
- **HN and todos-local** are unchanged in bytes except the eager entry (+0.07 KB gz for per-boundary activation: `solid-islands` listener and `waits`). Their time rows moved in both directions between sessions (A too: HN A 4× script is 325 ms here); treat sub-20 ms differences between the "before" and "after" rows as run-to-run noise — the byte columns and the same-session A comparison are the reliable ones.
- **Streamed HN (`C-stream`)**: the shell (with the `<Loading>` fallback) and the story chunk arrive in one response; HTML +0.46 KB gz for the swap script and markers; JS unchanged.

### Behaviour evidence

- **Browser gate** (`measure.mjs --check`): HN `C-eager` / `C-lazy` / `C-stream` (the page's `<Loading>` streamed as a chunk after the shell; the swap runs while parsing), todos-local `C-eager` / `C-lazy`, equal today's page after load and after every session step, with server nodes kept; todos-blocks `C` / `C-eager` (compiled, no longer the fallback) do too (see Measurements → Gate on todos); form controls' live state (`checked`) is part of the comparison.
- **Conformance islands mode**: 75 tests, **0 skipped** (was 25 + 3 skipped). New: `blocks-async-resolve` / `-reject` (call forms, streamed resolve / reject into `Errored`), `blocks-async-event` (merged from blocks v2: an async `$event` reading a context provided outside the island — serialized), `blocks-effect`'s markup test (compared after the load-time effect's activation), and islands-only scenarios `islands-stream` (a streamed boundary with an island inside and an island spanning it), `islands-store` (a store island from server data, pruned serialization, rows over a store), `islands-async` (an adopted live async memo, an async `$event`), `islands-optimistic` (todos' state shape in one module: adopted optimistic store, action, refresh, a live `Show` render callback), `islands-modules` (a factory and a component from other modules, a helper generator reading an imported context), `islands-errored` (a client error boundary: throw, fallback, reset), `islands-errored-rows` (an error boundary inside rows the client creates); and the dev verifier on every scenario.
- **Rust unit tests** (`src/island_emit/tests.rs`, 33): the above plus call forms, a context provided outside the island, streaming and `waits`, stores and key pruning, adoption (and its refusals), async handlers, cross-module summaries and inlining, imported contexts, factory / helper / provider inlining, client error boundaries. **JS tests**: `__tests__/islands-build.test.js` (16: streaming entry, bundled budget sizes, cross-module pass and cache, verifier entry), `__tests__/islands-stream.test.js` (5: in-place vs streamed, nested order, error routing, HTML form, swap).

### Navigation and route-level clustering (design; not implemented)

- **Routes as roots.** The plugin takes a route table (`routes: { "/": "src/routes/index.tsx", "/item/:id": "src/routes/item.tsx" }`) and collects islands per route root as it does per page now. Per route it emits a small loader table (the route's lazy islands, their events, policies and bundled sizes) and clusters chunks: groups the handler map activates together (a hydrate-before-write set) share one chunk; `load` / `visible` groups of one route merge into one route chunk up to the budget; runtimes dedupe per route (`tier1Core: "auto"` per route).
- **Navigation is streaming into a region.** A same-origin link to a known route is intercepted; the server renders the route's outlet region with `renderIslandsStream` (the page shell is already there) and the client swaps the outlet exactly as a boundary chunk lands (`$sl` → `solid-islands`): inert content is replaced wholesale — the inert proof is what makes it a server component without annotations (§3.7 path 2) — islands in it activate through the same landing path, and the route's loader table merges into the page loader's (prefetched with the route on `intent`). Islands outside the outlet keep their DOM and state; islands inside are disposed (`activate` returns a disposer at tiers 1/2; tier 0 holds only element listeners).
- **Gates.** The hackernews twin's story-list → story-page navigation equals a full load of the target page; islands outside the outlet keep state across it; chunk requests per navigation are counted.
- **Why not route chunks with component code (§3.7 path 1):** they ship the inert regions' code that the islands proof removed; the streaming path reuses the proof and the loader unchanged.

### Not done

- `Loading` inside live regions (a client pending boundary around content the client creates), and client pending fallbacks for new async reads under a `Loading` around adopted content.
- Streaming a boundary whose data is created above it (a projection in `App` read under `App`'s `<Loading>`): the server awaits setup data before the shell.
- Navigation and route-level clustering (design above).
- The t0 helper and the kernel route no errors: tier-0/1 islands under an `<Errored>` keep their runtime and do not show its fallback on a client error.
- Store serialization is pruned to top-level keys (not paths or rows).

## Scopes: component boundaries do not matter

Status: 2026-09-29 (branch `scopeBlocks`). The same logic written as one component or as five compiles to the same islands partition and the same output. Code: `packages/compiler/src/island_emit/scopes.rs` (new), `graph.rs`, `client.rs`, `server.rs`, `store_paths.rs`, `mod.rs`.

### Partition on scopes

Before the partitioner runs, the islands source is normalized to **scopes** (the unit that creates cells and encloses sites), in `prepare()` after imports, call forms and factory calls are inlined:

1. **Row blocks become scope components.** A render callback that is a block (a bare `function*`, `$(function* …)`, or a named row block declared in the setup and passed by name, possibly recursively — see generator-blocks-v2.md, "Render callbacks as blocks") becomes a synthesized `$component` named `Host$name` (named) or `Host$For` / `Host$Show` (inline), whose captures are props and whose parameter is its item prop. Its setup runs once per row, its view is the row.
2. **Keyed stores split per row** (`split_keyed_stores`, `store_paths::row_keyed_uses`): a `$store` map whose *every* read and write is `map[row.id]` with `row` the same row scope's item becomes a cell per row (`closed$key`), initialized from the map at that key. Any other access — a key read from the DOM (`dataset.id`), another row's key, the whole map — keeps the store whole and shared. When the split leaves the map written by nothing, the client holds it as its initial value (no live store, any tier).
3. **Helper generators inline** (`inline_helpers`): a helper declared in a setup whose body is one `return` of an expression, called only as `yield* helper(plain args)`, is replaced at each site by its expression (parameters substituted). Others stay and are reported by the model.
4. **Branch sinking** (`sink_into_branches`, analysis-guided on the first pass's probe): an island whose state and sites all sit in one `Show` branch over server data is rooted at the branch, which becomes a `Host$Show` scope with a children slot. This is what makes one component's toggle state a per-branch island as a `Toggle` child component would be.

The partitioner then roots an island at the nearest scope that creates its cells and encloses its sites (dominance over the render graph), as it did for components. Two dominance rules changed: **an export is not a render site** here (another module's render sites are that module's own compile; `exported` stays in the model for the summary), and **a scope may render itself** (a recursive row is dominated by whoever renders its first instance).

**Recursion inside an island.** Lifted state read by a recursive child (the thread under one `closed` signal) is one island over the thread. The server marks the recursion's rows as a *structural region* (a `Show` / `For` over server data holding island content: markers, as a live region has); the client adopts them with `Slot::Struct` and one row function per recursive scope that calls itself for its own rows (`$rows`). The recursion is refused — with that reason in the manifest — when it goes through another component, sits inside a live region, is not in a `<For>`, or passes props that change per level.

Other changes: a prop that a member only forwards to another island's component is not bound (used-props fixpoint); a server-authoritative async memo read by an island root is serialized (`__SERVER_MEMO_i__`); `$list` / `$show` run rows created after activation under the island's owner so they are disposed with it (a leak fix; chunks with lists grow by ~94 bytes).

### Results

| Source | Partition | chunk bytes | server module bytes |
| --- | --- | ---: | ---: |
| `apps/hn-blocks/story.tsx` (Toggle + Comment components) | one tier-0 island per toggle (`Toggle`), nothing serialized | 689 | 6,201 |
| `apps/hn-blocks/story-single.tsx` (one component, named recursive row block) | one tier-0 island per toggle (`StoryPage$comment$Show`), nothing serialized | **689 (identical)** | 6,084 |
| `apps/hn-blocks/story-keyed.tsx` (a keyed `closed` store in the page) | per-row tier-0 islands, cell `closed$key` serialized per row | 861 | 6,280 |
| keyed, handler reads its key from `dataset.id` | one shared tier-2 island at `StoryPage` (the store) | 2,972 | 6,124 |
| keyed + a filter signal every row reads | one shared tier-1 island at `StoryPage` (filter) + per-row keyed tier-0 islands | 1,651 + 861 | 6,577 |

`measure.mjs --apps hn --check`: `C-single-eager` and `C-single-lazy` (new variants over `story-single.tsx`) pass the gate against today's page with identity kept: 188.3 KB gz HTML, 0.7 KB gz JS (+0.5 KB lazy), the same as `C-eager` / `C-lazy`.

**Manifest changes for existing sources:** none. Against the base compiler, the manifests and server modules of `examples/todos-blocks/src/app.tsx`, `apps/todos-local-blocks/app.tsx` and `apps/hn-blocks/story.tsx` are byte-identical (default and `minTier: 2`); HN's chunk is identical, and the list chunks of the todos apps grow 94 bytes (13,905 → 13,999 and 7,716 → 7,810 raw) for the owner fix above.

### Supported and falling back

Supported, in addition to "Supported constructs": row blocks (bare, `$(…)`, named and recursive) as scopes with per-row islands; state in one branch of a `Show` over server data; exported children of lifted state (one island at the parent); lifted state read by a recursive child (one island, structural regions); keyed stores split per row; single-expression helper generators.

Still falling back or shared, with the reason: a recursion through another component, in a live region, outside a `<For>`, or with per-level props (manifest reason); a keyed store accessed at any key other than the row's own (shared, sound); a helper generator with statements, non-plain arguments or non-call uses (kept; the model reports it if it matters); view statements before the return (handled separately).

## Defects found

| Defect | Status | Evidence |
| --- | --- | --- |
| **Production `$` blocks mis-read stores in nested computations.** `recompute` (and the status-free recompute) lowered the block strict guard only under `__DEV__`, while the driver raises it and store proxies answer it with path tokens in every tier. A `Show` / `For` / render effect created inside a v2 view therefore failed with `[UNREAD_PATH]` in production: the todos-blocks production build showed its error fallback, and its SSR page re-rendered the list instead of hydrating it | **Fixed** (`@solidjs/signals`, changeset `block-guard-prod-nested-computations`) | `tests/block-guard-nested-computation.test.ts` fails under `SIGNALS_TIER=prod` before the fix |
| **v2 `yield* Ctx` could not server-render.** The context op read through the client core's `getContext`, which has no owner on the server (NoOwnerError; todos-blocks SSR rendered its `<Errored>` fallback) | **Fixed** (`@solidjs/signals`, `solid-js`; the server provider installs a reader under `Symbol.for("solid.contextRead")`) | `packages/web/test/server/block-api.spec.tsx` |
| **`hackernews-spa` production build: toggles never become interactive** under CPU throttling, although `_$HY.done` is set and the server nodes are in place | **Fixed** (`@solidjs/web`, changeset `hydrate-document-after-shell-parse`). Root cause: a hydration race with the HTML parser. The vite plugin injects the client entry as `<script type="module" async>` so hydration can start while a stream is open; an async module runs as soon as it loads, which on the 1.4 MB story page under throttling is mid-parse. `hydrate(…, document)` then gathered `_hk` elements whose opening tag was parsed but whose children were not, and the compiled walk threw (`Cannot read properties of null (reading 'firstChild' / 'nextSibling')`, `setting '$$click'`) at a different point each load; every toggle past it kept no handler (108–452 of 652 bound). Fix: `hydrate()` on a document still `loading` waits for DOMContentLoaded, or for a shell-parsed marker (`_$HY.sh`) that `renderToStream` writes right after a shell that still has pending fragments, so a streamed shell hydrates before its slow boundaries resolve; captured events replay as before | Regression tests `packages/web/test/hydration/document-root-parse-race.spec.tsx` (3 of 4 fail before the fix) and `test/server/shell-parsed-marker.spec.tsx`. `probe-twin-toggle.mjs hackernews-spa 4 7`: 6/7 dead before (7/7 in a second run), **0/7** after; 0/7 at 1×; all 652 toggles bound, no console errors |
| **`hackernews` (server components): a load renders "Uncaught Client Exception"** instead of the thread | **Fixed, same root cause (by attribution)**. The text is the generated `DefaultErrorBoundary`'s client fallback, i.e. an error thrown while hydrating; the only client error these twins produce is the parse-race TypeError above, which that boundary catches (its `console.error` is where the TypeErrors surfaced). Not reproduced in 14 loads (1× and 4×) on either runtime, so the fix is confirmed by the absence of any hydration-time error, not by a before/after count | After the fix: 0/14 loads (1× and 4×) with the fallback text, a page error, or a dead toggle, for both `hackernews` and `hackernews-spa` |
| **The v2 HN page does not hydrate through today's pipeline.** The blocks version of the story page (`apps/hn-blocks/story.tsx`: an async `$memo` with `attempt` under `Loading`) server-rendered only a rejected fragment (`client-only content (bare ssrSource: "client")`), and the client fetched the story again | **Fixed** (`@solidjs/web`, `solid-js`, `@solidjs/signals`; changeset `v2-blocks-hydration-parity`). Three root causes, in the order they surfaced: (1) Toggle's `{props.children}` (forwarded without `yield*`) reaches the renderers as a v2 path-read op, a proxy that answers every property with another read. The server resolver took it for a template object (`node.h`, `node.t`, `node.p` all "present") and pushed reads into the boundary's pending list, where the truthy `p.$clientHole` probe classified them as a final client hole. Renderers now render a read op as the value it reads (`isReadOp`, in `flatten` and in the server's `escape` / resolvers), and the probe checks `=== true`. (2) `Page`'s view returns `<Loading>`, so `Loading` is deferred (`lazyView`) on both sides. The client resolves the thunk under a fresh owner (one id level); the shared implementation's owner is a client-core owner, which carries no id on the server, so every key under the boundary sat one level higher on the server (`1000` vs `10000` for the story memo): the client missed the serialized memo and refetched. The server now registers its own `lazyView` (a server owner around the shared thunk) as a block primitive and uses it in `Loading` / `Errored`. (3) With that, a component called inside a server memo (`Show`'s children: `<Toggle>` in `Comment`) was deferred on the server only: the client's `recompute` lowers the block guard for every computation, the server's memos did not, so `inBlock()` answered true there on the server. Server memo computes now lower the guard too. Also found on the way (client, streaming and CSR): `insert` rendered a hole's `$` block value (the root `() => <Page />`) in its inner unwrapping effect, which re-runs whenever the boundary the view returns settles — a fresh `Loading`, memo and fetch on every settle, forever (CSR: `render(() => <Page />)` never settled; streamed hydration re-rendered the fallback). The outer computation now renders it | `measure.mjs --apps hn --only A-blocks` (variant restored: `apps/hn-blocks/{server,client}.tsx`): before, 0 story markup, a refetch of `/story.json` and 2 key misses (`100010`, `1010`) at the first fix; after, **0 key misses, no request, the story memo adopted** (`adopted: 1`), 2,062 owners / 4,880 computations like A, the gate against A passes after load and after the session, all 652 toggles bound; first interaction 1.3 / 8.5 ms at 1× / 4× (A: 1.4 / 6.4). Regression tests: `packages/web/test/harness/block-v2-scenarios.tsx` in the parity harness (`v2-view-returns-loading` loaded + streamed, `v2-block-root-loading` loaded + streamed, `v2-forwarded-children`: 5 of 6 fail before the runtime fixes), `test/block-api.spec.tsx` (a root view returning `<Loading>` fetches once — looped before; `{props.children}` forwarding) |
| **todos-blocks today (A) on this branch: 104 hydration key misses, and the first-interaction probe times out** (8 s; the row never shows `pending`) | **Fixed** (`@solidjs/compiler`, changeset `v2-blocks-hydration-parity`). Root cause: a `$component`'s view is lowered to `$(function () { … }, BLOCK_SYNC)`, and the hydration id-scope pass (`block_scope.rs`) only wrapped one-argument `$(fn)` calls, so views were not id-scoped. The client renders `<Header />`'s view from its insert effect at once; the server's `escape` defers it to `ssr()` time, after the sibling `<Loading>` had taken the next slot (server `header _hk=10012`, `Loading` `10011`; client asked for `10011`), and every key below shifted. Without claimed nodes, the delegated handlers were bound to detached clones, so clicks did nothing. The pass now also wraps `$(fn, flags)` views — also when the v2 client lowering imports the adapter as `syncBlock` — and still leaves a flagged setup or event (the direct argument of `$component` / `$event`, which the client lowering may erase to `$componentCompiled(fn)` / `$eventCompiled(fn)`) unscoped on both sides | `measure.mjs --apps todos --only A`: **`keyMiss` 104 → 0**; the session now does work (after-session signals 107 → 237); first interaction **5.2 / 16.3 ms** at 1× / 4× (timed out before); `C` and `A-lazy` pass the gate. Rust test `block_scope::tests::wraps_component_views_lowered_with_flags`; parity-harness scenario `v2-view-then-boundary` |
| **A component in two islands got both islands' code in each chunk.** `client.rs` lowered every member component's whole setup and view per group: with `Page` owning `count` (written by `AddToCart`, read by `CartBadge`) and `dark` (toggled and read by `CartBadge`, read by `Page`'s root class), the manifest correctly gave `i0` = {count} (Page, AddToCart, CartBadge; `submit`) and `i1` = {dark} (Page, CartBadge; `click`), but `i0`'s chunk also created `dark`, attached the badge's click handler and bound both `dark` class holes, and `i1`'s chunk created `count` and bound the count text. Two copies of each cell existed on the page; once the islands activated at different times (a submit activates `i0`, the first click `i1`) the copies went out of phase and the class holes showed the inverse of the state, silently (whichever island's effect ran last won). Root cause: the emitter decided "bound here?" with the analysis-wide live-site flag and `needed_items` pulled in every setup item that any call prop or any non-root member's site referenced | **Fixed** (`@solidjs/compiler`, changeset `islands-split-shared-component`). The emitter keeps, per group, only the sites in `Group::sites` (handlers, text and attribute holes, `Show` / `For`, effects) and the setup items those need; a cell or memo of another island is never created locally (a hole of another island is counted as its marker pair and left alone). A site that would need another island's cell inside content this island creates (a fresh region row, a client-built fallback), or island sites inside another island's region, is refused with a reason: the union-find should have merged those | Rust tests `island_emit::tests::a_component_in_two_islands_gets_only_each_islands_sites` and the strengthened `two_unrelated_cells_in_one_component_are_two_islands` (each chunk names only its own cell and handler); conformance scenarios `islands-shared-member` / `islands-shared-member-reversed` (`packages/web/test/conformance/scenarios/islands.ts`, `manualActivation`: the steps activate the islands one at a time in both orders with clicks in between, the DOM equals the oracle's after every step). Before the fix, with `i0` active alone, a click on the badge toggled the page dark (`i0` had a handler it did not own) |

## Decisions (after review)

1. **Islands are cut from the live graph, not from components.** Component
   boundaries are not a concern, as at runtime: an island is a connected group
   of live things — the state a setup creates, every view hole (in any
   component) that reads it, and every handler that writes it. Everything else
   is inert HTML, even inside a "live" component; one island may span a parent
   and its children, and two unrelated pieces of state in one component are two
   islands. Anchors move from component roots to island roots; holes are
   addressed by static paths from them (§3.2).
2. **Prefetch is configurable at three levels.** App default (`load` / `idle` /
   `visible` / `intent` (hover, focus, pointerdown) / `interaction`), per-island
   overrides in source (`$event(fn, { prefetch })`, a JSX attribute, or a pragma),
   and budgets/signals (per-route byte budget, `saveData` / slow network, usage
   data). Mechanisms underneath: `modulepreload`, service-worker precache,
   speculation rules. Proposed default: `visible` + `intent`, `interaction` under
   `saveData`.
3. **Load-time listeners live in effects; `onSettled` is a run-once effect.**
   `$settled(function* …)` (and `onSettled(function* …)`) is an effect block run
   once after the graph settles, never re-run: effect rules (reads are values,
   writes, `$cleanup`, no async). A listener registered there is an `$event`, so
   the types separate what runs at load (the settled body — a few lines, shipped
   eagerly with the listener as a lazy stub) from what waits for the listener
   (the `$event` and the island it writes). A settled body that writes at load
   (e.g. syncing state the server could not see, like the URL hash) makes its
   island activate at load, only when the value differs from the server's.
   Implemented: `$settled`, generator `onSettled`, compiler lowering;
   `examples/todos-blocks`' hash filter uses it.
4. **Islands use the smallest runtime their graph allows** — tiers: no reactive
   runtime (fixed synchronous graphs compile to direct DOM updates), a small
   push kernel (dynamic reads, memos, shared state), the full core (async,
   transitions, optimistic, stores). Islands sharing state share one runtime;
   every tier is proven equivalent in the conformance harness. Prototype and
   measurements: [island-runtime-tiers.md](./island-runtime-tiers.md) and
   [Runtime tiers](#runtime-tiers) — HN's Toggle island 9.6 → 0.6 KB gz (tier 0),
   a list app 11.1 → 3.7 KB gz (tier-1 kernel, 2.1 KB gz).

## Open questions

1. **Store serialization granularity:** live paths vs whole store vs per-row. It interacts with Track B handle stores and projections.
2. **How does the dev verifier report without making dev builds diverge from production** in timing-sensitive code (streaming, boundaries)?
3. **Unifying with server components:** should an inert region become a server component automatically on navigation (frames), or should route chunks be the default and SC opt-in?

## Reproduce

```sh
# builds: packages/signals, packages/solid (pnpm build), packages/compiler (pnpm build; rustc 1.95), packages/web
node scripts/ssr-redesign/analyze.mjs                          # block-graph classification (--json out)
node scripts/ssr-redesign/measure.mjs --check                  # gates only
node scripts/ssr-redesign/measure.mjs --reps 7 --cpu 1,4 --out documentation/plans/ssr-hydration-redesign/results-1.json   # and -2
(cd examples/hackernews-spa && pnpm build); (cd examples/hackernews && pnpm build)
node scripts/ssr-redesign/measure-twins.mjs --reps 7 --cpu 1,4 --out documentation/plans/ssr-hydration-redesign/twins-1.json
node scripts/ssr-redesign/ssr-bench.mjs --out documentation/plans/ssr-hydration-redesign/ssr-bench-1.json   # and -2
node scripts/ssr-redesign/probe-twin-toggle.mjs hackernews-spa 4 6
node scripts/ssr-redesign/measure.mjs --apps todos,hn --only A,A-blocks --check   # key misses (counts.keyMiss) of the v2 pages through today's pipeline
node scripts/ssr-redesign/report.mjs                           # the tables above
# Compiler emission (section "Compiler emission")
node scripts/ssr-redesign/measure.mjs --apps hn --only A,P1-eager,P1-lazy,T1-eager,T1-lazy,T0-eager,T0-lazy,C-eager,C-lazy,C-T1-eager,C-T1-lazy,C-T2-eager,C-T2-lazy --reps 7 --cpu 1,4 --out documentation/plans/ssr-hydration-redesign/compiler-hn-1.json   # and -2
node scripts/ssr-redesign/measure.mjs --apps todos-local --only A,T1-eager,T1-lazy,T2-eager,T2-lazy,T0*-eager,C-eager,C-lazy,C-T2-eager,C-T2-lazy --reps 7 --cpu 1,4 --out documentation/plans/ssr-hydration-redesign/compiler-todos-local-1.json   # and -2
node scripts/ssr-redesign/measure.mjs --apps todos --only A,C --reps 7 --cpu 1,4 --out documentation/plans/ssr-hydration-redesign/compiler-todos-1.json   # and -2
node scripts/ssr-redesign/ssr-bench.mjs --out documentation/plans/ssr-hydration-redesign/compiler-ssr-bench-1.json   # and -2 (adds C-string)
node scripts/ssr-redesign/compiler-report.mjs                  # the compiler-vs-hand-written tables
node scripts/ssr-redesign/islands-inspect.mjs hn C-lazy        # print a variant's minified entry and chunks
node scripts/ssr-redesign/islands-debug.mjs todos-local C-eager  # unminified, in Chromium, with page errors
(cd packages/compiler && cargo test --lib island_emit && pnpm exec vitest run __tests__/islands-build.test.js)
(cd packages/web && pnpm exec vitest run test/conformance/islands.spec.ts)
(cd examples/islands && pnpm build && pnpm check)
# Islands for real apps (section "Islands for real apps")
node scripts/ssr-redesign/measure.mjs --apps hn --only A,C-eager,C-lazy,C-stream --out documentation/plans/ssr-hydration-redesign/trackg-hn-1.json   # and -2
node scripts/ssr-redesign/measure.mjs --apps todos-local --only A,C-eager,C-lazy --out documentation/plans/ssr-hydration-redesign/trackg-todos-local-1.json   # and -2
node scripts/ssr-redesign/measure.mjs --apps todos --only A,C,C-eager --out documentation/plans/ssr-hydration-redesign/trackg-todos-1.json   # and -2
node scripts/ssr-redesign/trackg-report.mjs                    # the tables in "Islands for real apps"
(cd packages/compiler && pnpm exec vitest run __tests__/islands-stream.test.js)
```

Harness notes:
- **Counters and oracles** are exact-once textual patches of the prod dists, applied at bundle time (`lib.mjs`); a changed anchor fails loudly.
- **The work counters are:**
  - `computed()` constructions;
  - `recompute()` runs;
  - `signal()` and `createOwner()`;
  - `getNextElement()` calls;
  - `subFetch()` trace re-runs;
  - key misses;
  - the `_hk` gather time.
- **The P1 client modules and the string template are hand-written stand-ins** for compiler output. The classification that licenses them is `analyze.mjs`'s, and the server markup and gate are the real runtime's.
- **Limits:**
  - one large static-dominated page (hn) and two small live apps (todos, sync);
  - in-memory serving, so the network is not modeled (see resumability.md for bandwidth models);
  - the P2 oracle marks nodes by a source rewrite, not a compiler pass.

## Defaults (decided 2026-09-29)

- **Islands are opt-in** (`solidIslands` / `esbuildIslands` / `compileIslands`); full-page hydration stays the default until islands cover the fallback list above.
- **Fallbacks warn.** Every module that falls back to whole-module tier-2 hydration is named in a build warning with the reason (Vite `this.warn`, esbuild `warnings`).
- **Prefetch defaults to `"intent"`**: `pointerover` / `focusin` / `touchstart` on an island fetches its chunk; the loader still replays the first event if the chunk has not arrived. The intent listener adds ~0.2 KB gz to the loader: HN `C-lazy` is 0.7 KB gz at load (was 0.52 with `"interaction"`), gate ok. `prefetch: "interaction"` restores the smallest loader.
