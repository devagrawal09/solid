// Reference (not a strategy): the same page client-rendered from inline JSON
// into an empty root — the work a client render does, for comparison with
// hydration's.
import { render } from "@solidjs/web";
import { Page } from "./story";

(globalThis as any).__loadStory = () => (globalThis as any).__story;
const t0 = performance.now();
render(() => <Page />, document.getElementById("root")!);
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
