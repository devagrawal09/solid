---
"@solidjs/compiler": patch
"@solidjs/babel-plugin": patch
---

The JSX transforms' block rule: inside a JSX expression or attribute value, `yield* e` becomes `perform(e)` imported from `blocksModule` (default `@solidjs/blocks`), so each read is its own hole; event props, `ref`, spreads, spread children and plain `yield` are refused with a code (the list is pinned by `tests/blocks-rule-fixtures.json`).
