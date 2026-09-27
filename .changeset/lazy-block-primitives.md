---
"solid-js": patch
---

Stop shipping the store in apps that never create one. The hydration-aware
block primitives (`$signal`, `$store`, `$memo`, `$effect`, `effectBlock`) are
now registered on first use of a block constructor instead of at module scope,
where the registration named `createStore` in the flat `solid-js` bundle and
kept the whole store (~24 kB min / 8 kB gz) in every app.
