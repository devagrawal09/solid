---
"@solidjs/signals": minor
---

Prototype: `plainData` store option. A store declared to hold plain data only (no accessors, class instances or symbol keys) skips the accessor probes on a key's first read and a record's first write, and its targets of no family answer `get` through a trap with the family, optimistic, shallow and accessor arms removed.
