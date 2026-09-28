---
"@solidjs/compiler": patch
"@solidjs/signals": patch
"solid-js": patch
"@solidjs/web": patch
---

Generator blocks v2 hydrate from SSR without key misses or refetches:

- The compiler id-scopes a `$component`'s view (`$(fn, BLOCK_SYNC)`) like any other JSX block, so the server no longer gives its keys to a later sibling (`<Header />` then `<Loading>`: 104 key misses in todos-blocks).
- The server's deferral of a component or boundary called inside a view (`lazyView`) resolves under an id-carrying owner, as on the client, and server memo computations lower the block guard like the client's `recompute`, so the two sides defer the same calls (a view returning `<Loading>` over an async `$memo` now adopts the serialized value instead of fetching again).
- A path read forwarded into JSX content (`{props.children}` in a view) renders as the value it reads, on both renderers; the server used to resolve its proxy as a template object and hand the boundary to the client as "client-only content". `hasFinalHole` checks the `$clientHole` tag strictly.
- `insert` renders a hole's `$` block value (e.g. the root `() => <Page />`) in its outer computation: rendered in the inner unwrapping effect, a view returning `<Loading>` re-rendered — with a fresh boundary and fetch — every time the boundary settled.
