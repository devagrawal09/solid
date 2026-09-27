// todos-local, T0* at load (islands-t0.ts: no reactive runtime).
import { activate } from "./islands-t0";

const t0 = performance.now();
activate(document.getElementById("root")!);
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
