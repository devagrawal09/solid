---
"@solidjs/signals": minor
"solid-js": minor
"@solidjs/web": minor
"@solidjs/compiler": minor
---

Add `$` typed blocks with host-restricted effects (experimental). `$(function* () { … })` builds one generic `Block<Value, Reads, Tasks, Failures, Writes, Input>` whose every effectful step is a yielded operation: `yield* signal` / `yield* readStore(store, selector)` (Reads — a store read runs the selector as one operation and records the store root), `yield* wait(promise, ...Errors)` (Tasks), `yield* raise(error)` / `yield* attempt(fn, ...Errors)` (Failures), `yield* write(setter, value)` (Writes), `yield* call(block, input)` / `yield* block` (delegation; the callee's categories accumulate). Read tokens carry the source's own metadata, so `BlockAsync` / `BlockErrors` derive totals transitively. The host restricts the block: reactive computations (`createMemo`, `createSignal(fn)`, effect computes) refuse Writes; a block rendered as JSX (`JSX.Element`, `insert`, `flatten` → `renderBlock`) admits reads only; a block bound to a DOM event (`dispatchBlock` at the delegated / `addEvent` sinks) admits everything, runs like an ordinary handler, and routes failures to the error boundary above its creation owner. Dev builds refuse direct `signal()` reads inside a block body; the compiler lowers the sync subset to call form (`perform(op)`) ahead of JSX lowering (`generators` option) and rejects `throw`, bare `yield`, async generators and JSX-embedded yields in blocks it cannot lower. `loading()` / `errored()` are function-style boundaries over blocks.
