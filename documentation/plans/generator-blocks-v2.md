# Generator Blocks v2

Status: in progress (2026-09-27). Replaces the `$(function* …)` operation vocabulary
(`wait`, `attempt(fn, ...Errors)`, `write`, `call`, `$`) of
[typed-generator-compiler.md](./typed-generator-compiler.md). Strict (non-generator)
`$(fn)` callbacks are out of scope and unchanged.

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
| `$memo(function* / async function* () {…})` | memo | reads, `await`, `raise`, `attempt` |
| `$effect(function* () {…})` | effect | reads, writes, `$cleanup`, `raise`, `attempt` |
| `$event(function* / async function* (e) {…})` | event | reads (current value), writes, `await`, `$flush`, `raise`, `attempt` |

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
| `yield* attempt(fn, ...Errors)` | try/catch around `fn` (sync, or async in async blocks) | memo, effect, event |
| `yield* Child(props)` | the child's pending and failures, propagated | view |

Rules:

- A plain `throw` inside a block is a compile error; use `yield* raise(e)` so the
  failure is typed. `try`/`catch` is ordinary.
- Async is `await` inside an `async function*` (memo and event blocks only). A memo
  reads before its first `await`; a read after it is a compile error.
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

Props: `$component(function* (props: TypedProps<{ id: string }>) …)` or
`$component<{ id: string }>()(function* (props) …)` (TypeScript cannot take `P`
explicitly while inferring the rest, microsoft/TypeScript#26242).

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

Version one hoists branch reads unconditionally (a superset subscription with correct
values) and refuses reads whose source depends on a value computed in the callback
(other than another read) and reads in loops over runtime lists. Uncompiled, an effect
block runs as a tracked effect (reads and body in one pass, writes deferred).

### Interop

- Plain components render `$component`s and vice versa; plain components' effects are
  unknown (allowed as tags).
- Plain APIs accept generator functions directly: `createMemo(function* () {…})`,
  `createEffect(function* () {…})`. `$event` works anywhere.
- `$signal` / `$memo` / `$store` / `$effect` / `$cleanup` outside a component's setup
  are dev errors.

## Runtime model

Operations are performed **where they are evaluated**: an operation's iterator runs
the read, write, creation, cleanup or throw immediately and returns its value without
yielding. The generator's *declared* yield type carries the effects for TypeScript;
at runtime a block body never suspends on a `yield`, so

- a sync block runs in one `next()`;
- an async block (`async function*`) is an ordinary async function in disguise: its
  synchronous prefix runs inside the host's tracking scope, and `await` suspends;
- a `yield` that actually reaches the runner (a bare `yield x`) is an error.

The runner of each kind sets the current host; each operation checks it (dev errors
name the host and the operation). The strict read guard stays raised while a block
body runs synchronously, so a direct `count()` inside a block still fails in dev.

## Types

Block effects are the union of the operation types the generator yields
(`ReadOp<Source>`, `WriteOp<Setter>`, `CreateOp<Kind>`, `CleanupOp`, `ContextOp<C>`,
`FlushOp`, `RaiseOp<E>`), plus whether the body is async. Derived facts:

- `Pending` — own async, or a read of a source that can be pending (transitively);
- `Failures` — own raises, plus failures of read sources (transitively).

Values carry the result as phantom flags (`[PENDING]: boolean`, `[FAILS]: E`) so
`JSX.Element`, `JSX.ElementType`, `Loading`, `Errored` and `render` can check them
structurally.

## Build plan

1. Types and type tests (`packages/signals`, `solid-js`, `@solidjs/web` JSX types).
2. Runtime: the kinds, operations, receipts, props, context iteration, uncompiled
   effect and event runners.
3. Compiler: lower blocks to plain Solid (effect split, `X(props)` →
   `createComponent` with lazy props, host rules as compile errors).
4. Migrate `examples/todos-blocks`, conformance scenarios and tests; remove the old
   operations.
