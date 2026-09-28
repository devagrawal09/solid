---
"@solidjs/compiler": patch
---

Fix the clippy errors that failed `pnpm lint` (`cargo clippy -- -D warnings`): collapsible `if let`s and a single-arm `match`. No behavior change.
