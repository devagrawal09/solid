# Generator Blocks v2

Status: implemented (2026-09-27). Replaces the `$(function* …)` operation vocabulary
(`wait`, `attempt(fn, ...Errors)`, `write`, `call`, `$`) of
[typed-generator-compiler.md](./typed-generator-compiler.md). Strict (non-generator)
`$(fn)` callbacks are out of scope and unchanged.

`wait`, `write` and `call` are removed. `$` stays exported as the compile target
(the compiler wraps v2 bodies in `$`) and as the internal block constructor; blocks are
authored with `$component` / `$memo` / `$effect` / `$event` (or a generator passed to
`createMemo` / `createEffect`).

## Goal

Every reactive piece of a Solid app can be a generator block whose effects are
visible to TypeScript: what it reads, writes, creates, cleans up, whether it can be
pending, and which errors it can fail with. The kind of block is chosen by the
function that makes it, and each kind admits a fixed set of effects. The compiler
lowers blocks to plain Solid; the runtime runs them uncompiled too.

A component's *pending* and *failures* travel with the values it renders, and
`JSX.Element` admits only settled values, so rendering an async component without a
`<Loading>` (or a fallible one without an `<Errored>`) is a TypeScript error in any
editor.

## API

| Function | Block kind | Allowed inside |
| --- | --- | --- |
| `$component(function* (props: TypedProps<P>) { …; return function* () { return <…/> } })` | component (setup) + returned **view** | setup: `$signal`, `$memo`, `$store`, `$effect`, `$cleanup`, `yield* Ctx`; view: reads only |
| `$memo(function* () {…})` | memo | reads, `raise`, `attempt` (sync or async) |
| `$effect(function* () {…})` | effect | reads, writes, `$cleanup`, `raise`, `attempt` |
| `$settled(function* () {…})` (setup) / `onSettled(function* () {…})` | run-once effect: runs after the graph settles, never re-runs | effect rules; reads are current values, not subscriptions |
| `$event(function* (e) {…})` | event | reads (current value), writes, `$flush`, `raise`, `attempt` (sync or async) |

Operations (always `yield*`):

| Operation | Effect | Kinds |
| --- | --- | --- |
| `yield* count`, `yield* props.x`, `yield* store.a.b` | read | view, memo, effect, event |
| `yield* $signal(v)` → `[get, set]`, `yield* $store(v)` → `[store, set]` | create | component |
| `yield* $memo(…)` → accessor, `yield* $effect(…)` | create | component |
| `yield* set(v)` (setters from `$signal` / `$store`) → the new value | write | effect, event |
| `yield* $cleanup(fn)` | cleanup | component, effect |
| `yield* Ctx` → the context value | context | component |
| `yield* $flush()` | flush | event |
| `yield* raise(error)` | failure (typed throw) | memo, effect, event |
| `yield* attempt(fn, ...Errors)` | try/catch around `fn`; when `fn` returns a promise the block suspends until it settles (async) | memo, event (sync `fn` also in effect) |
| `yield* Child(props)` | the child's pending and failures, propagated | view |

Rules:

- A plain `throw` inside a block is a compile error; use `yield* raise(e)` so the
  failure is typed. `try`/`catch` is ordinary.
- Async is `yield* attempt(() => promise)`: the block suspends until the promise
  settles and resumes with its value, or with the rejection thrown at the `yield*`
  (so `try`/`catch` around it works). Memo and event blocks only. A memo reads before
  its first async `attempt`; a read after it is an error. Blocks are always
  `function*`, never `async function*`: inside an async generator *every* `yield*`
  suspends (the spec awaits each delegated step), so only the first read of an async
  memo would be tracked. Measured: `yield* a; yield* b` in an `async function*` tracks
  `a` and not `b`.
- Setters returned by `$signal` / `$store` always return a *write receipt*; `yield*`
  on it evaluates to the new value. Setters of plain `createSignal` are unchanged and
  may be called without `yield*` in effect and event blocks (the compiler still
  records the write).
- A component's setup does not read; its view does not create or clean up.

### Components and rendering

`$component` returns `Component<P, { pending, failures }>`, computed from the view.
Calling it returns its view: `UserCard({ id: "42" })`.

| Form | Meaning | Type rule |
| --- | --- | --- |
| `<X />`, `{X(props)}` | render a settled component | the value must be settled |
| `{Loading({ fallback, children: X(props) })}` / `{Errored({ fallback, children })}` | handle here | the boundary returns the value without pending / failures |
| `{yield* X(props)}` | propagate to the parent | X's pending / failures join this view's |

`render(App, root)`, `hydrate` and island roots accept settled components only: every
pending and every failure must be handled by a `Loading` / `Errored` above it.

Call forms create their arguments first, so a boundary must receive its children
lazily to own them: the compiler turns `Loading({ fallback, children: X(p) })` into
`createComponent(Loading, { fallback, get children() { return X(p) } })`.
Uncompiled code writes the getter itself. Likewise a `yield*` inside a JSX
expression (`<section>{yield* X(p)}</section>`) needs the compiler: the JSX
transform wraps expressions in closures, so uncompiled views hoist the `yield*`
into a `const` first.

Props: `$component(function* (props: TypedProps<{ id: string }>) …)` or
`$component<{ id: string }>()(function* (props) …)` (TypeScript cannot take `P`
explicitly while inferring the rest, microsoft/TypeScript#26242).

### Render callbacks as blocks (row blocks)

A render callback of `For`, `Show`, `Match` or `Repeat` may be a block with its own
setup and view, the way a child component would be — so per-row state does not need a
component:

```tsx
<For each={comments}>
  {function* (c) {
    const [open, setOpen] = yield* $signal(true);
    const toggle = $event(function* () { setOpen(o => !o); });
    return function* () {
      return <li onClick={toggle}>{c.text} {(yield* open) ? "[-]" : "[+]"}</li>;
    };
  }}
</For>
```

Three spellings, one meaning: a bare `function*`, `$(function* …)`, or a **named row
block** declared in the setup and passed by name (`function* comment(c) { … }` …
`<For each={c.comments}>{comment}</For>`), which may render itself recursively.
`$scope(function* (item, index) { … })` builds the same callback explicitly. The setup
runs once per row (per `Show` / `Match` branch activation), receives the item and the
index, and creates; its `$cleanup`s run when the row is disposed (on the server too:
the server registers `onCleanup`); the view is tracked like a component view. Uncompiled,
`renderCallback` recognizes a generator function or a `SCOPE_CALLBACK`-marked callback;
plain callbacks are unchanged.

Types: the flow controls accept `RowBlock<[item, index], SetupOps, ViewOps>` after their
plain overloads. The setup may only create and the view may only read (host rules as
for components). A row's pending / failures propagate into its own view, and a flow
control renders settled rows only: an unsettled row view is a type error
(`[UNSETTLED_ROW]`), handled with `Loading` / `Errored` inside the row. Creation outside
the setup is a type error and, compiled, `[OP_NOT_ALLOWED]`.

`{child => yield* comment(child)}` is a compile error (`[YIELD_IN_CALLBACK]`): in a plain
arrow it is not a delegation but `yield * comment(child)`. Pass the block (`{comment}`)
or write the callback as a block.

### Effects

`$effect` source may read after writing (writes are deferred until flush, so a later
read sees the committed value, as in plain Solid). The compiler splits the block:
every signal the callback reads moves into the compute half; the callback becomes the
effect half and receives the values. `$cleanup` becomes the returned cleanup.

```ts
yield* $effect(function* () {
  const q = yield* query;
  yield* setUrl(`/search?q=${q}`);
  if (yield* showLog) console.log(q);
  yield* $cleanup(() => cancelPending());
});
// →
createEffect(() => [query(), showLog()], ([q, log]) => {
  setUrl(`/search?q=${q}`);
  if (log) console.log(q);
  return () => cancelPending();
});
```

The compute half keeps the body's control flow, so it subscribes to exactly the reads
the body takes, as a hand-written compute would. A read under an `if` / `else`, `?:`,
`&&`, `||` or `??`, or after an early `return`, is read only under the same condition,
evaluated over the compute's own values (`const v = yield* a` makes `v` the value of
`a`'s read) and bindings declared before the effect that nothing writes:

```ts
yield* $effect(function* () {
  const v = yield* a;
  if (v > 1) log(yield* c);
});
// →
createEffect(
  () => { const r0 = a(); const r1 = r0 > 1 ? c() : undefined; return [r0, r1]; },
  ([v, c]) => { if (v > 1) log(c); }
);
```

A condition the compute cannot evaluate (a call, a member access, a mutable
binding) is dropped from the read's guard — never inverted — so the read is taken at
least as often as the body takes it; reads under `switch`, `try`, labels or optional
chains are taken on every run. The split is refused for reads whose source depends on
a value computed in the callback (other than another read) and reads in loops over
runtime lists. Uncompiled, an effect block runs as a tracked effect (reads and body in
one pass, writes deferred).

### Interop

- Plain components render `$component`s and vice versa; plain components' effects are
  unknown (allowed as tags).
- Plain APIs accept generator functions directly: `createMemo(function* () {…})`,
  `createEffect(function* () {…})`. `$event` works anywhere. Uncompiled, the core
  reaches the block driver through a hook the driver installs when the first block
  is built, so apps that never build a block do not carry it (pay-for-use; a dev
  error names the missing driver).
- `$signal` / `$memo` / `$store` / `$effect` / `$cleanup` outside a component's setup
  are dev errors.

## Runtime model

Blocks run on the existing generator driver. Each operation is yielded to the driver,
which checks the current host (dev errors name the host and the operation), performs
it with the strict read guard lowered, and resumes the generator with the result (or
throws the failure into it at the `yield*`). An async `attempt` suspends the run; the
driver resumes the generator when the promise settles, with the host and guard
restored, and a superseded run is closed instead of resumed.

New operation kinds: `create` (`$signal`, `$store`, `$memo`, `$effect`), `cleanup`,
`context`, `flush`. New hosts: component, effect (view = the existing JSX host, memo =
the existing reactive host, event unchanged). Setter receipts and child views do not
reach the driver: a `$signal` setter writes when called (refusing a host that may not
write) and its receipt evaluates to the new value; `yield* X(props)` evaluates to X's
view, which is rendered as its own component.

## Types

Block effects are the union of the operation types the generator yields
(`ReadOp<Source>`, `WriteOp<Setter>`, `CreateOp<Kind>`, `CleanupOp`, `ContextOp<C>`,
`FlushOp`, `RaiseOp<E>`), plus whether the body is async. Derived facts:

- `Pending` — own async, or a read of a source that can be pending (transitively);
- `Failures` — own raises, plus failures of read sources (transitively).

Values carry the result as phantom flags (`[PENDING]: boolean`, `[FAILS]: E`) so
`JSX.Element`, `JSX.ElementType`, `Loading`, `Errored` and `render` can check them
structurally.

## Compiler

`packages/compiler/src/blocks_v2.rs` runs before the generator pass and rewrites the
v2 forms into `$(function* …)` blocks, which that pass lowers to call form (`yield* x`
→ `perform(x)`, member chains → path readers, `yield*` inside JSX supported):

- the generator argument of `$component` / `$memo` / `$event` / single-argument
  `createMemo`, and the view a setup returns, are wrapped in `$` (the runtime
  constructors accept a prebuilt block);
- `$effect` / `createEffect(function* …)` are split: every read moves into a compute
  block, the body becomes the effect half and receives the values as `_$v[i]`, and its
  `$cleanup`s are returned as the half's cleanup. The split is refused (one tracked
  pass instead) for a read in a loop, a read of a binding declared inside the effect,
  or a body with parameters. A plain `createEffect(function* …)` becomes
  `effectBlock(…)`;
- `Loading(…)` / `Errored(…)` anywhere, and capitalized calls with an object literal
  inside a view, get getters for their non-literal props. A `yield*` inside such props
  is a compile error (`[YIELD_IN_LAZY_PROP]`): the getter would not belong to the view;
- host rules are compile errors (`[OP_NOT_ALLOWED]`), classified from syntax: `$signal`
  / `$store` / `$memo` / `$effect` calls create, `$cleanup` / `$flush` / `raise` /
  `attempt` are themselves, a call of a `$signal` / `$store` setter writes, and a read
  of a `$signal` / `$memo` accessor or a props path is a read setup may not do;
- a render callback that is a block (bare `function*`, `$(…)`, or a named row block
  referenced as a callback) becomes `$scope(…)`, which the lowering turns into
  `$scopeCompiled(setup)`; a named row block becomes
  `const name = _$scopeBlock(_$$(function* …))` so its recursive uses share it. For the
  islands compiler a row block is a *scope*: the partitioner treats it as a component
  (ssr-hydration-redesign.md, "Scopes");
- in memo and event bodies an `attempt` may be async, so on the server a body that
  attempts stays a generator for the runtime driver; on the client it compiles to an
  `async function` run by `asyncBody` (a memo) or `$eventAsync` (an event) when every
  other operation is erased (else the generator is restored exactly). Effect, setup and
  view bodies lower fully.
- async timing contract: a compiled async body is exact where its result is observable
  and lean where it is not. A memo's result (`asyncBody`) settles in the driver's
  microtask, level for level. An event handler returns nothing, so the driver's result
  promise only ever reaches the dispatcher's rejection routing: `$eventAsync` keeps the
  synchronous segment, the job of every continuation and write, the boundary a failure
  reaches and the unhandled rejection without one, but routes a failure after a wait in
  the job the body fails in (n + 1 reactions earlier than the driver, for n waits).

After lowering, the proof-driven host fusion runs on the v2 bodies by default (a `$memo`
in a setup is `createMemo(fn)`, a split effect's compute a plain function, a view hole
of a proven accessor a direct call), and DOM output is lowered further by
`packages/compiler/src/blocks_v2_lower.rs` wherever the result is the same by
construction: setup creations become direct primitive calls from the module the
constructor came from (a `$signal` setter keeps its write receipts only when it
escapes), a split effect whose `$cleanup`s are top-level statements becomes
`createEffect(compute, half)` returning its cleanup, `$event` and setup blocks with no
operation left lose their block (`$eventCompiled(fn)`, `$componentCompiled(fn)`), and a
module whose every block is lowered and proven synchronous imports `syncBlock` instead
of `$`, so it does not retain the generator driver. The same pass compiles memo and
event bodies that wait to `async function`s (`asyncBody`, `$eventAsync`), setup context reads and
module-local helper generators that only read contexts to direct `readContext` calls,
`$settled` / `onSettled(function* …)` bodies to `onSettled(fn)`, and the view reads the
fusion left (attribute holes, prop getters) to `readAccessor` / `readSelected` — plain
calls inside the computations the JSX transform creates. `hostFusion: false` turns all
of it off. See [blocks-v2-performance.md](./blocks-v2-performance.md), sections 9–14.

## Build plan

1. Types and type tests (`packages/signals`, `solid-js`, `@solidjs/web` JSX types). Done.
2. Runtime: the kinds, operations, receipts, props, context iteration, uncompiled
   effect and event runners. Done.
3. Compiler: lower blocks to plain Solid (effect split, lazy props for component and
   boundary calls, host rules as compile errors). Done (`blocks_v2.rs`).
4. Migrate `examples/todos-blocks` and `examples/sync-blocks` to v2; remove `wait`,
   `write` and `call` (tests, fixtures and conformance scenarios moved to `attempt`,
   direct setter calls and v2 receipts). Done.

Follow-ups: a Volar plugin so editors show the compile-time host rules inline. The
effect split's dynamic reads (only the reads each branch takes) are done.
`PROPS_COMPILED` (skip the typed-props proxy when every prop read was lowered) is done;
its cost, and the rest of the runtime and bundle cost of blocks, is measured in
[blocks-v2-performance.md](./blocks-v2-performance.md).
