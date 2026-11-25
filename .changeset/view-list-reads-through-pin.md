---
"@solidjs/signals": patch
---

`openView`: a store list rewritten whole (`setList(l => [x, ...l])`) rewinds under a view when its rows are read untracked (`mapArray`, `<For>`): a key with no node of its own is read through the view's pin on the list, not from the store's backing. Observe and dev tiers only; prod is unchanged.
