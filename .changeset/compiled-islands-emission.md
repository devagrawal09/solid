---
"@solidjs/compiler": minor
"@solidjs/signals": minor
---

Compiled islands (experimental): `compileIslands(code, options)` compiles a generator-blocks-v2 module into a string-template server module (no hydration keys, no owner tree; only island anchors, the islands' serialized values and marker pairs around live holes), one activation chunk per island group, and a manifest. Islands are cut from the live parts of the block graph (cells some handler or effect writes, the holes that read them, the handlers), not along component boundaries; each group gets the smallest runtime its graph allows — tier 0 (no reactive runtime, `@solidjs/signals/t0`), tier 1 (the kernel, `@solidjs/signals/kernel`) or tier 2 (the core) — and a module the compiler cannot compile falls back to today's hydration with the reason in the manifest. `@solidjs/compiler/islands-build` adds the page entry generator (the loader with ordered replay of the first event, prefetch policies per app / per island / by budget and network), a Vite plugin (`solidIslands`) and an esbuild plugin. `@solidjs/signals` publishes the tier-1 kernel and the tier-0 helper as `@solidjs/signals/kernel` and `@solidjs/signals/t0`.
