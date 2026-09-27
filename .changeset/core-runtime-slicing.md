---
"@solidjs/signals": patch
"@solidjs/compiler": patch
"@solidjs/web": patch
---

Core runtime slicing: link-time feature switches. The reactive core's inline
seams for optimistic state, the verdict layer (`isPending`/`latest`), stores
and projections, hydration snapshots, `yield*` accessors and compiler-emitted
fast paths are gated on constants in one module (`core/features.js`), which
the published per-module trees keep as a real file with every switch on — the
default build is unchanged. The capability linker
(`@solidjs/compiler/capabilities`) now proves, per switch, that an application
graph never uses the feature (library manifests gained `featureExports`) and
substitutes the module with those switches off; the app bundler folds them.
Reaching a switched-off feature throws `[FEATURE_EXCLUDED]`. The async-free
entry also folds the optimistic and verdict seams it could never use.
