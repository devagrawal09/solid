// P1-static-lazy: the page loads only this loader. The first event inside an
// island instance imports that island's activation chunk, activates the one
// instance, and replays the event, so no interaction is dropped while the
// chunk loads (the Track C failure mode). Later events on the same instance
// go straight to its handler.
const chunks: Record<string, () => Promise<{ activate(root: HTMLElement): void }>> = {
  t: () => import("./toggle.island")
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
