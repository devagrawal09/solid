/**
 * The core as the page's flush host (experiment; documentation/plans/
 * island-runtime-tiers.md, "Cross-runtime flush").
 *
 * The t0 helper and the kernel flush through the page (page.ts). The core
 * keeps its own scheduler, so on a page that also runs islands on the core,
 * the page is handed to it: `host(core)` builds, with the core's public API
 * only, one signal and two effects that run the page's parts inside the
 * core's flush, at the core's own phase points:
 *
 * - a part schedules: the signal is written (with `equals: false`), so the
 *   core's heap meets the parts where it meets that write, among its own
 *   writes (runtime by runtime, in write order);
 * - the render effect's compute runs every listed part's computes (h), its
 *   effect half their render effects (r), with the core's render effects;
 * - the user effect runs their user effects (u) with the core's user effects;
 * - the page's flush (`t0.flush()`, the kernel's `flush()`, `$flush()` in a
 *   guest island) is the core's `flush()`, which drains everything.
 *
 * The page's entry installs it when a page mixes the core with the lower
 * tiers (packages/compiler/islands-build.js); the core itself is unchanged.
 * Returns an uninstaller (tests).
 */
import { page, type Part } from "./page.js";

export interface HostApi {
  createRoot<T>(fn: (dispose: () => void) => T): T;
  createSignal<T>(v: T, o?: { equals?: false }): [() => T, (v: T) => T];
  createRenderEffect<T>(compute: () => T, effect: (v: T) => void): void;
  createEffect<T>(compute: () => T, effect: (v: T) => void): void;
  flush(): void;
}

export function host(api: HostApi): () => void {
  let live = false,
    busy = false,
    l: Part[] = [];
  const [tick, set] = api.createSignal(0, { equals: false });
  const wake = () => busy || set(0);
  const dispose = api.createRoot(d => {
    api.createRenderEffect(
      () => {
        tick();
        if (!live) return l;
        busy = true;
        l = page.l;
        page.l = [];
        for (const x of l) x.h();
        return l;
      },
      l => {
        for (const x of l) x.r();
      }
    );
    api.createEffect(
      () => (tick(), l),
      l => {
        try {
          for (const x of l) x.u();
        } finally {
          busy = false;
          // Parts that scheduled during this round (their effects wrote):
          // the next round of the same core flush.
          if (page.l.length) set(0);
        }
      }
    );
    return d;
  });
  live = true;
  page.w = wake;
  page.x = api.flush;
  if (page.l.length) wake();
  return () => {
    dispose();
    if (page.w === wake) page.w = page.x = null;
  };
}
