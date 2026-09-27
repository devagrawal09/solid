// P1-static-eager: activate every island at load (no hydration runtime).
import { flush } from "@solidjs/signals";
import { activate } from "./toggle.island";

const t0 = performance.now();
for (const el of document.querySelectorAll<HTMLElement>("[data-i=t]")) activate(el);
flush();
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
