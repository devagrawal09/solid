---
"@solidjs/signals": patch
---

Block runtime: fewer bytes for apps that do not build blocks, and fewer for apps that do. The store's `get` trap reaches the path-token machinery through a hook the first `$` block installs (the strict guard is only ever raised by a block run), so a store app without blocks no longer retains the tokens, `perform` and the operation dispatch (a `solid-js` + `@solidjs/web` app with a store: 81.8 kB → 75.7 kB minified). Block runtime error messages are full in development and a bare `[CODE]` in production (−3.0 kB minified in a small v2 app). An uncompiled (`function*`) body is driven without probing its result's shape, and a driven run registers its stale-marking cleanup only when it first suspends.
