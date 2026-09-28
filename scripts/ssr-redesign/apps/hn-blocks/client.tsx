// Client entry (A on the v2 source): hydrate the whole page.
import { hydrate } from "@solidjs/web";
import { Page } from "./story";

(globalThis as any).__loadStory = () => fetch("/story.json").then(r => r.json());
const t0 = performance.now();
hydrate(() => <Page />, document.getElementById("root")!);
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
