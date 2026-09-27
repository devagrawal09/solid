// P1-rt, client: only the island component ships. Each `<solid-island>` is
// hydrated as its own root with today's runtime; the reply list inside it is
// handed back as the server's own nodes (a pass-through slot), so no Comment
// or Story code is needed.
import { hydrate } from "@solidjs/web";
import Toggle from "../../../../../examples/hackernews-spa/src/components/toggle";

const t0 = performance.now();
for (const el of document.querySelectorAll<HTMLElement>("solid-island")) {
  const ul = el.querySelector(":scope > ul")!;
  const slot = [...ul.childNodes];
  hydrate(() => <Toggle>{slot}</Toggle>, el, { renderId: el.dataset.rid });
}
(globalThis as any).__hydrateMs = performance.now() - t0;
(globalThis as any).__readyAt = performance.now();
