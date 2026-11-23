---
"@solidjs/signals": minor
---

Prototype: build-time store feature switches. A new `dist/select` tier (export condition `store-select`) leaves six switches to the consuming bundler's `define` (`__SOLID_STORE_ACCESSORS__`, `__SOLID_STORE_GUARDS__`, `__SOLID_STORE_SHALLOW__`, `__SOLID_STORE_FAMILIES__`, `__SOLID_STORE_OPTIMISTIC__`, `__SOLID_STORE_DELETE__`); `false` folds that feature's arms out of the store. Every other tier is built with all of them on and is unchanged.
