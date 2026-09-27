// todos-local, today: hydrate the server-rendered app.
import { hydrate } from "@solidjs/web";
import { App } from "./app";

const t0 = performance.now();
hydrate(() => <App />, document.getElementById("root")!);
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
