/**
 * The page flush (experiment; documentation/plans/island-runtime-tiers.md,
 * "Cross-runtime flush").
 *
 * One page can run islands on several runtimes (the t0 helper, the kernel,
 * the core). In a single-runtime app one flush updates every island an event
 * touched: all render effects (DOM writes) run before any user effect. So
 * every runtime on the page schedules through one shared object, and one
 * page flush runs every scheduled runtime as one batch, phase by phase:
 *
 *   h: heap + commit (computes), then r: render effects, then u: user effects
 *
 * each phase over the runtimes in the order they first scheduled (the order
 * in which the core's heap would have met their writes, for islands at the
 * same height), looping while any runtime scheduled again.
 *
 * The object lives on `globalThis` under a registered symbol, so separately
 * bundled runtimes share it; whichever loads first creates it (every copy of
 * this module implements the same protocol). A host runtime (the core, see
 * host.ts) can take the page over: `w` wakes it when a runtime schedules,
 * `x` is its flush, and it runs the parts inside its own flush.
 */

/** A runtime's part of the page flush. */
export interface Part {
  h(): void;
  r(): void;
  u(): void;
}

export interface Page {
  /** Parts with scheduled work, in first-schedule order. */
  l: Part[];
  /** 1: a microtask is queued; 2: a flush is running. */
  q?: number;
  /** Host: wake it (a part scheduled). */
  w?: (() => void) | null;
  /** Host: its flush. */
  x?: (() => void) | null;
  /** Flush the page. */
  f(): void;
}

/** Run one round over `l`: every part's computes, render effects, user effects. */
export function round(l: Part[]): void {
  for (const k of "hru") for (const x of l) x[k as "h"]();
}

export const page: Page = ((globalThis as any)[Symbol.for("solid.page")] ||= {
  l: [],
  f() {
    if (page.x) return page.x();
    if (page.q! > 1) return;
    page.q = 2;
    try {
      for (let l; (l = page.l).length; ) {
        page.l = [];
        round(l);
      }
    } finally {
      page.q = 0;
    }
  }
});

/** Schedule a part: list it, and wake the host or queue the page flush. */
export function join(x: Part): void {
  if (page.l.includes(x)) return;
  page.l.push(x);
  if (page.w) page.w();
  else if (!page.q) {
    page.q = 1;
    queueMicrotask(page.f);
  }
}
