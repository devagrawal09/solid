---
"@solidjs/signals": patch
"solid-js": patch
"@solidjs/compiler": patch
---

Effects accept an `equals` option: when the new compute value equals the previous one, the effect phase is skipped. Add the experimental `memoFusion` compiler option (off by default): a pure, synchronous `createMemo` with a single reader (a same-component JSX expression, another memo, or an effect whose compute is exactly `() => m()`) is inlined into that reader, and an effect reader gets `equals: isEqual` so the memo's cut-off is kept. Narrowing memos (comparison or `!` results) and memos over shared sources are left alone. Measured −57% to −64% on mount and update for a memo chain.
