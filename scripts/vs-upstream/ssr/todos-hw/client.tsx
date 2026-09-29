// Client entry: hydrate the server-rendered handwritten todos app (examples/todos).
import { hydrate } from "@solidjs/web";
import { App } from "../../../../examples/todos/src/app";

const t0 = performance.now();
hydrate(() => <App />, document.getElementById("root")!);
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
