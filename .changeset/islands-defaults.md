---
"@solidjs/compiler": patch
---

Compiled islands: prefetch defaults to `"intent"` (hover / focus / touch fetches an island's chunk), and every module that falls back to hydration is named in a build warning (Vite and esbuild).
