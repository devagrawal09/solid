/*
 * The block runtime: an interpreter for generator blocks on Solid's public API.
 *
 * Nothing here is compiled. Every operation a block delegates to with
 * `yield*` runs inside its own iterator and returns its result without
 * yielding, so `yield* count` is a plain tracked call of `count` in whatever
 * computation is running the block. The only operation that yields to a
 * driver is an async `attempt`: the memo / event runner suspends the
 * generator on its promise and resumes it when the promise settles.
 *
 * Views: after the JSX transform's one block rule (`yield* e` inside JSX
 * becomes `perform(e)`), a view generator has no `yield` left and runs once;
 * each hole is its own computation. A view that still reads at its top level
 * is detected on its first run, re-rendered as a whole from then on, and
 * warned about in development.
 */
import {
  action,
  createMemo,
  createOptimistic,
  createOptimisticStore,
  createProjection,
  refresh as solidRefresh,
  until as solidUntil,
  createRenderEffect,
  createSignal,
  createStore,
  createTrackedEffect,
  getObserver,
  getOwner,
  isPending as solidIsPending,
  latest as solidLatest,
  NotReadyError,
  onCleanup,
  onSettled,
  runWithOwner,
  untrack,
  useContext,
  createContext as solidCreateContext,
  type Accessor,
  type Context,
  type MemoOptions,
  type ProjectionOptions,
  type SignalOptions,
  type Store
} from "solid-js";
import type {
  Handled,
  WaitsOf,
  ReadsPendingOf,
  EventCall,
  Write,
  COMPONENT as COMPONENT_BRAND,
  Block,
  ChildView,
  HView,
  BlockSetter,
  BlockStoreSetter,
  Cleanup,
  Component,
  ContextRead,
  Create,
  EffectOp,
  ErrorClass,
  EventHandler,
  EventOp,
  FailsOf,
  HoleOp,
  MemoOp,
  Path,
  PendingOf,
  PropsOf,
  Raise,
  Read,
  Receipt as ReceiptType,
  SetupOp,
  Snapshot,
  Source,
  TypedStore,
  ViewFails,
  ViewOp,
  ViewPending,
  Wait,
  Yieldable
} from "./types.js";

declare const __DEV__: boolean;
declare const __SERVER__: boolean;

// --- runtime marks -----------------------------------------------------------------

/** The read a readable performs: `x[READ]()` (or `PATH` for a path reader). */
export const READ: unique symbol = Symbol.for("solid.blocks.read") as any;
/** Marks a component's view value (so `perform` returns it unread). */
export const VIEW_MARK: unique symbol = Symbol.for("solid.blocks.view") as any;
/** Marks `$component` functions. */
export const COMPONENT_MARK: unique symbol = Symbol.for("solid.blocks.component") as any;
/** Marks `$` blocks; holds the generator body. */
export const BODY: unique symbol = Symbol.for("solid.blocks.body") as any;
/** Marks row blocks built explicitly (`$scope`, `$(function* (item) …)`). */
export const ROW_MARK: unique symbol = Symbol.for("solid.blocks.row") as any;
const OP: unique symbol = Symbol.for("solid.blocks.op") as any;
const PATH_TARGET: unique symbol = Symbol.for("solid.blocks.path") as any;
const PATH_READ = 1;

// --- one runtime per app -------------------------------------------------------------

/**
 * @internal Where this copy of the runtime registers itself in development:
 * one key per build (a server render and a client hydrating in one test
 * process are two runtimes by design).
 */
export const INSTANCE: unique symbol = Symbol.for(
  __SERVER__ ? "solid.blocks.instance.server" : "solid.blocks.instance.client"
) as any;

/**
 * @internal Dev only: a second copy of the runtime (a duplicated dependency,
 * a bundle that inlined the package next to an external one) is an error.
 * The marks are `Symbol.for` keys, so two copies half-work together — each
 * keeps its own host state, and a block driven by one copy fails the other's
 * checks with misleading errors. The same module evaluated again (a re-import
 * at the same URL) replaces its registration.
 */
export function registerInstance(url: string | undefined): void {
  const g = globalThis as any;
  const prev: { url: string | undefined } | undefined = g[INSTANCE];
  if (prev && (prev.url === undefined || url === undefined || prev.url !== url))
    throw devError(
      "DUPLICATE_RUNTIME",
      `two copies of @solidjs/blocks are loaded: ${prev.url ?? "(unknown URL)"} and ${url ?? "(unknown URL)"}. ` +
        "An app holds one runtime: dedupe the dependency (one version, one install), and keep the package external in bundles."
    );
  g[INSTANCE] = { url };
}
if (__DEV__) registerInstance(import.meta.url);

// --- hosts ---------------------------------------------------------------------------

const NONE = 0;
const SETUP = 1;
const VIEW = 2;
const MEMO = 3;
const EFFECT = 4;
const EVENT = 5;
const HOLE = 6;
type Host = 0 | 1 | 2 | 3 | 4 | 5 | 6;
const HOST_NAMES = [
  "plain code",
  "a setup",
  "a view",
  "a memo",
  "an effect",
  "an event",
  "a hole block"
];

let host: Host = NONE;
/** Set while a view's first run is at its top level (not in a hole, not in a child's setup). */
let viewRunning = false;
/**
 * Thrown by a read at a view's top level during its first run: the run is
 * abandoned before the read happens, and the view re-renders as a whole in
 * a memo from then on. Aborting (rather than reading untracked and then
 * subscribing) matters for async: an untracked read of a pending source
 * would register the computation that created the component (a `Loading`'s
 * content, a thunk render) as waiting on it, and that computation would
 * re-run — re-creating the component — when the source resolves.
 */
const WHOLE_VIEW = { wholeView: true };
/** Set while a read from a JSX position (`perform`) is in progress, paths and getters included. */
let jsxRead = false;
/** Cleanups of the running effect run (null outside an effect). */
let cleanupSink: (() => void)[] | null = null;
/** Set while a memo runs after its first async `attempt`. */
let memoResumed = false;

function devError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

function checkRead(inJsx: boolean): void {
  // A setup runs untracked. A tracked read while the host is a setup belongs
  // to a plain Solid computation the setup created (a `dynamic`, a derived
  // store) running its first pass: that read is the computation's own. A
  // read from a JSX position is never the setup's (see `perform`).
  if (!inJsx && host === SETUP && getObserver() === null)
    throw devError(
      "READ_IN_SETUP",
      "a setup creates; it does not read. Read in the view, a $memo or an $effect (or take a value with $snapshot)."
    );
  if (memoResumed)
    throw devError(
      "READ_AFTER_ATTEMPT",
      "a $memo reads before its first async attempt: a read after it would not be tracked."
    );
}

// --- reading ------------------------------------------------------------------------

/**
 * Perform the read a readable stands for (tracked in the running computation).
 * `jsxRead`: the read comes from a JSX position (`perform`, which the transform
 * writes for a `yield*` inside JSX) — a hole, or a prop getter that whoever
 * receives the prop reads. It is never the running view's or setup's own
 * top-level read, even when it happens while one is on the stack: plain
 * Solid code may read a prop getter untracked right then (a `<Reveal>`
 * registering a nested `<Loading>` reads its `order` while the nested
 * card's view is being built), and that read must not turn the card's view
 * into a whole-view re-render or fail as a setup read.
 */
function readOf(x: any): unknown {
  if (__DEV__) checkRead(jsxRead);
  if (!jsxRead && viewRunning && host === VIEW && getObserver() === null) throw WHOLE_VIEW;
  const r = x[READ];
  return r === PATH_READ ? readPath(x[PATH_TARGET]) : r.call(x);
}

/** A value read through: a readable's value, else the value itself. */
export function through(v: any): any {
  return v != null && v[READ] !== undefined ? readOf(v) : v;
}

function* sourceIterator(this: any): Generator<unknown, unknown, unknown> {
  return host === EVENT ? yield* eventRead(this) : readOf(this);
}

/**
 * A read in an event: an event takes current values, and when the source has
 * none yet (pending) the event waits until it can be read — the reading event's
 * `P` color.
 */
function* eventRead(x: any): Generator<unknown, unknown, unknown> {
  try {
    return readOf(x);
  } catch (e) {
    if (!(e instanceof NotReadyError)) throw e;
    // The value comes from the wait itself: when the source's first value
    // lands inside this event's own transaction, a second (untracked) read
    // here could not see it until the transaction commits — after the event.
    const box = (yield new Wait_(solidUntil(() => ({ value: readOf(x) })))) as { value: unknown };
    return box.value;
  }
}

/** Turn an accessor this library created into a source (iterable, readable). */
function asSource<T>(get: Accessor<T>): Source<T, any, any> {
  (get as any)[READ] = get;
  (get as any)[Symbol.iterator] = sourceIterator;
  return get as any;
}

/**
 * `yield* latestOf(results)`: the latest value of a source — while a newer
 * one is pending, the previous one (Solid's `latest`: stale while
 * revalidating). Pending only until a first value exists.
 */
export function latestOf<T, P extends boolean, E>(source: Source<T, P, E>): Source<T, P, E> {
  const get = accessor(source);
  return asSource(() => solidLatest(get)) as any;
}

/**
 * `yield* isPendingOf(results)`: whether a source has a newer value in
 * flight (Solid's `isPending`). Never pending itself.
 */
export function isPendingOf(
  source: Source<unknown, boolean, unknown>
): Source<boolean, false, never> {
  const get = accessor(source);
  return asSource(() => solidIsPending(get)) as any;
}

/**
 * @internal A plain accessor for a source, for the library's own hand-offs to
 * Solid (holes, `latestOf`, `until`). Not exported: block code reads with `yield*`.
 */
export function accessor<T>(source: Source<T, boolean, any>): Accessor<T> {
  return typeof source === "function" ? (source as any) : () => readOf(source) as T;
}

/**
 * The call form of `yield*` in a view hole: the JSX transform turns
 * `{(yield* user).name}` into `{perform(user).name}`, so the read happens in
 * the hole's own computation. Also reads a foreign accessor.
 */
export function perform<T>(target: Yieldable<any, T> | (() => T) | T): T {
  const x = target as any;
  if (x != null) {
    if (x[READ] !== undefined) {
      const prev = jsxRead;
      jsxRead = true;
      try {
        return readOf(x) as T;
      } finally {
        jsxRead = prev;
      }
    }
    if (x[VIEW_MARK] === true) return x;
    if (typeof x === "function") return x();
    if (typeof x === "object" && !Array.isArray(x) && typeof x[Symbol.iterator] === "function")
      return drive(x[Symbol.iterator](), HOLE_RUN) as T;
  }
  return x;
}

// --- paths (props, stores) -------------------------------------------------------------

interface PathTarget {
  root: any;
  getter: boolean;
  path: PropertyKey[];
}
const pathHandler: ProxyHandler<PathTarget> = {
  get(t, key) {
    if (key === READ) return PATH_READ;
    if (key === PATH_TARGET) return t;
    if (key === Symbol.iterator) return sourceIterator;
    if (typeof key === "symbol" || key === "then") return undefined;
    return makePath(t.root, t.getter, t.path.length ? [...t.path, key] : [key]);
  },
  has(t, key) {
    return key === READ || key === Symbol.iterator;
  },
  set() {
    throw devError("PATH_WRITE", "a path reads; write through the setter.");
  }
};
function makePath(root: any, getter: boolean, path: PropertyKey[]): any {
  return new Proxy({ root, getter, path } as PathTarget, pathHandler);
}
function readPath(t: PathTarget): unknown {
  let v = t.getter ? t.root() : t.root;
  const path = t.path;
  for (let i = 0; i < path.length; i++) {
    v = through(v);
    if (v == null) return undefined;
    v = v[path[i] as any];
  }
  return through(v);
}

/** Props as reads: `props.x` is a path reader over the raw props. */
function typedProps(raw: any): any {
  return new Proxy(raw, {
    get(target, key) {
      if (typeof key === "symbol") return target[key];
      return makePath(target, false, [key]);
    }
  });
}

/** A reader over a render argument (a row's item, a branch's value). */
export function rowArg(value: unknown, isAccessor: boolean): any {
  return makePath(value, isAccessor, []);
}

class Selection {
  constructor(
    readonly store: any,
    readonly select: (state: any) => unknown
  ) {}
  [READ](): unknown {
    const s = this.store;
    return this.select(s != null && s[PATH_TARGET] ? readPath(s[PATH_TARGET]) : s);
  }
  *[Symbol.iterator](): Generator<unknown, unknown, unknown> {
    return host === EVENT ? yield* eventRead(this) : readOf(this);
  }
}
/**
 * `yield* readStore(todos, t => t.filter(x => x.completed).length)`: one
 * tracked read of whatever the selector touches (a structural read that is
 * not one path).
 */
export function readStore<T, P extends boolean, E, R>(
  store: Source<T, P, E>,
  select: (state: T) => R
): Source<R, P, E>;
export function readStore(store: unknown, select: (state: any) => unknown): unknown {
  return new Selection(store, select);
}

// --- driving ----------------------------------------------------------------------------

const HOLE_RUN = 0;
const SYNC_RUN = 1;
interface WaitOp {
  readonly [OP]: "wait";
  readonly promise: PromiseLike<unknown>;
}
function isWait(op: any): op is WaitOp {
  return op != null && op[OP] === "wait";
}

/** Run a generator that must not suspend. */
function drive(it: Iterator<unknown>, _mode: number): unknown {
  const r = it.next();
  if (r.done) return r.value;
  if (typeof it.return === "function") it.return(undefined);
  throw isWait(r.value)
    ? devError(
        "ASYNC_NOT_ALLOWED",
        `an async attempt suspends; only a $memo or an $event may wait (this is ${HOST_NAMES[host]}).`
      )
    : devError(
        "NOT_AN_OPERATION",
        "a block delegated to something that is not a block operation (`yield*` a source, a store path, a prop, attempt, raise or a setter receipt)."
      );
}

function runAs<T>(h: Host, run: () => T): T {
  const prev = host;
  host = h;
  try {
    return run();
  } finally {
    host = prev;
  }
}

// --- operations ------------------------------------------------------------------------

class Wait_ implements WaitOp {
  readonly [OP] = "wait" as const;
  constructor(readonly promise: PromiseLike<unknown>) {}
}
function isThenable(v: any): v is PromiseLike<unknown> {
  return v != null && typeof v.then === "function";
}

class Attempt {
  constructor(
    readonly run: () => unknown,
    readonly onError: (error: unknown) => unknown
  ) {}
  *[Symbol.iterator](): Generator<unknown, unknown, unknown> {
    let v: unknown;
    try {
      v = this.run();
    } catch (e) {
      if (e instanceof NotReadyError) throw e;
      throw this.onError(e);
    }
    if (isThenable(v)) {
      try {
        v = yield new Wait_(v);
      } catch (e) {
        throw this.onError(e);
      }
    }
    // a stream (or a promise's stream) is not waited for: its failures go
    // through the handler as they come
    return mapStream(v, this.onError);
  }
}
type AttemptOps<T, E> = (T extends PromiseLike<any> ? Wait : never) | Raise<E>;
/** What an attempt gives: a promise's value; a stream as itself, handled. */
type Attempted<T> = Awaited<T> extends AsyncIterable<any> ? Awaited<T> & Handled : Awaited<T>;
/**
 * `yield* attempt(fn, onError)`: call `fn`; when it throws, or the promise it
 * returns rejects, `onError` turns what it caught into the error object the
 * block fails with — the failure's type is its color. An attempt always
 * handles its error: one without a handler would be just a call. When `fn`
 * returns a promise the block suspends until it settles ($memo and $event
 * only) and resumes with its value. When it returns a stream (or a promise of
 * one) the attempt gives the stream back, its failures going through
 * `onError` as they come: `return yield* attempt(() => watch(feed), cause =>
 * new FeedError(cause))` is how a memo's body returns a stream.
 */
export function attempt<T, E extends Error>(
  fn: () => T,
  onError: (error: unknown) => E
): Yieldable<AttemptOps<T, E>, Attempted<T>> {
  return new Attempt(fn, onError) as any;
}

class RaiseOp {
  constructor(readonly error: unknown) {}
  *[Symbol.iterator](): Generator<never, never, unknown> {
    throw this.error;
  }
}
/** `yield* raise(error)`: the typed replacement for `throw` in a block. */
export function raise<E>(error: E): Yieldable<Raise<E>, never> {
  return new RaiseOp(error) as any;
}

/**
 * A write. Calling a setter does nothing by itself: it returns this receipt,
 * and the write happens when the receipt is delegated to (`yield* setX(v)`),
 * so every write is in the block's type (a `Write` op) and only the hosts
 * that may write accept it. A setter call that is not delegated is a lint
 * error (`no-unyielded-write`).
 */
class Receipt<T> {
  constructor(readonly write: () => T) {}
  *[Symbol.iterator](): Generator<never, T, unknown> {
    if (__DEV__) checkWrite();
    return this.write();
  }
}
function checkWrite(): void {
  if (host === SETUP || host === VIEW || host === MEMO || host === HOLE)
    throw devError(
      "WRITE_IN_REACTIVE",
      `${HOST_NAMES[host]} does not write: write in an $event or an $effect.`
    );
}
function receiptSetter(set: (v: any) => any, value?: () => any): any {
  return (v: any) =>
    new Receipt(() => {
      const r = set(v);
      return value ? value() : r;
    });
}

function checkCreate(kind: string): void {
  if (host !== SETUP)
    throw devError(
      "CREATE_OUTSIDE_SETUP",
      `$${kind} creates state: call it in a $component's (or a row block's) setup, not in ${HOST_NAMES[host]}.`
    );
}

/** @internal shared with the entries that create (`$dynamic`). */
export class CreateOp<T> {
  constructor(
    readonly kind: string,
    readonly make: () => T
  ) {}
  *[Symbol.iterator](): Generator<never, T, unknown> {
    if (__DEV__) checkCreate(this.kind);
    return this.make();
  }
}

/** `const [count, setCount] = yield* $signal(0)` in a setup. */
export function $signal<T>(
  value: T,
  options?: SignalOptions<T>
): Yieldable<Create<"signal">, [Source<T, false, never>, BlockSetter<T>]> {
  return new CreateOp("signal", () => {
    const [get, set] = createSignal(value as any, options as any);
    return [asSource(get as Accessor<T>), receiptSetter(set as any)];
  }) as any;
}

/** `const [todos, setTodos] = yield* $store({ … })` in a setup. */
export function $store<T extends object>(
  value: T
): Yieldable<Create<"store">, [TypedStore<T>, BlockStoreSetter<T>]> {
  return new CreateOp("store", () => {
    const [store, set] = createStore(value as any);
    return [makePath(store, false, []), receiptSetter(set as any, () => store)];
  }) as any;
}

/**
 * `const [sending, setSending] = yield* $optimistic(false)` in a setup: a
 * signal whose writes inside an `$event` show at once and revert when the
 * event's transaction settles (Solid's `createOptimistic`).
 */
export function $optimistic<T>(
  value: Exclude<T, Function>,
  options?: SignalOptions<T>
): Yieldable<Create<"optimistic">, [Source<T, false, never>, BlockSetter<T>]> {
  return new CreateOp("optimistic", () => {
    const [get, set] = createOptimistic(value as any, options as any);
    return [asSource(get as Accessor<T>), receiptSetter(set as any)];
  }) as any;
}

/** A derived store's paths: pending and failing as its body is. */
type ProjectionStore<T, Y, R, E = never> = Path<T, MemoPending<Y, R>, FailsOf<Y> | E>;
/** With `seedLoadingValue: true` the seed is commit #0: the store is never pending. */
type SeededStore<T, Y, E = never> = Path<T, false, FailsOf<Y> | E>;

/**
 * `const [todos, setTodos] = yield* $optimisticStore(function* () { … }, [])`
 * in a setup: a store whose writes inside an `$event` show at once and revert
 * when the event settles (Solid's `createOptimisticStore`). With a body the
 * store is derived: the body reads with `yield*`, may wait on an async
 * `attempt` or return a stream through `attempt` (the store is then pending),
 * and may update the draft it is handed.
 */
export function $optimisticStore<T extends object>(
  value: T
): Yieldable<Create<"optimisticStore">, [TypedStore<T>, BlockStoreSetter<T>]>;
export function $optimisticStore<T extends object, Y extends MemoOp = never, R = unknown>(
  body: (draft: T) => Generator<Y, SyncReturn<R>, any>,
  seed: Partial<T>,
  options: ProjectionOptions & { seedLoadingValue: true }
): Yieldable<Create<"optimisticStore">, [SeededStore<T, Y>, BlockStoreSetter<T>]>;
export function $optimisticStore<T extends object, Y extends MemoOp = never, R = unknown>(
  body: (draft: T) => Generator<Y, SyncReturn<R>, any>,
  seed: Partial<T>,
  options?: ProjectionOptions
): Yieldable<Create<"optimisticStore">, [ProjectionStore<T, Y, R>, BlockStoreSetter<T>]>;
export function $optimisticStore(first: any, seed?: any, options?: any): any {
  return new CreateOp("optimisticStore", () => {
    const [store, set] =
      typeof first === "function"
        ? createOptimisticStore(memoCompute(first) as any, seed, options)
        : createOptimisticStore(first);
    return [makePath(store, false, []), receiptSetter(set as any, () => store)];
  });
}

/**
 * `const feed = yield* $projection(function* (draft) { … }, seed)` in a setup:
 * a derived store (Solid's `createProjection`). The body reads with `yield*`,
 * may wait, and updates the draft or returns the next value (a stream through
 * `attempt`).
 */
export function $projection<T extends object, Y extends MemoOp = never, R = unknown>(
  body: (draft: T) => Generator<Y, SyncReturn<R>, any>,
  seed: Partial<T>,
  options: ProjectionOptions & { seedLoadingValue: true }
): Yieldable<Create<"projection">, SeededStore<T, Y>>;
export function $projection<T extends object, Y extends MemoOp = never, R = unknown>(
  body: (draft: T) => Generator<Y, SyncReturn<R>, any>,
  seed: Partial<T>,
  options?: ProjectionOptions
): Yieldable<Create<"projection">, ProjectionStore<T, Y, R>>;
export function $projection(body: any, seed: any, options?: any): any {
  return new CreateOp("projection", () =>
    makePath(createProjection(memoCompute(body) as any, seed, options), false, [])
  );
}

class RefreshOp {
  constructor(readonly target: unknown) {}
  *[Symbol.iterator](): Generator<never, void, unknown> {
    if (__DEV__) checkWrite();
    const t = this.target as any;
    const pt = t != null ? t[PATH_TARGET] : undefined;
    void solidRefresh(pt ? pt.root : t);
  }
}
/**
 * `yield* refresh(todos)`: recompute a derived store or a memo (Solid's
 * `refresh`). It is a write: an `$event` or an `$effect` refreshes.
 */
export function refresh(
  target: Source<unknown, boolean, unknown> | Path<any, boolean, unknown>
): Yieldable<Write, void> {
  return new RefreshOp(target) as any;
}

/**
 * `yield* until(readStore(store, s => s.ready), onError, { timeout })`: wait
 * until a source reads truthy (Solid's `until`). It is an async `attempt`:
 * only a `$memo` or an `$event` waits, and `onError` turns a failure (a
 * timeout) into the block's error.
 */
export function until<T, E extends Error>(
  source: Source<T, boolean, unknown>,
  onError: (error: unknown) => E,
  options?: Parameters<typeof solidUntil>[1]
): Yieldable<Wait | Raise<E>, T> {
  return attempt(() => solidUntil(accessor(source), options), onError) as any;
}

/** A memo's value: a promise's, an async iterable's latest — or a promise of an iterable's (Solid flattens one level). */
type MemoValue<R> = R extends PromiseLike<infer U> ? IteratedValue<U> : IteratedValue<R>;
type IteratedValue<R> = R extends AsyncIterable<infer U> ? U : R;
type MemoPending<Y, R> =
  PendingOf<Y> extends true ? true : R extends PromiseLike<any> | AsyncIterable<any> ? true : false;
/** A body's result that is a promise or a stream no `attempt` handled. */
type UnhandledAsync<R> = Exclude<Extract<R, PromiseLike<any> | AsyncIterable<any>>, Handled>;
/** A body returns a promise or a stream through `attempt`, whose handler types its failure. */
type NeedsAttempt = {
  readonly "a body that returns a promise or a stream wraps it: return yield* attempt(() => it, onError)": never;
};
/** @internal A body's return: anything but a promise or a stream no `attempt` handled. */
export type SyncReturn<R> = R & ([UnhandledAsync<R>] extends [never] ? unknown : NeedsAttempt);

/**
 * `$memo(body, { loadingValue })`: commit #0 is the loading value, so a read
 * never suspends — the memo is not pending (`isPendingOf` still reports a
 * newer value in flight). Its failures are the body's.
 */
export function $memo<Y extends MemoOp = never, R = unknown>(
  body: () => Generator<Y, SyncReturn<R>, any>,
  options: MemoOptions<MemoValue<R>> & { loadingValue: MemoValue<R> }
): Yieldable<Create<"memo">, Source<MemoValue<R>, false, FailsOf<Y>>>;
/**
 * `const doubled = yield* $memo(function* () { return (yield* n) * 2 })` in a setup.
 * A body over a promise or a stream returns it through `attempt`: `return
 * yield* attempt(() => watch(feed), cause => new FeedError(cause))`.
 */
export function $memo<Y extends MemoOp = never, R = unknown>(
  body: () => Generator<Y, SyncReturn<R>, any>,
  options?: MemoOptions<MemoValue<R>>
): Yieldable<Create<"memo">, Source<MemoValue<R>, MemoPending<Y, R>, FailsOf<Y>>>;
export function $memo(body: () => Generator<any, any, any>, options?: any): any {
  return new CreateOp("memo", () => memoOf(body, options));
}

/**
 * A stream whose failures go through an attempt's handler: a Proxy that keeps
 * the stream's own properties (a server function's brand, a live source's
 * `onstatus`) and changes only how it fails.
 */
function mapStream(value: unknown, onError: (error: unknown) => unknown): unknown {
  if (value == null || (typeof value !== "object" && typeof value !== "function")) return value;
  if (typeof (value as any)[Symbol.asyncIterator] !== "function") return value;
  return new Proxy(value as any, {
    get(target, key) {
      if (key === Symbol.asyncIterator)
        return () => {
          const it = target[Symbol.asyncIterator]();
          return {
            next: (v?: unknown) =>
              it.next(v).then(undefined, (e: unknown) => {
                throw onError(e);
              }),
            return: it.return && ((v?: unknown) => it.return(v)),
            throw: it.throw && ((v?: unknown) => it.throw(v)),
            [Symbol.asyncIterator]() {
              return this;
            }
          };
        };
      return Reflect.get(target, key);
    },
    set(target, key, v) {
      return Reflect.set(target, key, v);
    }
  });
}

/**
 * A computation's function for a memo-like body: each run drives the body as
 * the MEMO host (reads, an async `attempt` that suspends, `raise`), and a
 * superseded run is closed instead of resumed. The argument (a projection's
 * draft) is handed to the body.
 */
export function memoCompute(
  body: (arg?: any) => Generator<unknown, unknown, unknown>
): (arg?: unknown) => unknown {
  let run = 0;
  return (arg?: unknown) => {
    const my = ++run;
    let gen!: Generator<unknown, unknown, unknown>;
    let r!: IteratorResult<unknown, unknown>;
    const prev = host;
    host = MEMO;
    try {
      gen = body(arg);
      r = gen.next();
    } finally {
      host = prev;
    }
    if (r.done) return r.value;
    return resume(gen, r.value, MEMO, () => my === run);
  };
}

function memoOf(body: () => Generator<unknown, unknown, unknown>, options?: any): any {
  return asSource(createMemo(memoCompute(body) as any, options) as Accessor<unknown>);
}

/**
 * Continue a generator that yielded an async `attempt`: wait for its
 * promise, resume, and settle with the generator's result. A superseded run
 * is closed instead of resumed.
 */
function resume(
  gen: Generator<unknown, unknown, unknown>,
  op: unknown,
  as: Host,
  current: () => boolean
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const step = (value: unknown, failed: boolean) => {
      if (!current()) {
        try {
          gen.return(undefined);
        } catch {}
        return;
      }
      let r: IteratorResult<unknown, unknown>;
      const prev = host;
      host = as;
      if (as === MEMO) memoResumed = true;
      try {
        r = failed ? gen.throw(value) : gen.next(value);
      } catch (e) {
        reject(e);
        return;
      } finally {
        host = prev;
        memoResumed = false;
      }
      if (r.done) resolve(r.value);
      else wait(r.value);
    };
    const wait = (next: unknown) => {
      if (!isWait(next)) {
        reject(drive({ next: () => ({ done: false, value: next }) } as any, SYNC_RUN));
        return;
      }
      Promise.resolve(next.promise).then(
        v => step(v, false),
        e => step(e, true)
      );
    };
    wait(op);
  });
}

/**
 * `yield* $effect(function* () {…})` in a setup: reads (tracked), writes,
 * `$cleanup`s. Uncompiled it runs as one tracked pass
 * (`createTrackedEffect`); its writes are queued until the flush.
 */
export function $effect<Y extends EffectOp = never>(
  body: () => Generator<Y, void, any>,
  options?: { name?: string }
): Yieldable<Create<"effect">, void> {
  return new CreateOp("effect", () => {
    createTrackedEffect(() => runEffect(body), options as any);
  }) as any;
}

function runEffect(body: () => Generator<unknown, unknown, unknown>): (() => void) | undefined {
  const sink: (() => void)[] = [];
  const prevSink = cleanupSink;
  const prev = host;
  cleanupSink = sink;
  host = EFFECT;
  try {
    drive(body(), SYNC_RUN);
  } finally {
    cleanupSink = prevSink;
    host = prev;
  }
  return sink.length ? () => runCleanups(sink) : undefined;
}
function runCleanups(sink: (() => void)[]): void {
  for (let i = sink.length - 1; i >= 0; i--) sink[i]();
}

/**
 * `yield* $settled(function* () {…})` in a setup: runs once, after the graph
 * settles (`onSettled`). Reads are current values; `$cleanup`s run when the
 * owner is disposed.
 */
export function $settled<Y extends EffectOp = never>(
  body: () => Generator<Y, void, any>
): Yieldable<Create<"settled">, void> {
  return new CreateOp("settled", () => {
    onSettled(() => untrack(() => runEffect(body)));
  }) as any;
}

class CleanupOp {
  constructor(readonly fn: () => void) {}
  *[Symbol.iterator](): Generator<never, void, unknown> {
    if (cleanupSink) cleanupSink.push(this.fn);
    else if (__DEV__ && host !== SETUP)
      throw devError(
        "CLEANUP_OUTSIDE_OWNER",
        `$cleanup belongs to a setup or an effect, not ${HOST_NAMES[host]}.`
      );
    else onCleanup(this.fn);
  }
}
/** `yield* $cleanup(fn)`: run `fn` when the component (or the effect run) is disposed. */
export function $cleanup(fn: () => void): Yieldable<Cleanup, void> {
  return new CleanupOp(fn) as any;
}

class SnapshotOp {
  constructor(readonly target: unknown) {}
  *[Symbol.iterator](): Generator<never, unknown, unknown> {
    const prev = host;
    host = NONE;
    try {
      return untrack(() => through(this.target));
    } finally {
      host = prev;
    }
  }
}
/**
 * `yield* $snapshot(props.mode)` in a setup: the current value, untracked —
 * for structure chosen once at creation. Its pending / failures are the
 * component's.
 */
export function $snapshot<T, P extends boolean, E>(
  source: Source<T, P, E>
): Yieldable<Snapshot<P, E>, T> {
  return new SnapshotOp(source) as any;
}

// --- context ------------------------------------------------------------------------------

function* contextIterator(this: Context<unknown>): Generator<never, unknown, unknown> {
  if (__DEV__ && host !== SETUP && host !== NONE)
    throw devError(
      "CONTEXT_OUTSIDE_SETUP",
      `yield* Ctx belongs to a setup, not ${HOST_NAMES[host]}.`
    );
  return useContext(this);
}
/** A context `yield*` can read in a setup: `const todos = yield* TodosContext`. */
export type BlockContext<T> = Context<T> & Yieldable<ContextRead, T>;
/** `createContext` whose contexts are readable with `yield*` in a setup. */
export function createContext<T>(defaultValue?: T, options?: { name?: string }): BlockContext<T> {
  const ctx = solidCreateContext<T>(defaultValue as T, options as any) as any;
  ctx[Symbol.iterator] = contextIterator;
  return ctx;
}
/** `yield* context(Ctx)`: read a context this library did not create. */
export function context<T>(ctx: Context<T>): Yieldable<ContextRead, T> {
  return { [Symbol.iterator]: () => contextIterator.call(ctx as any) } as any;
}

// --- events ---------------------------------------------------------------------------------

/** Provided by `Errored` so an `$event` knows a boundary will take its failure. */
export const BOUNDARY = solidCreateContext<boolean>(false);

function reportError(owner: ReturnType<typeof getOwner>, error: unknown): void {
  let delivered = false;
  runWithOwner(owner, () => {
    createRenderEffect(
      () => {
        if (!delivered) {
          delivered = true;
          throw error;
        }
      },
      () => {}
    );
  });
}

/**
 * Adapts an `$event` body to Solid's `action` driver: each step of the body
 * runs as the EVENT host, and an async `attempt` (a Wait) is handed to the
 * action as the promise it yields, so the action re-enters its transaction
 * before the body continues. A rejection comes back from the action's
 * `yield` and is thrown into the body at the `yield*`.
 */
function* eventSteps(
  gen: Generator<unknown, unknown, unknown>
): Generator<PromiseLike<unknown>, unknown, unknown> {
  let value: unknown;
  let failed = false;
  for (;;) {
    let r: IteratorResult<unknown, unknown>;
    const prev = host;
    host = EVENT;
    try {
      r = failed ? gen.throw(value) : gen.next(value);
    } finally {
      host = prev;
    }
    if (r.done) return r.value;
    const op = r.value;
    if (!isWait(op)) {
      try {
        gen.return(undefined);
      } catch {}
      return drive({ next: () => ({ done: false, value: op }) } as any, SYNC_RUN);
    }
    try {
      value = yield op.promise;
      failed = false;
    } catch (e) {
      value = e;
      failed = true;
    }
  }
}

/**
 * `$event(function* (e) {…})`: an event handler that is a Solid `action`.
 * Every call is one transaction: writes are held until it settles (an
 * optimistic source shows its value at once), an async `attempt` suspends it
 * and re-enters the transaction when the promise settles, and a rejection is
 * thrown at the `yield*`. It takes any arguments and returns a promise of the
 * body's result, so it replaces `action` in block code.
 *
 * A failure goes to whoever handles the returned promise (`await`, `.then`,
 * `.catch`). One nobody handles — a DOM dispatch ignores the result — goes to
 * the nearest `Errored` above where the handler was created (the promise then
 * resolves `undefined`); with no boundary either, the promise rejects.
 * Like any action it is called from an event or other imperative code, not
 * synchronously inside a computation (ACTION_CALLED_IN_OWNED_SCOPE).
 */
export function $event<Args extends unknown[] = [], Y extends EventOp = never, R = void>(
  body: (...args: Args) => Generator<Y, R, any>
): EventHandler<Args, FailsOf<Y>, R, ReadsPendingOf<Y>, WaitsOf<Y>> {
  const owner = getOwner();
  let boundary = false;
  if (owner) {
    try {
      boundary = useContext(BOUNDARY);
    } catch {}
  }
  const run = action(function* (rec: CallRecord, ...args: Args) {
    try {
      const value = yield* eventSteps(body(...args) as Generator<unknown, unknown, unknown>);
      rec.done = { ok: true, value };
      return value;
    } catch (error) {
      rec.done = { ok: false, value: error };
      throw error;
    }
  });
  return ((...args: Args) => {
    // A failure goes to whoever handles the returned promise; one nobody
    // handles (a DOM dispatch ignores the result) goes to the boundary.
    const rec: CallRecord = {};
    let handled = false;
    const result = run(rec, ...args).then(undefined, (error: unknown) => {
      if (!handled && boundary && owner) {
        reportError(owner, error);
        return undefined;
      }
      throw error;
    });
    const then = result.then.bind(result);
    result.then = ((onFulfilled?: any, onRejected?: any) => {
      handled = true;
      return then(onFulfilled, onRejected);
    }) as typeof result.then;
    // `yield* call`: a write that waits for the call — at once when the body
    // already finished (a synchronous event, as an `$effect` may delegate to).
    (result as any)[Symbol.iterator] = function* (): Generator<unknown, unknown, unknown> {
      if (__DEV__) checkWrite();
      const done = rec.done;
      if (done) {
        handled = true;
        then(undefined, () => {});
        if (done.ok) return done.value;
        throw done.value;
      }
      return yield new Wait_(result);
    };
    return result;
  }) as any;
}

/** Whether (and how) an event call's body finished. */
interface CallRecord {
  done?: { ok: boolean; value: unknown };
}

class StartOp {
  *[Symbol.iterator](): Generator<never, void, unknown> {
    if (__DEV__) checkWrite();
  }
}
/**
 * `yield* start(save(x))`: an event call the block does not wait for. It is a
 * write; the callee's colors stay its own, and a failure nobody handles goes
 * to the nearest `Errored`.
 */
export function start(
  _call: EventCall<unknown, unknown, boolean, boolean>
): Yieldable<Write, void> {
  return new StartOp() as any;
}

// --- blocks -----------------------------------------------------------------------------------

function isGeneratorFunction(fn: unknown): fn is (...args: any[]) => Generator {
  return typeof fn === "function" && Object.getPrototypeOf(fn) === GeneratorFunctionPrototype;
}
const GeneratorFunctionPrototype = Object.getPrototypeOf(function* () {});

function runHole(body: () => Generator<unknown, unknown, unknown>): unknown {
  const prev = host;
  host = HOLE;
  try {
    return drive(body(), HOLE_RUN);
  } finally {
    host = prev;
  }
}

/**
 * `$(function* () { return (yield* n) * 2 })`: a hole block — a derived
 * read that is not memoized, usable as a child (and, in `h` / `html`, as an
 * attribute value) where it becomes one fine-grained hole, and readable with
 * `yield*`. With parameters it is a row block (`$(function* (item) {…})`).
 */
export function $<Y extends HoleOp = never, R = unknown>(
  body: () => Generator<Y, R, any>
): Block<R, PendingOf<Y>, FailsOf<Y>>;
export function $<A extends unknown[], F extends (...args: A) => Generator<any, any, any>>(
  body: F
): F;
export function $(body: any): any {
  if (body.length > 0) return $scope(body);
  const block: any = () => runHole(body);
  block[READ] = block;
  block[Symbol.iterator] = sourceIterator;
  block[BODY] = body;
  return block;
}

/** Mark a generator function as a row block explicitly. */
export function $scope<F extends (...args: any[]) => Generator<any, any, any>>(body: F): F {
  (body as any)[ROW_MARK] = true;
  return body;
}

// --- components and views -------------------------------------------------------------------

function runSetup(
  body: (...args: any[]) => Generator<unknown, unknown, unknown>,
  args: unknown[]
): unknown {
  const prev = host;
  const prevRunning = viewRunning;
  const prevJsx = jsxRead;
  host = SETUP;
  // a child's setup is not its parent view's top level, nor a JSX read
  viewRunning = false;
  jsxRead = false;
  let result: unknown;
  try {
    result = drive(body(...args), SYNC_RUN);
  } finally {
    host = prev;
    viewRunning = prevRunning;
    jsxRead = prevJsx;
  }
  return result;
}

function warnWholeView(): void {
  console.warn(
    "[VIEW_READS_OUTSIDE_JSX] this view re-renders as a whole; move the read into JSX or a $memo."
  );
}

/**
 * Render a view generator. The common case (every read is in a hole) runs
 * the generator once and returns what it built. A view that read at its top
 * level re-renders as a whole: its first result is kept, the reads it took
 * are re-read in a memo to subscribe, and every later run rebuilds the view.
 */
export function renderView(viewFn: () => Generator<unknown, unknown, unknown>): unknown {
  if (__SERVER__) return runAs(VIEW, () => drive(viewFn(), SYNC_RUN));
  const prevRunning = viewRunning;
  const prev = host;
  const prevJsx = jsxRead;
  viewRunning = true;
  host = VIEW;
  jsxRead = false;
  let value: unknown;
  let whole = false;
  try {
    value = drive(viewFn(), SYNC_RUN);
  } catch (e) {
    if (e !== WHOLE_VIEW) throw e;
    whole = true;
  } finally {
    viewRunning = prevRunning;
    host = prev;
    jsxRead = prevJsx;
  }
  if (!whole) return value;
  if (__DEV__) warnWholeView();
  const view: any = createMemo(() => {
    const prevRunning = viewRunning;
    viewRunning = false;
    try {
      return runAs(VIEW, () => drive(viewFn(), SYNC_RUN));
    } finally {
      viewRunning = prevRunning;
    }
  });
  view[VIEW_MARK] = true;
  return view;
}

/**
 * `$component(function* (props) { setup; return function* () { view } })`.
 *
 * The setup runs once, untracked, under the component's owner: it creates
 * state and reads context. The returned generator is the view: it only reads.
 */
export function $component<
  TP = unknown,
  Y extends SetupOp = never,
  V extends () => Generator<ViewOp, unknown, any> = () => Generator<never, unknown, any>
>(
  body: (props: TP) => Generator<Y, V, any>,
  ..._rule: NoJsxViewRule<ViewYield<V>, ViewReturn<V>>
): Component<
  PropsOf<TP>,
  ViewPending<ViewYield<V> | Extract<Y, Snapshot<any, any>>, ViewReturn<V>>,
  ViewFails<ViewYield<V> | Extract<Y, Snapshot<any, any>>, ViewReturn<V>>
> {
  const component: any = function (props?: object) {
    return untrack(() => {
      const view = runSetup(body as any, [typedProps(props || {})]);
      if (typeof view !== "function")
        throw devError(
          "COMPONENT_VIEW",
          "a $component's setup returns its view: `return function* () { return <…/> }`."
        );
      return renderView(view as any);
    });
  };
  component[COMPONENT_MARK] = true;
  // Dev owner labels (`in <App> › <Card> › …`) use the component's name: a
  // named setup (`$component(function* Card(props) {…})`) names it.
  if (body.name) Object.defineProperty(component, "name", { value: body.name });
  return component;
}

/** What a view function yields (a setup may return one of several views). */
export type ViewYield<V> = V extends () => Generator<infer Y, any, any> ? Y : never;
/** What a view function returns. */
export type ViewReturn<V> = V extends () => Generator<any, infer R, any> ? R : never;

/**
 * A no-JSX view (one returning `h` / `html` output) reads only in its holes:
 * its own yield may only be child views. Violations surface as a missing
 * argument naming the rule.
 */
export type NoJsxViewRule<VY, R> = [R] extends [HView<any, any>]
  ? [Exclude<VY, ChildView<any, any>>] extends [never]
    ? []
    : [
        error: "[HVIEW_READ] a no-JSX view reads only in holes: pass the source, or a $(function* …) block, to h / html"
      ]
  : [];

/**
 * `const Page = adopt(lazy(() => import("./Page")))`: a component this
 * library did not create (a `lazy()` chunk, a library's component), usable in
 * call form in a hole — `{yield* Page()}` — as a `$component` is: created
 * untracked (as a tag is), so the hole does not re-create it when what it
 * builds changes (a `lazy` chunk landing), and its output passed on as a view.
 * Its type is its own: a lazily loaded block component keeps its coloring.
 * `preload` / `moduleUrl` (lazy's) are kept.
 */
export function adopt<T extends (props: any) => any>(
  comp: T
): T & { readonly [COMPONENT_BRAND]: true } {
  const adopted: any = function (props?: object) {
    const out = untrack(() => comp(props || {}));
    if (typeof out === "function" && out[READ] === undefined) out[VIEW_MARK] = true;
    return out;
  };
  for (const key of Object.keys(comp)) adopted[key] = (comp as any)[key];
  adopted[COMPONENT_MARK] = true;
  if (comp.name) Object.defineProperty(adopted, "name", { value: comp.name });
  return adopted;
}

export function isComponent(value: unknown): boolean {
  return typeof value === "function" && (value as any)[COMPONENT_MARK] === true;
}

/** Whether a render callback is a row block (a generator function, `$scope`, `$(function* (x) …)`). */
export function isRowBlock(fn: unknown): boolean {
  return typeof fn === "function" && ((fn as any)[ROW_MARK] === true || isGeneratorFunction(fn));
}

/**
 * Run a row block: its setup with the render arguments, then its view. A
 * generator that returns something other than a view function rendered it
 * directly (a view without setup).
 */
export function runRow(
  body: (...args: any[]) => Generator<unknown, unknown, unknown>,
  args: unknown[]
): unknown {
  return untrack(() => {
    const view = runSetup(body, args);
    if (
      typeof view === "function" &&
      (view as any)[READ] === undefined &&
      !(view as any)[VIEW_MARK]
    )
      return renderView(view as any);
    return view;
  });
}

export { isGeneratorFunction };
