---
"@solidjs/web": patch
"@solidjs/compiler": patch
---

`hydrate()` called after hydration has completed now hydrates a root that still holds unclaimed server markup for its `renderId` (a lazily or progressively hydrated island) instead of silently falling back to a client render that re-creates its DOM; roots hydrated before, and roots without server markup, keep the client-render fallback. Add `summarizeIslands` and the `@solidjs/compiler/islands` linker (`linkIslands`), which derive, from a module graph, which islands must be hydrated before each handler or exported function runs (the hydrate-before-write rule for lazy hydration), over-approximating through escaped setters and accessors.
