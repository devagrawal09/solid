// Tier 0, eager: activate every Toggle island at load with no reactive
// runtime (toggle.t0.ts).
import { activate } from "./toggle.t0";

const t0 = performance.now();
for (const el of document.querySelectorAll<HTMLElement>("[data-i=t]")) activate(el);
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
