// Reference: the same app client-rendered. Used for bundle bytes only
// ("what hydration adds"); its data loads with the mock's 400 ms delay.
import { render } from "@solidjs/web";
import { App } from "../../../../examples/todos-blocks/src/app";

render(() => <App />, document.getElementById("root")!);
(globalThis as any).__readyAt = performance.now();
