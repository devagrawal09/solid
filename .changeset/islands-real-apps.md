---
"@solidjs/compiler": minor
---

Compiled islands handle real apps (experimental):

- **Streaming.** A `<Loading>` over server data renders through a boundary helper: awaited in place without a stream, and with `renderIslandsStream` / `renderIslandsToString` (new `@solidjs/compiler/islands-stream`) its fallback goes in the shell and its content follows as an out-of-order chunk (`<template>` + a `$sl` swap); a failure renders the nearest `<Errored>` fallback over its region. Islands in a chunk activate as it lands; an island whose static paths cross a boundary (`waits` in the manifest) activates once it has landed.
- **Tier-2 islands instead of whole-module fallback.** Stores (`$store` / `createStore` / `createPlainStore`) are the core's plain store, rebuilt from their constant or from the anchor's `data-s` (only the top-level keys their code touches); optimistic stores, projections and live async memos are adopted from the server's settled value (their first client run does not re-run the fetch); `readStore`, `action`, `refresh` and an `$event` that `attempt`s async work compile; a live `Show` may take a render callback; rows of a `For` over a store bind their item's fields.
- **Islands spanning modules.** `islandExports(code)` summarizes a module (exports by kind, relative imports); the islands compiler passes an importer the sources of the modules whose factories, helper generators or components it uses (`imports` option), and `compileIslands` inlines their closures and the factory calls in setups, so flows, liveness and tiers see across modules. Imported contexts keep their identity; a `yield*` read of a value from a module the compiler does not see is refused.
- **Client error boundaries.** An `<Errored>` around or inside a tier-2 island's live content (including rows the client creates) is a client error boundary: its content activates inside `createErrorBoundary`, a failure shows the fallback (built from its JSX with `err` / `reset`) and a reset puts the content back.
- **Client pending boundaries.** A `<Loading>` the client creates (inside a live `Show` / `For`, or in a component rendered there) over content that reads async state is a client pending boundary: the server marks its region, the content activates inside `createLoadingBoundary`, and while it is pending the content is detached (kept, still bound) and the fallback shows. A `<Loading>` over content that cannot be pending on the client is pass-through.
- **Contexts provided outside an island** are serialized at its root when no provider gives them reactive state.
- **Component call forms** (`Loading({ … })`, `Errored({ … })`, `User({ … })`) are read as the JSX they stand for.
- **Prefetch budget** counts bundled output bytes in the Vite plugin (written to `.vite/solid-islands.json`).
- **Dev verifier.** With `verify` (default in the Vite dev server) chunks export `verify(anchor)` and the entry reports every server node that does not match an island's static addresses, with the component and source line.

Fixes: the client read an island's `data-s` values without its id; a keyed list over a store array did not track its items; a concise arrow returning JSX on the server produced a block body.
