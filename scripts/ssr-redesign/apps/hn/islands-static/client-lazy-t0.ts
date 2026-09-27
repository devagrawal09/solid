// Tier 0, lazy: client-lazy.ts's loader with the tier-0 activation chunk
// (toggle.t0.ts). The first event inside an instance imports the chunk,
// activates that instance and replays the event.
const chunks: Record<string, () => Promise<{ activate(root: HTMLElement): void }>> = {
  t: () => import("./toggle.t0")
};
const active = new WeakSet<Element>();

document.addEventListener(
  "click",
  e => {
    const target = e.target as Element;
    const root = target.closest?.("[data-i]") as HTMLElement | null;
    if (!root || active.has(root)) return;
    active.add(root);
    e.stopPropagation();
    chunks[root.dataset.i!]().then(m => {
      m.activate(root);
      target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  },
  true
);
(globalThis as any).__hydrateMs = 0;
(globalThis as any).__readyAt = performance.now();
