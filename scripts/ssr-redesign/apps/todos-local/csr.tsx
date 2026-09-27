// Reference bundle: todos-local client-rendered (what hydration adds).
import { render } from "@solidjs/web";
import { App } from "./app";

render(() => <App />, document.getElementById("root")!);
(globalThis as any).__readyAt = performance.now();
