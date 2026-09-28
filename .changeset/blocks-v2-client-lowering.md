---
"@solidjs/compiler": patch
"@solidjs/signals": patch
"solid-js": patch
---

Generator blocks v2 client lowering. The v2 host fusion is on by default (`hostFusion: false` opts out; `hostFusion: true` also fuses plain `$` blocks), and DOM output lowers what is left of a compiled `$component` to plain Solid where the semantics are identical: setup creations are direct primitive calls from the module the constructor came from (`$signal` → `createSignal`, `$store` → `createStore`, `$memo` → `createMemo`, `$cleanup` → `blockCleanup`; a setter keeps its write receipts only when it escapes), a split effect whose half registers `$cleanup` at its top level becomes `createEffect(compute, half)` returning its cleanup, `$event` and setup blocks with no operation left are erased (`$eventCompiled(fn)`, `$componentCompiled(fn)`), and a module whose every block is lowered and proven `BLOCK_SYNC` imports `syncBlock` instead of `$`, so it no longer retains the generator driver (a small v2 app: 90.0 → 84.8 kB minified, 27.8 → 26.3 kB gzip). The effect split keeps the body's control flow: a read in an untaken branch is no longer subscribed. New internal entry points: `syncBlock`, `blockCleanup`, `withReceipts`, `$componentCompiled`, `$eventCompiled`, `effectBlockCompiled`, `settledBlockCompiled` (`solid-js`'s `effectBlockCompiled` registers the hydration-aware `createEffect`).
