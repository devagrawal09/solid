// Reference bundle: examples/sync-blocks client-rendered (what hydration adds).
import { render } from "@solidjs/web";
import { App } from "../../../../examples/sync-blocks/src/app";

render(() => <App />, document.getElementById("root")!);
(globalThis as any).__readyAt = performance.now();
