---
"@solidjs/signals": patch
"solid-js": patch
"@solidjs/compiler": patch
---

Bundle slicing from compiler facts (core runtime slicing, Track B).

- `@solidjs/signals`: `renderBlock`, `dispatchBlock` and `lazyView` as exported from the package are install-on-use forwarders (`block-hooks.ts`) that the block runtime fills when the first block is built, so renderers (`@solidjs/web`'s `insert` and event delegation, `flatten`, the `solid-js` boundaries) no longer retain the block host machinery in apps that never build a block. New single-form store constructors `createPlainStore(value, options?)` and `createDerivedStore(fn, seed, options?)`; `$store` creates through the plain one, so it no longer retains projection / reconcile.
- `solid-js`: exports `createPlainStore` and a hydration-aware `createDerivedStore` (client and server); the `$store` wrapper registers the plain store.
- `@solidjs/compiler`: `storeForms` (default on) rewrites `createStore` calls whose first argument settles the form to `createPlainStore` / `createDerivedStore`. New `summarizeCompiled(code)` reports facts about a module's compiled output (runtime names referenced, creation kinds, store reads, residual generators and their `yield*`, compiled seams). The capability linker (`solidCapabilities`) reads every application module's compiled output in a build (`compiledFacts`, default on): ITERABLE turns off when no `yield*` is left after compilation, COMPILED_SEAMS when no module requests a seam, and the import-decided switches follow the names the output references. Virtual (generated) entries are summarized through the bundler's loader.
