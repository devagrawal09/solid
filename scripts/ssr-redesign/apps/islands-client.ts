// Client entry for compiled islands (every app): the generated entry
// (`islandsEntry` in packages/compiler/islands-build.js) — the loader for
// lazy islands and the activation of eager ones.
// @ts-ignore virtual module
import { start } from "virtual:solid-islands";

const t0 = performance.now();
start();
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
