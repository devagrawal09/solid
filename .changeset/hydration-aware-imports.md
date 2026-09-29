---
"@solidjs/compiler": patch
---

Hydrating builds re-source hydration-aware names imported from `@solidjs/signals` to `solid-js`: block constructors (`$signal`, `$store`, `$memo`, `$effect`, `$settled`, `effectBlock`, `settledBlock`, …) and the primitives `solid-js` overrides (`createSignal`, `createMemo`, `createEffect`, `createStore`, `createProjection`, …). Imported from the low-level package, they would skip hydration, and the v2 lowering's fused primitives would inherit the wrong source.
