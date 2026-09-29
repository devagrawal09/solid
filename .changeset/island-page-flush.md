---
"@solidjs/signals": patch
"@solidjs/compiler": patch
---

Islands: every runtime on a page flushes as one batch. The tier-0 helper (`@solidjs/signals/t0`) and the kernel (`@solidjs/signals/kernel`) schedule through a shared page flush (computes of every runtime, then every render effect, then every user effect, in first-schedule order), so an effect in one island reading another island's DOM after one event sees it updated, as in a single-runtime app; `flush()` / `$flush()` in any island drains the page. New `@solidjs/signals/host` makes the core the page's flush host (built on its public API; the core is unchanged). The islands entry installs it on pages that mix core islands (or hydrated fallback modules) with tier-0 / kernel islands (`virtual:solid-islands/host`, statically when a core island activates at load, else with the first lazy core island's chunk).
