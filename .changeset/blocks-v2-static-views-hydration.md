---
"solid-js": patch
"@solidjs/web": patch
---

Generator blocks v2: static views (`BLOCK_STATIC`) render once, untracked, while hydrating too — the render effect the hydrating `insert` kept was transparent and never carried an id scope; the view's ids come from its `blockScope` on both sides. The server now resolves a deferred component call (`lazyView`) in a view's hole where `escape` meets it, as the client's `insert` does, instead of at `ssr()` time: a view with a component before a scoped hole (`<A /><p>{x}</p><B />`) no longer misses the component's hydration keys.
