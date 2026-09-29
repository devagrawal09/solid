/**
 * Tier-1 island kernel (experiment; documentation/plans/island-runtime-tiers.md).
 *
 * A standalone, push-based reactive kernel for compiled islands whose graph
 * the compiler proved synchronous and transition-free: signals, memos,
 * render / user effects (split compute + effect), onCleanup, roots, untrack
 * and flush. No async, transitions, optimistic writes, stores, boundaries,
 * context or error routing.
 *
 * Its observable semantics are the core's (`@solidjs/signals`) for that
 * subset, event for event, because it keeps the core's scheduling
 * mechanics rather than an equivalent-looking design:
 *
 * - writes stage a pending value; untracked reads outside a computation see
 *   the committed value until the flush, reads inside a computation see the
 *   staged one;
 * - a flush drains a height-ordered heap (the same bucket order, `_min`
 *   rewind and read-time pull as core/heap.ts), then commits staged values
 *   and the deferred ("zombie") disposals of re-run owners, then runs the
 *   render-effect queue, then the user-effect queue, and loops while work
 *   was scheduled; flushes are scheduled on a microtask, through the page
 *   (page.ts), so every runtime on the page flushes as one batch;
 * - dependency links are alien-signals style (in-place reuse, so subscriber
 *   order, and therefore heap order, matches the core's);
 * - memos cut off on `===` (or `equals`), effects never do;
 * - render effects run their effect half synchronously on creation, user
 *   effects queue it;
 * - disposal: children newest first, then onCleanup in registration order,
 *   then the effect's returned cleanup.
 *
 * The API names and call shapes are the core's, so compiled activation code
 * binds to either runtime with an import swap (tier 1 <-> tier 2). The
 * differential suite (tests/kernel) runs random graphs through both and
 * compares traces.
 *
 * Deliberate differences (outside the subset, documented): a throw escapes
 * (no status / boundary routing, no reactivity halt); a memo created with no
 * owner is not auto-disposed when unobserved; dev diagnostics are absent.
 */

import { join, page, type Part } from "./page.js";

// --- node shapes ----------------------------------------------------------------
// Short field names keep the minified kernel small (property names are not
// mangled by the bundlers in the harness).
interface Link {
  d: Src; // dependency
  s: Comp; // subscriber
  nd: Link | null; // next dependency of s
  ps: Link | null; // previous subscriber of d
  ns: Link | null; // next subscriber of d
  g: number; // s's dependency pass when linked or reused
}
interface Src {
  v: any; // committed value
  p: any; // staged value or NOT
  e: ((a: any, b: any) => boolean) | false; // equality
  su: Link | null; // subscribers
  st: Link | null; // subscribers tail
  fn?: (prev: any) => any;
}
interface Owner {
  o: Owner | null; // parent
  fc: Owner | null; // first (newest) child
  nx: Owner | null; // next sibling
  pv: Owner | null; // previous sibling
  cl: (() => void)[] | null; // onCleanup callbacks
  f: number; // flags
  r?: 1; // root
  pc?: Comp | null; // root: nearest computed ancestor
}
interface Comp extends Src, Owner {
  fn: (prev: any) => any;
  h: number; // height
  dp: Link | null; // dependencies
  dt: Link | null; // dependencies tail (this pass)
  dg: number; // dependency pass
  hn: Comp | undefined; // heap: next at height
  hp: Comp; // heap: previous at height (head's hp is the tail)
  hq?: Heap; // the heap the node is linked into
  zc: Owner | null; // zombie children (deferred disposal)
  zd: (() => void)[] | null; // zombie cleanups
  t: 0 | 1 | 2; // 0 memo, 1 render effect, 2 user effect
  ef?: (v: any, prev: any) => void | (() => void);
  c?: (() => void) | void; // effect cleanup
  pr?: any; // effect previous value
  m?: boolean; // effect modified
  run?: () => void;
}

const NOT = {};
// The core's bit layout (core/constants.ts): `mark` relies on DIRTY > CHECK.
const CHECK = 1,
  DIRTY = 2,
  RECOMPUTING = 4,
  IN_HEAP = 8,
  IN_HEAP_HEIGHT = 16,
  ZOMBIE = 32,
  DISPOSED = 64,
  MISSED_WAKE = 128;

let context: Owner | null = null;
let tracking = false;
let pending: Src[] = [];
let queues: [(() => void)[], (() => void)[]] = [[], []];
const eq = (a: any, b: any) => a === b;

// --- heaps (core/heap.ts) ---------------------------------------------------------
// `dirty` is the flush heap. `zombie` holds the heap entries of owners whose
// parent is re-running (they are disposed at commit). The core drains it only
// under transitions, so here it is never run, but it is marked and pulled
// through on reads exactly like the core's: a read of a doomed node from
// outside its owner observes that.
interface Heap {
  a: (Comp | undefined)[];
  min: number;
  max: number;
  mk: boolean; // marked
}
const dirty: Heap = { a: [], min: 0, max: 0, mk: false };
const zombie: Heap = { a: [], min: 0, max: 0, mk: false };
const queueFor = (n: Comp) => (n.f & ZOMBIE ? zombie : dirty);

function insertRaw(n: Comp, q: Heap) {
  const p = n.o && (n.o.r ? n.o.pc : (n.o as Comp));
  const ph = p ? p.h : -1;
  if (ph >= n.h) n.h = ph + 1;
  n.hq = q;
  const at = q.a[n.h];
  if (at === undefined) q.a[n.h] = n;
  else {
    const tail = at.hp;
    tail.hn = n;
    n.hp = tail;
    at.hp = n;
  }
  if (n.h > q.max) q.max = n.h;
}
function insert(n: Comp, q: Heap) {
  const f = n.f;
  if (f & (IN_HEAP | RECOMPUTING)) return;
  if (f & CHECK) n.f = (f & ~(CHECK | DIRTY)) | DIRTY | IN_HEAP;
  else {
    n.f = f | IN_HEAP;
    if (q.mk) mark(n, DIRTY);
  }
  if (!(f & IN_HEAP_HEIGHT)) insertRaw(n, q);
}
function insertHeight(n: Comp, q: Heap) {
  const f = n.f;
  if (f & (IN_HEAP | RECOMPUTING | IN_HEAP_HEIGHT)) return;
  n.f = f | IN_HEAP_HEIGHT;
  insertRaw(n, q);
}
/** Unlink from the heap the node is physically in (`hq`), not the one its
 * flags would pick: see updateIfNecessary. */
function remove(n: Comp) {
  const f = n.f;
  if (!(f & (IN_HEAP | IN_HEAP_HEIGHT))) return;
  n.f = f & ~(IN_HEAP | IN_HEAP_HEIGHT);
  const q = n.hq!;
  const h = n.h;
  if (n.hp === n) q.a[h] = undefined;
  else {
    const next = n.hn;
    const head = q.a[h]!;
    const end = next ?? head;
    if (n === head) q.a[h] = next;
    else n.hp.hn = next;
    end.hp = n.hp;
  }
  n.hp = n;
  n.hn = undefined;
}
/** Wake every subscriber (core insertSubs). A subscriber mid-run that already
 * validated this link this pass is latched to run again (missed wake). */
function notify(el: Src) {
  for (let l = el.su; l; l = l.ns) {
    const s = l.s;
    if (s.f & RECOMPUTING && l.g === s.dg && l !== s.dt) s.f |= MISSED_WAKE;
    enqueueSub(s);
  }
}
function enqueueSub(n: Comp) {
  const q = queueFor(n);
  if (q.min > n.h) q.min = n.h;
  insert(n, q);
}
function mark(el: Comp, state: number) {
  const f = el.f;
  if ((f & (CHECK | DIRTY)) >= state) return;
  el.f = (f & ~(CHECK | DIRTY)) | state;
  for (let l = el.su; l; l = l.ns) mark(l.s, CHECK);
}
function markHeap(q: Heap) {
  if (q.mk) return;
  q.mk = true;
  for (let i = 0; i <= q.max; i++)
    for (let el = q.a[i]; el !== undefined; el = el.hn) if (el.f & IN_HEAP) mark(el, DIRTY);
}
function runHeap() {
  const q = dirty;
  q.mk = false;
  for (q.min = 0; q.min <= q.max; q.min++) {
    let el = q.a[q.min];
    while (el !== undefined) {
      if (el.f & IN_HEAP) recompute(el);
      else adjustHeight(el);
      el = q.a[q.min];
    }
  }
  q.max = 0;
}
function adjustHeight(el: Comp) {
  remove(el);
  let h = el.h;
  for (let d = el.dp; d; d = d.nd) if (d.d.fn && (d.d as Comp).h >= h) h = (d.d as Comp).h + 1;
  if (el.h !== h) {
    el.h = h;
    for (let s = el.su; s; s = s.ns) insertHeight(s.s, queueFor(s.s));
  }
}
const heapEmpty = () => dirty.max < dirty.min;

// --- links (core/graph.ts, after alien-signals) --------------------------------
function link(dep: Src, sub: Comp) {
  const prevDep = sub.dt;
  if (prevDep && prevDep.d === dep) return;
  let nextDep: Link | null = null;
  const recomputing = sub.f & RECOMPUTING;
  if (recomputing) {
    nextDep = prevDep ? prevDep.nd : sub.dp;
    if (nextDep && nextDep.d === dep) {
      nextDep.g = sub.dg;
      sub.dt = nextDep;
      return;
    }
  }
  const prevSub = dep.st;
  if (prevSub && prevSub.s === sub && (!recomputing || prevSub.g === sub.dg)) return;
  const l: Link =
    (sub.dt =
    dep.st =
      { d: dep, s: sub, nd: nextDep, ps: prevSub, ns: null, g: sub.dg });
  if (prevDep) prevDep.nd = l;
  else sub.dp = l;
  if (prevSub) prevSub.ns = l;
  else dep.su = l;
}
function unlink(l: Link): Link | null {
  const { d, nd, ns, ps } = l;
  if (ns) ns.ps = ps;
  else d.st = ps;
  if (ps) ps.ns = ns;
  else d.su = ns;
  return nd;
}
function clearDeps(el: Comp) {
  let d = el.dp;
  while (d) d = unlink(d);
  el.dp = el.dt = null;
}

// --- owners ---------------------------------------------------------------------
function adopt(n: Owner) {
  const p = context;
  n.o = p;
  if (p) {
    const first = p.fc;
    if (first) {
      n.nx = first;
      first.pv = n;
    }
    p.fc = n;
  }
}
function markDisposal(el: Owner) {
  for (let c = el.fc as Comp | null; c; c = c.nx as Comp | null) {
    const f = c.f;
    c.f = f | ZOMBIE;
    if (f & (IN_HEAP | IN_HEAP_HEIGHT)) {
      remove(c);
      if (f & IN_HEAP) insert(c, zombie);
      else insertHeight(c, zombie);
    }
    markDisposal(c);
  }
}
function dispose(node: Owner, self: boolean, zombie?: boolean) {
  const f = node.f;
  if (f & DISPOSED) return;
  if (self) node.f = f | DISPOSED;
  let child = zombie ? (node as Comp).zc : node.fc;
  while (child) {
    const next = child.nx;
    if ((child as Comp).fn) {
      remove(child as Comp);
      clearDeps(child as Comp);
    }
    dispose(child, true);
    child = next;
  }
  if (zombie) (node as Comp).zc = null;
  else node.fc = null;
  if (self && !zombie && !(f & ZOMBIE) && node.o && !(node.o.f & DISPOSED)) {
    const { pv, nx } = node;
    if (pv) pv.nx = nx;
    else node.o.fc = nx;
    if (nx) nx.pv = pv;
    node.pv = null;
  }
  const cl = zombie ? (node as Comp).zd : node.cl;
  if (cl) {
    if (zombie) (node as Comp).zd = null;
    else node.cl = null;
    for (let i = 0; i < cl.length; i++) cl[i]();
  }
  if (self && (node as Comp).c) {
    const c = (node as Comp).c!;
    (node as Comp).c = undefined;
    c();
  }
}

// --- computation ------------------------------------------------------------------
function recompute(el: Comp, create?: boolean) {
  if (!create) {
    remove(el);
    if (el.fc || el.cl) {
      markDisposal(el);
      el.zc = el.fc;
      el.zd = el.cl;
      el.fc = el.cl = null;
    }
  }
  const prevContext = context,
    prevTracking = tracking;
  context = el;
  el.dt = null;
  el.dg++;
  el.f = RECOMPUTING;
  const oldHeight = el.h;
  let value = el.p === NOT ? el.v : el.p;
  tracking = true;
  let missed = 0;
  try {
    value = el.fn(value);
  } finally {
    tracking = prevTracking;
    missed = el.f & MISSED_WAKE;
    el.f = 0;
    context = prevContext;
  }
  // trim the links this pass did not reuse
  const tail = el.dt as Link | null;
  let stale = tail ? tail.nd : el.dp;
  if (stale) {
    do stale = unlink(stale);
    while (stale);
    if (tail) tail.nd = null;
    else el.dp = null;
  }
  const changed = create || !el.e || !el.e(el.p === NOT ? el.v : el.p, value);
  if (el.t && changed) {
    el.m = true;
    if (!create) enqueue(el.t, (el.run ??= runEffect.bind(null, el)));
  }
  if (changed) {
    if (create || el.t) el.v = value;
    else el.p = value;
    notify(el);
  } else if (el.h !== oldHeight) for (let s = el.su; s; s = s.ns) insertHeight(s.s, queueFor(s.s));
  if (!create && (el.p !== NOT || el.zc || el.zd)) pending.push(el);
  if (missed) {
    enqueueSub(el);
    schedule();
  }
}
function updateIfNecessary(el: Comp) {
  if (el.f & (RECOMPUTING | DISPOSED)) return;
  if (el.f & CHECK)
    for (let d = el.dp; d; d = d.nd) {
      if (d.d.fn) updateIfNecessary(d.d as Comp);
      if (el.f & DIRTY) break;
    }
  if (el.f & DIRTY) recompute(el);
  // As in the core, this drops ZOMBIE from a doomed node; one still linked
  // into the zombie heap moves to the heap its flags now name (the core's
  // zombie-heap fix, see the doc's defects).
  const f = el.f;
  el.f = f & (IN_HEAP | IN_HEAP_HEIGHT);
  if (f & ZOMBIE && f & (IN_HEAP | IN_HEAP_HEIGHT)) {
    remove(el);
    if (f & IN_HEAP) insert(el, dirty);
    else insertHeight(el, dirty);
  }
}
function runEffect(el: Comp) {
  if (!el.m || el.f & DISPOSED) return;
  const prev = el.c;
  el.c = undefined;
  try {
    prev?.();
    el.c = el.ef!(el.v, el.pr);
  } finally {
    el.pr = el.v;
    el.m = false;
  }
}
function node(fn: (p: any) => any, t: 0 | 1 | 2, e: Src["e"], init?: any): Comp {
  const n = {
    v: init,
    p: NOT,
    e,
    su: null,
    st: null,
    fn,
    h: 0,
    dp: null,
    dt: null,
    dg: 0,
    hn: undefined,
    o: null,
    fc: null,
    nx: null,
    pv: null,
    cl: null,
    zc: null,
    zd: null,
    f: 0,
    t
  } as unknown as Comp;
  n.hp = n;
  adopt(n);
  const p = context && (context.r ? context.pc : (context as Comp));
  if (p) n.h = p.h + 1;
  return n;
}

// --- reads and writes -----------------------------------------------------------------
function read(el: Src): any {
  const c = context && (context.r ? context.pc : (context as Comp));
  if (c && tracking) {
    link(el, c);
    if (el.fn) {
      const n = el as Comp;
      const q = queueFor(n);
      if (n.h >= q.min) {
        mark(c, DIRTY);
        markHeap(q);
        updateIfNecessary(n);
      }
      if (n.h >= c.h && n.o !== c) c.h = n.h + 1;
    }
  }
  return !c || el.p === NOT ? el.v : el.p;
}
function write(el: Src, v: any) {
  const cur = el.p === NOT ? el.v : el.p;
  if (typeof v === "function") v = v(cur);
  if (el.e && el.e(cur, v)) return v;
  if (el.p === NOT) pending.push(el);
  el.p = v;
  notify(el);
  schedule();
  return v;
}

// --- scheduling ---------------------------------------------------------------------
// The flush is the page's (page.ts): one batch with every other runtime on
// the page, phase by phase. A lone kernel runs exactly the loop it always
// did: heap + commit, render effects, user effects, again while scheduled.
// While the heap drains, scheduling is decided after it (as the core's
// `scheduled = heap not empty`): effects it queues run in this round, and an
// extra round would run the heap again, which moves its `min` (observable
// through read-time pulls).
let draining = false;
const part: Part = {
  h() {
    draining = true;
    try {
      runHeap();
      commit();
      if (!heapEmpty()) {
        runHeap();
        commit();
      }
    } finally {
      draining = false;
    }
    if (!heapEmpty()) join(part);
  },
  r: () => runQueue(0),
  u: () => runQueue(1)
};
function schedule() {
  if (!draining) join(part);
}
function enqueue(type: number, fn: () => void) {
  queues[type - 1].push(fn);
  schedule();
}
function commit() {
  const list = pending;
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.p !== NOT) {
      n.v = n.p;
      n.p = NOT;
    }
    if (n.fn && ((n as Comp).zc || (n as Comp).zd)) dispose(n as Comp, false, true);
  }
  list.length = 0;
}
function runQueue(i: 0 | 1) {
  const q = queues[i];
  if (!q.length) return;
  queues[i] = [];
  for (let j = 0; j < q.length; j++) q[j]();
}

// --- public API (the core's names and call shapes) -----------------------------------------
export type Accessor<T> = () => T;
export type Setter<T> = (v: T | ((prev: T) => T)) => T;
type Equals<T> = { equals?: false | ((a: T, b: T) => boolean) };

export function createSignal<T>(value: T, options?: Equals<T>): [Accessor<T>, Setter<T>] {
  const s: Src = { v: value, p: NOT, e: options?.equals ?? eq, su: null, st: null };
  return [read.bind(null, s) as Accessor<T>, write.bind(null, s) as Setter<T>];
}

export function createMemo<T>(fn: (prev: T | undefined) => T, options?: Equals<T>): Accessor<T> {
  const n = node(fn, 0, options?.equals ?? eq);
  recompute(n, true);
  return read.bind(null, n) as Accessor<T>;
}

function effect<T>(compute: (prev: T | undefined) => T, fn: (v: T, prev?: T) => any, t: 1 | 2) {
  const n = node(compute, t, false);
  n.ef = fn;
  recompute(n, true);
  if (t === 2) enqueue(2, (n.run = runEffect.bind(null, n)));
  else runEffect(n);
}
export function createRenderEffect<T>(
  compute: (prev: T | undefined) => T,
  fn: (v: T, prev?: T) => void | (() => void)
): void {
  effect(compute, fn, 1);
}
export function createEffect<T>(
  compute: (prev: T | undefined) => T,
  fn: (v: T, prev?: T) => void | (() => void)
): void {
  effect(compute, fn, 2);
}

export function createRoot<T>(init: (dispose: () => void) => T): T {
  const r: Owner = { o: null, fc: null, nx: null, pv: null, cl: null, f: 0, r: 1 };
  r.pc = context && (context.r ? context.pc : (context as Comp));
  adopt(r);
  return runWithOwner(r, () => init(() => dispose(r, true)));
}

export function runWithOwner<T>(owner: Owner | null, fn: () => T): T {
  const prevContext = context,
    prevTracking = tracking;
  context = owner;
  tracking = false;
  try {
    return fn();
  } finally {
    context = prevContext;
    tracking = prevTracking;
  }
}

export function getOwner(): object | null {
  return context;
}

export function onCleanup<T extends () => void>(fn: T): T {
  if (context) (context.cl ??= []).push(fn);
  return fn;
}

export function untrack<T>(fn: () => T): T {
  if (!tracking) return fn();
  tracking = false;
  try {
    return fn();
  } finally {
    tracking = true;
  }
}

export function flush(): void {
  page.f();
}
