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
  createMemo,
  createRenderEffect,
  createSignal,
  createStore,
  createTrackedEffect,
  flush,
  getObserver,
  getOwner,
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
  type SignalOptions,
  type Store
} from "solid-js";
import type {
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
  Flush,
  HoleOp,
  MemoOp,
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
/** Cleanups of the running effect run (null outside an effect). */
let cleanupSink: (() => void)[] | null = null;
/** Set while a memo runs after its first async `attempt`. */
let memoResumed = false;

function devError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`);
}

function checkRead(): void {
  if (host === SETUP)
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

/** Perform the read a readable stands for (tracked in the running computation). */
function readOf(x: any): unknown {
  if (__DEV__) checkRead();
  if (viewRunning && getObserver() === null) throw WHOLE_VIEW;
  const r = x[READ];
  return r === PATH_READ ? readPath(x[PATH_TARGET]) : r.call(x);
}

/** A value read through: a readable's value, else the value itself. */
export function through(v: any): any {
  return v != null && v[READ] !== undefined ? readOf(v) : v;
}

function* sourceIterator(this: any): Generator<never, unknown, unknown> {
  return readOf(this);
}

/** Turn an accessor this library created into a source (iterable, readable). */
function asSource<T>(get: Accessor<T>): Source<T, any, any> {
  (get as any)[READ] = get;
  (get as any)[Symbol.iterator] = sourceIterator;
  return get as any;
}

const foreign = new WeakMap<Function, unknown>();
/**
 * `yield* read(accessor)`: read an accessor this library did not create (plain
 * Solid, a router, another library). Its coloring cannot be seen, so it is
 * trusted as settled unless stated: `read<T, true, E>(accessor)`.
 */
export function read<T, P extends boolean = false, E = never>(accessor: () => T): Source<T, P, E> {
  if ((accessor as any)[READ] !== undefined) return accessor as any;
  let s = foreign.get(accessor);
  if (!s) foreign.set(accessor, (s = asSource(() => accessor())));
  return s as any;
}

/** A plain accessor for a source, to hand to code that is not a block. */
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
    if (x[READ] !== undefined) return readOf(x) as T;
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

/** `yield* store.a.b` for a store this library did not create. */
export function paths<T extends object>(store: Store<T> | T): TypedStore<T> {
  return makePath(store, false, []);
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
  *[Symbol.iterator](): Generator<never, unknown, unknown> {
    return readOf(this);
  }
}
/**
 * `yield* readStore(todos, t => t.filter(x => x.completed).length)`: one
 * tracked read of whatever the selector touches (a structural read that is
 * not one path).
 */
export function readStore<T, R>(
  store: TypedStore<T> | Store<T> | T,
  select: (state: T) => R
): Source<R, false, never> {
  return new Selection(store, select as any) as any;
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
  constructor(readonly run: () => unknown) {}
  *[Symbol.iterator](): Generator<unknown, unknown, unknown> {
    const v = this.run();
    if (isThenable(v)) return yield new Wait_(v);
    return v;
  }
}
type AttemptOps<T, E> =
  | (T extends PromiseLike<any> ? Wait : never)
  | ([E] extends [never] ? never : Raise<E>);
/**
 * `yield* attempt(fn, ...Errors)`: call `fn`, declaring the failures it may
 * raise. When `fn` returns a promise the block suspends until it settles
 * ($memo and $event only) and resumes with its value, or with the rejection
 * thrown at the `yield*`.
 */
export function attempt<T, C extends ErrorClass[] = []>(
  fn: () => T,
  ..._errors: C
): Yieldable<AttemptOps<T, InstanceType<C[number]>>, Awaited<T>> {
  return new Attempt(fn) as any;
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

class Receipt<T> {
  constructor(readonly value: T) {}
  *[Symbol.iterator](): Generator<never, T, unknown> {
    return this.value;
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
  return (v: any) => {
    if (__DEV__) checkWrite();
    const r = set(v);
    return new Receipt(value ? value() : r);
  };
}

function checkCreate(kind: string): void {
  if (host !== SETUP)
    throw devError(
      "CREATE_OUTSIDE_SETUP",
      `$${kind} creates state: call it in a $component's (or a row block's) setup, not in ${HOST_NAMES[host]}.`
    );
}

class CreateOp<T> {
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

type MemoValue<R> = R extends PromiseLike<infer U> ? U : R extends AsyncIterable<infer U> ? U : R;
type MemoPending<Y, R> =
  PendingOf<Y> extends true ? true : R extends PromiseLike<any> | AsyncIterable<any> ? true : false;

/** `const doubled = yield* $memo(function* () { return (yield* n) * 2 })` in a setup. */
export function $memo<Y extends MemoOp = never, R = unknown>(
  body: () => Generator<Y, R, any>,
  options?: MemoOptions<MemoValue<R>>
): Yieldable<Create<"memo">, Source<MemoValue<R>, MemoPending<Y, R>, FailsOf<Y>>> {
  return new CreateOp("memo", () => memoOf(body, options)) as any;
}

function memoOf(body: () => Generator<unknown, unknown, unknown>, options?: any): any {
  let run = 0;
  const compute = () => {
    const my = ++run;
    let gen!: Generator<unknown, unknown, unknown>;
    let r!: IteratorResult<unknown, unknown>;
    const prev = host;
    host = MEMO;
    try {
      gen = body();
      r = gen.next();
    } finally {
      host = prev;
    }
    if (r.done) return r.value;
    return resume(gen, r.value, MEMO, () => my === run);
  };
  return asSource(createMemo(compute as any, options) as Accessor<unknown>);
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

class FlushOp {
  *[Symbol.iterator](): Generator<never, void, unknown> {
    if (__DEV__ && host !== EVENT)
      throw devError(
        "FLUSH_OUTSIDE_EVENT",
        `$flush belongs to an $event, not ${HOST_NAMES[host]}.`
      );
    flush();
  }
}
/** `yield* $flush()`: apply pending writes now (event handlers only). */
export function $flush(): Yieldable<Flush, void> {
  return new FlushOp() as any;
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
 * `$event(function* (e) {…})`: an event handler. Reads return current values,
 * writes apply, an async `attempt` suspends it, and a failure goes to the
 * nearest `Errored` above where the handler was created (or is thrown, as an
 * ordinary handler's would be, when there is none).
 */
export function $event<Ev = Event, Y extends EventOp = never>(
  body: (event: Ev) => Generator<Y, unknown, any>
): EventHandler<Ev, FailsOf<Y>> {
  const owner = getOwner();
  let boundary = false;
  if (owner) {
    try {
      boundary = useContext(BOUNDARY);
    } catch {}
  }
  const fail = (error: unknown) => {
    if (boundary && owner) reportError(owner, error);
    else throw error;
  };
  return ((event: Ev) => {
    let gen: Generator<unknown, unknown, unknown>;
    let r: IteratorResult<unknown, unknown>;
    const prev = host;
    host = EVENT;
    try {
      gen = body(event) as any;
      r = gen.next();
    } catch (e) {
      host = prev;
      fail(e);
      return;
    }
    host = prev;
    if (!r.done) resume(gen, r.value, EVENT, () => true).then(undefined, fail);
  }) as any;
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
  host = SETUP;
  let result: unknown;
  try {
    result = drive(body(...args), SYNC_RUN);
  } finally {
    host = prev;
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
  viewRunning = true;
  host = VIEW;
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
  VY extends ViewOp = never,
  R = unknown
>(
  body: (props: TP) => Generator<Y, () => Generator<VY, R, any>, any>,
  ..._rule: NoJsxViewRule<VY, R>
): Component<
  PropsOf<TP>,
  ViewPending<VY | Extract<Y, Snapshot<any, any>>, R>,
  ViewFails<VY | Extract<Y, Snapshot<any, any>>, R>
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
  return component;
}

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
