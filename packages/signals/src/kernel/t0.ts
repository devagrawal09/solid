/**
 * Tier-0 island support (experiment; documentation/plans/island-runtime-tiers.md).
 *
 * A tier-0 island has no reactive graph at run time: the compiler proved its
 * cells are written only by its own handlers and every view hole reads them
 * unconditionally, so it emits each cell as a plain slot and each hole as a
 * (compute, apply) pair listed on the cells it reads. What is left is the
 * core's batching contract, which is observable and so must be kept:
 *
 * - a write stages the value (an updater sees the staged value; `get` —
 *   what a handler reads — returns the committed one until the flush);
 * - an equal write is a no-op;
 * - the flush runs on a microtask (or on an explicit `flush()`): it commits,
 *   then computes every hole reading a changed cell once, in the order the
 *   core's heap would visit them (cells in first-write order, each cell's
 *   holes in creation order, each hole once), then applies them in that
 *   order (compute phase, then effect phase, as render effects do).
 *
 * Holes are created with their server-rendered value, so activation computes
 * and writes nothing.
 *
 * The flush is the page's (page.ts): a write schedules this helper's part,
 * and one page flush runs it together with every other runtime on the page
 * (commit + compute with the others' computes, apply with their render
 * effects, before any user effect), as the core would in one flush.
 */
import { join, page, type Part } from "./page.js";

const NOT = {};

export interface Cell<T = any> {
  v: T; // committed
  p: T | typeof NOT; // staged
  h: Hole[]; // holes that read this cell, in creation order
}
interface Hole {
  c: () => any;
  a: (v: any, prev: any) => void;
  v: any;
  n?: any; // computed, not yet applied
}

let queue: Cell[] = [];
let run: Hole[] = [];

export function cell<T>(v: T): Cell<T> {
  return { v, p: NOT, h: [] };
}

export function get<T>(c: Cell<T>): T {
  return c.v;
}

export function set<T>(c: Cell<T>, v: T | ((prev: T) => T)): T {
  const cur = (c.p === NOT ? c.v : c.p) as T;
  if (typeof v === "function") v = (v as (prev: T) => T)(cur);
  if (v === cur) return v;
  if (c.p === NOT) queue.push(c);
  c.p = v;
  join(part);
  return v;
}

/** Register a view hole: `compute` reads cells (unconditionally), `apply` writes the DOM. */
export function hole<T>(
  cells: Cell[],
  compute: () => T,
  apply: (v: T, prev: T) => void,
  initial: T
): void {
  const h: Hole = { c: compute, a: apply, v: initial };
  for (const c of cells) c.h.push(h);
}

const part: Part = {
  // commit, then compute every hole reading a changed cell (with the page's computes)
  h() {
    for (const c of queue) {
      c.v = c.p as any;
      c.p = NOT;
      for (const h of c.h) run.includes(h) || run.push(h);
    }
    queue = [];
    for (const h of run) h.n = h.c();
  },
  // then apply them in that order (with the page's render effects)
  r() {
    const r = run;
    run = [];
    for (const h of r) {
      const prev = h.v;
      h.a((h.v = h.n), prev);
    }
  },
  u() {}
};

/** Flush the page: this helper's writes and every other runtime's. */
export function flush(): void {
  page.f();
}
