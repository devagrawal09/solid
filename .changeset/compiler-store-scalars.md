---
"@solidjs/compiler": patch
---

Add the experimental `storeScalars` compiler option (off by default): a `const [s, setS] = createStore({ … })` whose initial shape is a flat object of provably primitive values, whose every read is `s.key`, and whose setter only assigns whole fields with provably primitive values (`d.key = e`, `d.key op= e`, `d.key++`) is replaced by one signal per field. Draft semantics are kept: reads of the written field inside the setter (`d.key`, `s.key`) become a functional updater's latest value. Measured −54% to −60% mount and −71% update on per-row stores, gated for identical values and effect runs.
