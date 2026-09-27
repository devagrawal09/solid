---
"@solidjs/signals": patch
---

Add an experimental, unexported tier-1 island kernel (`src/kernel/index.ts`) and tier-0 batch helper (`src/kernel/t0.ts`) for the island runtime tiers study (documentation/plans/island-runtime-tiers.md). Nothing in the package's entry points imports them; the published build is unchanged.
