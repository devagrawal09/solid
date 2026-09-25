# Solid 2.0 Todos — `$` typed blocks

A copy of [`examples/todos`](../todos) (the Solid 2.0 TodoMVC) rewritten so that every reactive boundary is a `$` typed generator block. Behavior and markup are the same as the source example; only `src/app.tsx` (and the return type of `createHashFilter` in `src/filter.ts`) changed. `src/todos.ts`, `src/api.ts` and `src/main.tsx` are verbatim copies.

What the rewrite exercises:

- **Signal reads** — `yield* props.filter` (the hash filter is typed as the signal's `SourceAccessor`, so it is iterable).
- **Direct property reads** — `yield* todo.title`, `yield* todo.completed`, `yield* todos.length`: one tracked read of that path through the store proxy, no helper. The native compiler lowers each to `perform(readPath(todo, ["title"]))`; the runtime driver (tests) resolves the same spelling through path tokens. Typed `StoreRead<Root, Path>` — which stock `tsc` cannot infer, so `pnpm typecheck` runs `solid-tsc` (`packages/typecheck`), which projects the spelling before checking and maps diagnostics back to source.
- **Structural store reads** — `yield* readStore(todos, t => t.filter(…).length)` / `t.every(…)`: selectors for reads that are not a single path; the proxy tracks exactly what each selector touches.
- **Derived computations** — `createMemo($(function* () { … }))` for `filtered`, `allCompleted`, `remaining`, `completed`; memos made from blocks are themselves readable with `yield* remaining`.
- **JSX blocks** — each component returns `$(function* () { return <…>{yield* …}</…> })`; `yield*` inside JSX lowers to the fine-grained read the JSX effect owns.
- **Event blocks** — `onKeyDown={submit}`, `onInput={toggle}`, `onClick={remove}`: blocks bound at the DOM sink, run as event hosts. The `action`s from `todos.ts` are invoked through `attempt(...)` — the honest record of an untyped step (actions are Solid's transaction dialect and stay as they are).

Left as ordinary code, on purpose: the `action` generators and the projection in `todos.ts`; the keyed `<Show>{error => …}</Show>` child and the `<Errored>` fallback (their `error` argument is typed as a plain `Accessor`, which is not iterable — widening it would weaken the types); static markup. Mark-all uses `onInput` (delegated) instead of `onChange`: a non-delegated event is bound with the native `addEventListener` and would not reach the event-block sink.

The app is compiled by the native compiler with the `generators` pass on (default), so every block in `src/app.tsx` runs lowered (call form, `perform(op)`); `tests/app.test.tsx` also runs one block on the runtime generator driver.

## Run

```bash
pnpm --filter todos-blocks-example test
pnpm --filter todos-blocks-example typecheck
pnpm --filter todos-blocks-example build
pnpm --filter todos-blocks-example start   # http://localhost:3012
```
