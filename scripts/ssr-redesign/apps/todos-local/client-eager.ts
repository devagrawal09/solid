// todos-local, compiled islands at load (tier 1 or 2, by the build's binding
// of "@solidjs/signals"; see islands.ts).
import { flush } from "@solidjs/signals";
import { activate } from "./islands";

const t0 = performance.now();
activate(document.getElementById("root")!);
flush();
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
