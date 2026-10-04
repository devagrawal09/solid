---
"@solidjs/vite-plugin-blocks": minor
---

New package: the JSX transform's one block rule for `@solidjs/blocks` as a standalone plugin (D-003). Inside a JSX expression or attribute value, `yield* e` becomes `perform(e)` imported from `blocksModule` (default `@solidjs/blocks`). Event props, `ref`, spreads, spread children and plain `yield` are refused with the codes `BLOCKS_YIELD_IN_EVENT`, `BLOCKS_YIELD_IN_REF`, `BLOCKS_YIELD_IN_SPREAD`, `BLOCKS_YIELD_IN_SPREAD_CHILD` and `BLOCKS_PLAIN_YIELD_IN_JSX`. Exports `babelPluginBlocks`, `transform(code, { filename, blocksModule })` (edits only the rewritten spans: TypeScript and formatting are kept, the source map is exact, `null` when nothing changes) and the rule as one function, `blocksRule`. Checked-in outputs generated from the fork's Rust rule pin the result byte for byte.
