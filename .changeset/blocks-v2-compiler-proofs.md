---
"@solidjs/compiler": patch
---

Generator blocks v2 lowering: lowered v2 bodies carry their `BLOCK_SYNC` proof by default (`$(fn, 1)`: no result-shape probes per run; host annotations still need `blockProofs`), and a `$component` whose props are only read through lowered path reads is emitted as `$component(body, PROPS_COMPILED)`, skipping the typed-props proxy. With `hostFusion`, v2 bodies fuse too: a `$memo` in a lowered setup becomes `createMemo(fn)` (imported from the module `$memo` came from), a split `$effect`'s compute becomes a plain function, and `{yield* acc}` children of intrinsic elements (DOM output) read the proven accessor directly.
