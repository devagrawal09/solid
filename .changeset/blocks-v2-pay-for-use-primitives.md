---
"solid-js": patch
"@solidjs/signals": patch
---

Generator blocks v2 are pay-for-use again: `solid-js` registers its hydration-aware primitives with the block runtime when `$signal` / `$memo` / `$store` / `$effect` / `effectBlock` is first used, instead of at module load. The top-level registration kept the block runtime and the whole store module in every client bundle — a `solid-js` + `@solidjs/web` counter shrinks from 81.4 kB to 41.9 kB minified (25.5 kB → 14.1 kB gzip). `@solidjs/signals`' block constructors reference their default primitive only at the use site, so `createStore` is retained only with `$store`.
