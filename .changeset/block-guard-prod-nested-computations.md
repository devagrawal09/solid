---
"@solidjs/signals": patch
---

Lower the `$` block strict guard for every computation run in production builds too. The block driver raises the guard and store proxies answer it with path tokens in every build tier, but a computation run only lowered it in development, so in production a `Show`, `For` or render effect created inside a component view block read stores as path tokens and the block failed with `[UNREAD_PATH]` (the todos-blocks example rendered its error fallback).
