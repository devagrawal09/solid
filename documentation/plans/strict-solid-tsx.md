# Strict Solid TSX: generator-free `$(fn)` callbacks

Status as of 2026-09-25: experimental, on `experiment/strict-solid-tsx`. This is the first vertical slice of a *generator-free* strict frontend: ordinary TypeScript/TSX callbacks marked with the existing `$` identifier, compiled completely for a statically known host or refused with a source-located diagnostic. Generator blocks (`$(function* …)`) are unchanged and documented in [typed-generator-compiler.md](./typed-generator-compiler.md).

## What the marker means

```tsx
const doubled = createMemo($(() => count() * 2));
createEffect($(() => console.log(count())), () => {});
const user = createMemo($(async () => { const id = userId(); return fetchUser(id); }));
<button onClick={$(() => setCount(value => value + 1))} />;
```

`$(fn)` with a non-generator arrow or function expression is a **compilation request**, not a runtime host. The compiler:

1. finds the host that consumes the callback,
2. analyzes the body against that host and builds a graph summary (host, reads, writes, owned creations, escapes, unsummarized calls, completeness),
3. erases the marker, so the host receives the ordinary callback — `createMemo(() => count() * 2)` — with Solid's runtime tracking, scheduling, equality, ownership, error, transition and suspense behavior untouched,
4. or fails the build with a `[STRICT_…]` diagnostic that names the unsupported edge and how to fix it.

A marked callback never reaches the generator driver or any other fallback runtime. Uncompiled (`generators: false`, or a module that skipped the compiler), dev builds of `$` refuse a plain arrow or async callback with `[STRICT_NOT_COMPILED]`; production builds cannot tell a lowered `function` body from a hand-written one and are not guarded.

At the type level `$(fn)` is `StrictCallback<Input, R>`: the callback type plus a phantom brand. Stock TypeScript cannot infer reads or writes from a body, so the brand only records the request; the graph lives in the compiler summary that `solid-tsc` and editor tooling consume.

## Accepted syntax (this slice)

| Position | Host kind | Notes |
| --- | --- | --- |
| `createMemo($(fn))` | `memo` | `fn(prev)`; sync or `async` |
| `createSignal($(fn))` | `signal` | the computed-signal form |
| `createEffect($(fn), effectFn)` | `effect` | the compute phase only; `effectFn` stays an ordinary callback |
| `createRenderEffect($(fn), effectFn)` | `render-effect` | same |
| `<el on*={$(fn)} />`, `<el on:name={$(fn)} />` | `event` | intrinsic (lowercase) elements only |
| `const h = $(fn)` used only in the positions above | that kind | every reference must be a host of one kind |

`createMemo`, `createSignal`, `createEffect`, `createRenderEffect` must be named imports from `solid-js` or `@solidjs/signals`. `createAsync` does not exist in this runtime (async memos are `createMemo(async …)`), so there is no `createAsync` host.

Inside the body, ordinary TypeScript:

- `count()` on a binding from `createSignal` / `createMemo` / `createOptimistic` (or a computed `createSignal`) is a **read**.
- `store.a.b`, `store.items[i]`, `store.items.length`, `props.x.y` on a `createStore` / `createProjection` / `createOptimisticStore` binding or a component's props parameter is a **path read**; `const user = store.user` (a `const` alias, inside or outside the callback) extends the path. A method call on a path (`store.items.filter(cb)`) is a **structural read** followed by an unsummarized call.
- `setCount(v)`, `setCount(v => v + 1)`, `setStore(…)` on a known setter is a **write**. Updater closures run synchronously and may capture anything.
- `createSignal(…)`, `createMemo(…)`, `createStore(…)`, `onCleanup(…)`, … are **owned creations**. A callback handed to a factory belongs to the created node (a nested `$(fn)` gets its own summary).
- `untrack(() => …)` runs its body synchronously; its reads are recorded as untracked.
- `await` is an ordinary suspension. In a reactive host, reads before the first `await` are the parent's dependencies.
- Unknown helpers (imports, globals, context values, outer functions, methods) may be called with **plain arguments**: literals, callback parameters, locals computed in the callback, read results, path values, closures that capture only plain values.

## Refused syntax (diagnostics)

| Code | Edge |
| --- | --- |
| `STRICT_HOST_UNKNOWN` | no statically known host: an unknown callee, a component prop (`<Child onPress={$(…)} />`), a JSX child, an export, a `let`/`var`, a value use, an unused `const`, a non-first argument |
| `STRICT_HOST_AMBIGUOUS` | one marker used as two host kinds |
| `STRICT_CAPABILITY_ESCAPE` | an accessor, setter, store, store setter, props object, marked callback, or a closure capturing one of those, handed to unsummarized code, stored, or returned |
| `STRICT_OPAQUE_ARGUMENT` | an import, context value or unknown outer binding passed to an unsummarized helper (strict mode cannot tell a value from an accessor) |
| `STRICT_WRITE_IN_REACTIVE_HOST` | a setter call inside a memo / signal / effect compute |
| `STRICT_READ_AFTER_AWAIT` | a reactive read after the first `await` in a reactive host |
| `STRICT_CREATION_AFTER_AWAIT` | an owned creation after `await` (any host): the runtime does not restore the captured owner, so this is explicitly unsupported rather than silently unowned |
| `STRICT_CONTEXT_IN_BLOCK` | `useContext` inside a marked callback: context is component-setup time |
| `STRICT_STORE_ASSIGNMENT` / `STRICT_ASSIGNMENT_TO_CAPABILITY` | assigning through a store / props, or reassigning a reactive binding |
| `STRICT_UNSUPPORTED_SYNTAX` | `this`, `super`, `arguments`, classes |

Events are untracked execution hosts: reads are recorded with `tracked: false`, writes and `await` are ordinary handler behavior, and nothing subscribes.

## The graph contract

`transform()` returns the summary as `result.strictBlocks`; `analyzeStrictBlocks(code, { filename })` returns it without rewriting (diagnostics reported, not thrown). Rust: `analyze_strict_blocks` / `StrictAnalysis::to_json`. Shape (`version: 1`), per marked callback:

```jsonc
{
  "id": "app.tsx#0",
  "host": { "kind": "memo", "factory": "createMemo", "events": [], "sites": [site] },
  "marker": site, "callback": site, "async": false, "awaits": [],
  "reads": [{ "kind": "signal" | "store" | "prop", "root": "count", "path": [], "access": "path" | "structural",
              "certainty": "exact" | "bounded", "tracked": true, "afterAwait": false, "site": site }],
  "writes": [{ "kind": "signal" | "store", "target": "setCount", "certainty", "afterAwait", "site" }],
  "creations": [{ "factory": "createSignal", "marked": false, "certainty", "afterAwait", "site" }],
  "calls": [{ "callee": "fetchUser", "certainty", "afterAwait", "site" }],
  "opaque": [{ "name": "config", "site" }],
  "escapes": [{ "kind": "accessor", "name": "count", "site" }],
  "completeness": "exact" | "bounded" | "unknown",
  "diagnostics": [{ "code": "STRICT_…", "message": "…", "site": site }]
}
```

A `site` is `{ start, end, line, column }`: authored UTF-16 offsets (TypeScript's unit) plus 1-based line and column, so consumers need no mapping.

- **exact**: every read through a known root is listed and every normal run performs it; no unsummarized calls, no opaque accesses.
- **bounded**: every read through a known root is listed, but some are conditional (branches, loops, closures, JSX containers, after an early `return`), and/or the listed `calls` / `opaque` accesses may read more through code the compiler has no summary for. Runtime tracking stays authoritative; a consumer that needs `exact` must summarize each listed callee.
- **unknown**: refused; `diagnostics` / `escapes` say why. The transform fails; `analyzeStrictBlocks` still returns the partial graph.

`certainty` on each read/write/creation/call is `exact` or `bounded` on the same basis. Nothing in the summary replaces Solid's dynamic dependency tracking: the compiler emits the plain callback, and a bounded read stays tracked at runtime.

## How `solid-tsc` and a language server consume it

`solid-tsc` (`@solidjs/typecheck`) runs `analyzeStrictBlocks` over every project file that may hold a marker and reports the diagnostics next to TypeScript's, as `error SOLID9000x: [STRICT_…] …` at authored positions; `check()` also returns `strictBlocks: Map<fileName, StrictBlockSummary[]>`. `analyzeStrictFile(fileName, text)` is the per-file boundary an editor language service calls: it returns the summaries plus TypeScript-shaped diagnostics (`file`, `start`, `length`, `source: "solid-strict"`, numeric `code`) on the authored text, so a plugin maps them to LSP diagnostics directly, renders hovers/code lenses from `reads` / `writes` / `creations` / `calls`, and shows `completeness` per callback. Because a marked callback is ordinary TypeScript, stock editor checking already types it; the strict layer only adds diagnostics and the graph.

## Known gaps

- **Path values are data.** A store path's value (`store.items`) is treated as the read's result, as `yield* store.items` is in generator blocks; at runtime a nested object is a live proxy, so an unsummarized helper receiving it can read it later without the graph knowing. Only the store / props roots are escapes. Typed summaries (the projection) are the right place to refine primitives from nested proxies.
- **No library summaries.** Every non-runtime callee is unsummarized; an import used as an argument is refused even when it is a plain constant. A summary/manifest format for libraries and a local escape hatch are future work.
- **Reactive creation after `await`** is refused, not supported: the runtime would need to restore and validate the captured owner and stale-flight state.
- **JSX inside a marked callback** is walked (expressions are bounded reads) but JSX blocks (`return $(function* …)`) are still the generator design; a marked callback as a JSX child has no host.
- **Only the compute phase** of `createEffect` / `createRenderEffect` is a host; a marker on the effect phase is refused.
- **Component props** (`<Child onPress={$(…)} />`) are not hosts: the component decides how the callback runs.
- **Event parameters** must be annotated at the callback (`$((e: MouseEvent) => …)`): the marker keeps the host's contextual type from pinning the input, as the generator form does.
- The runtime refusal of uncompiled markers is dev-only.
- No component-wide `"use solid-strict"` directive yet: strictness is per marker.

## Remaining work

- A `"use solid-strict"` module/component directive that marks every reactive callback implicitly and requires a whole-module (then whole-application) graph, reusing the analyzer and summary contract.
- Typed summaries from `solid-tsc`: attach resolved symbol identities across imports, prop/store value types, and primitive-vs-proxy refinement for path values.
- A custom Solid language server built on `analyzeStrictFile`: diagnostics, hover with the read/write graph, code lenses for `completeness`, quick fixes for the common refusals (read before passing, split ambiguous markers).
- Library summaries and a compat escape hatch for unsummarized helpers.
- Owner-restoring async creation, once the runtime can validate the captured owner across `await`.
