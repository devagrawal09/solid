// Client entry: hydrate the server-rendered sync-blocks app.
import { hydrate } from "@solidjs/web";
import { App } from "../../../../examples/sync-blocks/src/app";

const t0 = performance.now();
hydrate(() => <App />, document.getElementById("root")!);
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
