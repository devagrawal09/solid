---
"@solidjs/signals": minor
---

Prototype: the store's traps can be called on a store's target with no proxy in between (`storeGet`, `storeHas`, `storeKeys`, `storeSet`, `storeDelete`, `storeProxy`, `isStoreTarget`), a nested value's proxy is made when it first leaves as a value instead of when its target is created, and `mapArray` takes a list given as its target and hands each row as its target.
