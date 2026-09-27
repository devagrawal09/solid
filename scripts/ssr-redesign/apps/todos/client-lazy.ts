// On-interaction hydration (runtime-only; no compiler map): the page loads a
// tiny loader. The first click / input / keydown imports the app chunk and
// hydrates it; the hydration bootstrap (`_$HY.events`) has queued that event
// and runHydrationEvents replays it once its element is claimed. For an app
// whose every component is live (todos), this moves hydration to the first
// interaction rather than removing it.
let started = false;
const start = () => {
  if (started) return;
  started = true;
  import("./hydrate-app");
};
for (const type of ["click", "input", "keydown"]) document.addEventListener(type, start, true);
(globalThis as any).__hydrateMs = 0;
(globalThis as any).__readyAt = performance.now();
