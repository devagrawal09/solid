---
"@solidjs/signals": patch
"solid-js": patch
---

`yield* Ctx` in a `$component` setup now works during server rendering. The block API's context op read through the client core's `getContext`, which has no owner on the server, so every v2 context read threw `NoOwnerError` in SSR. A context object may now carry its own reader (`Symbol.for("solid.contextRead")`); the server runtime's providers install one that reads the server owner tree.
