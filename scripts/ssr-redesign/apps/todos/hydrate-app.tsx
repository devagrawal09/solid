// The lazily imported chunk of client-lazy.ts: hydrate the whole app.
import { hydrate } from "@solidjs/web";
import { App } from "../../../../examples/todos-blocks/src/app";

const t0 = performance.now();
hydrate(() => <App />, document.getElementById("root")!);
(globalThis as any).__lazyHydrateMs = performance.now() - t0;
