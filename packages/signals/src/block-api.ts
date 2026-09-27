/*
 * Generator blocks v2 (documentation/plans/generator-blocks-v2.md).
 *
 * Every kind of block has its own constructor, and each kind admits a fixed
 * set of operations:
 *
 *   $component(function* (props) { setup; return function* () { view } })
 *       setup: $signal, $store, $memo, $effect, $cleanup, yield* Ctx
 *       view:  reads only (the existing JSX host)
 *   $memo(function* () {…})     reads, raise, attempt (sync or async)
 *   $effect(function* () {…})   reads, writes, $cleanup, raise, attempt (sync)
 *   $event(function* (e) {…})   reads, writes, $flush, raise, attempt (sync or async)
 *
 * Everything runs on the generator driver in `generator.ts`: operations are
 * yielded, the driver checks the running block's host and performs them.
 * A component's pending and failures travel with the value it renders (its
 * `View`), so `JSX.Element` can admit settled views only.
 */
import type { META } from "./generator.js";
import {
  $,
  COMPONENT,
  EFFECT,
  OP,
  VIEW,
  inBlock,
  lazyView,
  registerTypedProps,
  runEffectHalf,
  isBlock,
  dispatchBlock,
  readProp,
  runBlockAs,
  Receipt,
  viewIterator,
  type AsyncOp,
  type BlockAsync,
  type BlockErrors,
  type BlockMeta,
  type Block,
  type CleanupOp,
  type CreateOp,
  type FlushOp,
  type Op,
  type PropRead,
  type ReadOp,
  type StoreRead,
  type StoreReadOp,
  type StoreValueBrand,
  type ReadsOf,
  type TasksOf,
  type FailuresOf,
  type WritesOf,
  type WriteOp,
  type ContextOp,
  type PathKey
} from "./generator.js";
import { getOwner, untrack } from "./core/index.js";
import { getContext, setContextIterator, type Context } from "./core/context.js";
import {
  createEffect,
  createMemo,
  createSignal,
  createTrackedEffect,
  type SignalOptions,
  type MemoOptions,
  type SourceAccessor,
  type Setter
} from "./signals.js";
import { createStore, type Store, type StoreSetter } from "./store/index.js";

// --- types -------------------------------------------------------------------

/** Operations a component's setup may yield. */
export type SetupOp = CreateOp<any, any> | CleanupOp | ContextOp<any, any>;
/**
 * A generator body a plain host accepts (`createMemo(function* …)`): a
 * function returning a generator of `Allowed` operations — never a function
 * returning `any`, which would otherwise match and hijack plain callbacks.
 */
export type GeneratorBody<F, Allowed> = F &
  (F extends () => infer G
    ? 0 extends 1 & G
      ? never
      : G extends Generator<Allowed, any, any>
        ? unknown
        : never
    : never);
export type GeneratorYield<F> = F extends () => Generator<infer Y, any, any> ? Y : never;
export type GeneratorReturn<F> = F extends () => Generator<any, infer R, any> ? R : never;
/** Operations a memo may yield. */
export type MemoOp = ReadLike | AsyncOp<any, any> | RaiseLike | AttemptLike;
/** Operations an effect may yield. */
export type EffectOp = ReadLike | WriteOp<any> | CleanupOp | RaiseLike | AttemptLike;
/** Operations an event may yield. */
export type EventOp =
  | ReadLike
  | WriteOp<any>
  | FlushOp
  | AsyncOp<any, any>
  | RaiseLike
  | AttemptLike;
/** Operations a view may yield: reads (child views are reads of their view). */
export type ViewOp = ReadLike;
/** A read: of a source, a prop path, a store path or a store selector. */
type ReadLike = ReadOp<any> | PropRead<any, any> | StoreRead<any, any> | StoreReadOp<any, any>;
type RaiseLike = Extract<Op, { readonly [OP]: "raise" }>;
type AttemptLike = Extract<Op, { readonly [OP]: "attempt" }>;

declare const PENDING: unique symbol;
declare const FAILS: unique symbol;
declare const VIEW_BRAND: unique symbol;
declare const COMPONENT_BRAND: unique symbol;

/**
 * What a component renders. `Pending` / `Failures` are the effects it has not
 * handled: a view is *settled* when neither remains, and only settled views
 * are JSX elements. Structurally a read source, so `yield* view` (inside
 * another view) propagates its effects into the parent.
 */
export interface View<Pending extends boolean = boolean, Failures = unknown> {
  readonly [VIEW_BRAND]: true;
  readonly [PENDING]: Pending;
  readonly [FAILS]: Failures;
  readonly [META]: BlockMeta<
    never,
    Pending extends true ? AsyncOp<unknown, never> : never,
    Failures,
    never
  >;
  // `yield* view` moves the view's pending / failures into the enclosing
  // view (they are now its effects), so the value it produces is settled.
  [Symbol.iterator](): Generator<ReadOp<View<Pending, Failures>>, View<false, never>, any>;
}
/**
 * Intersected into a renderer's "any object" element type so a view is only
 * ever admitted as a view (settled), never as a generic rendered object.
 */
export type NonView = { readonly [VIEW_BRAND]?: never };
/** A view with nothing left to handle. */
export type SettledView = View<false, never>;

/** Pending / failures of a view body's operations (own, plus inherited through reads). */
type ViewBlock<VY> = Block<unknown, ReadsOf<VY>, TasksOf<VY>, FailuresOf<VY>, never>;
// An untyped (`any`) operation says nothing: the view may be pending and fail.
export type ViewOf<VY> = 0 extends 1 & VY
  ? View<boolean, unknown>
  : View<BlockAsync<ViewBlock<VY>>, BlockErrors<ViewBlock<VY>>>;

/**
 * Props as a component sees them: every prop is a read (`yield* props.id`).
 * Passing `props.id` on to a child passes the read, not its value.
 */
export type TypedProps<P> = { readonly [K in keyof P & PathKey]-?: PropPath<P, [K], P[K]> };
/**
 * A prop read, which also reads deeper (`yield* props.todo.title` is one
 * tracked walk of the props, compiled). Functions and arrays stop the path.
 */
export type PropPath<P, Path extends readonly PathKey[], V> = PropRead<P, Path> &
  (V extends (...args: any[]) => any
    ? unknown
    : V extends readonly any[]
      ? unknown
      : V extends object
        ? { readonly [K in keyof V & PathKey]-?: PropPath<P, [...Path, K], V[K]> }
        : unknown);
/** What callers may pass for a prop: the value, or something readable for it. */
export type PropsInput<P> = {
  [K in keyof P]: P[K] | SourceAccessor<P[K]> | PropRead<any, any>;
};

/** A `$component`: calling it renders it and returns its view. */
export interface Component<P = {}, Pending extends boolean = boolean, Failures = unknown> {
  (props: PropsInput<P>): View<Pending, Failures>;
  readonly [COMPONENT_BRAND]: true;
}

/**
 * A `$store` as blocks see it: every property is a read (`yield* store.a.b`),
 * nested objects and arrays included. (At runtime a store proxy answers
 * property access inside a block with a path token; `yield*` performs the
 * tracked read.)
 */
export type TypedStore<T> = (T extends readonly (infer U)[]
  ? { readonly [n: number]: StoreSource<U>; readonly length: StoreSource<number> }
  : T extends object
    ? { readonly [K in keyof T]-?: StoreSource<T[K]> }
    : never) &
  StoreValueBrand<T>;
/** One store path: readable with `yield*`, and walkable further when it holds an object. */
export type StoreSource<V> = {
  [Symbol.iterator](): Generator<ReadOp<SourceAccessor<V>>, V, any>;
} & (V extends object ? TypedStore<V> : unknown);

/** A `$signal` setter: writes when called; `yield*` on the receipt is the new value. */
export type BlockSetter<T> = (value: T | ((prev: T) => T)) => WriteReceipt<T>;
export interface WriteReceipt<T> {
  [Symbol.iterator](): Generator<WriteOp<Setter<T>>, T, any>;
}
export type BlockStoreSetter<T> = (fn: (draft: T) => T | void) => WriteReceipt<T>;

/** A memo's accessor, carrying its body's effects for readers. */
export type MemoAccessor<R, Y> = SourceAccessor<R> & {
  readonly [META]: BlockMeta<ReadsOf<Y>, TasksOf<Y>, FailuresOf<Y>, never>;
};

/** An event handler built by `$event`: call it with the event. */
export interface EventHandler<E = unknown, Y = unknown> {
  (event: E): void;
  readonly [META]: BlockMeta<ReadsOf<Y>, TasksOf<Y>, FailuresOf<Y>, WritesOf<Y>>;
}

// --- primitives --------------------------------------------------------------

/**
 * The primitives blocks create with. `solid-js` registers its own
 * (hydration-aware on the client, the server implementations on the server)
 * so a `$memo` in a `solid-js` app is a `solid-js` memo.
 */
// Empty until a renderer registers its own; each constructor falls back to
// this package's primitive at its use site, so a primitive is only retained
// by a bundle that uses the constructor needing it (`createStore` only with
// `$store`).
const primitives: {
  createSignal?: (value: any, options?: any) => any;
  createMemo?: (fn: any, options?: any) => any;
  createStore?: (value: any, options?: any) => any;
  createTrackedEffect?: (fn: () => void) => void;
  createEffect?: (compute: any, effect: any) => void;
} = {};

/** A generator body, or the block the compiler already built from it. */
function toBlock(body: unknown): any {
  return isBlock(body) ? body : $(body as any);
}
/** @internal */
export function setBlockPrimitives(p: Partial<typeof primitives>): void {
  Object.assign(primitives, p);
}

// --- operations --------------------------------------------------------------

/**
 * A v2 operation (`$signal`, `$store`, `$memo`, `$effect`, `$cleanup`,
 * `$flush`, `yield* Ctx`). One class, one shape: the iterator lives on the
 * prototype, so creating an operation is one allocation (no per-op
 * symbol-keyed property copy). `perform` and the driver recognize it by its
 * `[OP]` tag and read the field that tag names (`make` / `fn` / `read`).
 */
class Operation {
  readonly [OP]: string;
  delegated = false;
  constructor(
    tag: string,
    readonly kind?: string,
    readonly make?: () => unknown,
    readonly fn?: () => void,
    readonly context?: Context<any>,
    readonly read?: () => unknown
  ) {
    this[OP] = tag;
  }
  *[Symbol.iterator](): Generator<any, any, any> {
    this.delegated = true;
    return yield this;
  }
}

/** `yield* $signal(value)` — create a signal in a component's setup. */
export function $signal<T>(
  value: T,
  options?: SignalOptions<T>
): CreateOp<[get: SourceAccessor<T>, set: BlockSetter<T>], "signal"> {
  return new Operation("create", "signal", () => {
    const [get, set] = (primitives.createSignal || createSignal)(value, options) as [
      SourceAccessor<T>,
      Setter<T>
    ];
    return [get, blockSetter(set as any)];
  }) as any;
}

/** `yield* $store(value)` — create a store in a component's setup. */
export function $store<T extends object>(
  value: T
): CreateOp<[get: TypedStore<T>, set: BlockStoreSetter<T>], "store"> {
  return new Operation("create", "store", () => {
    const [get, set] = (primitives.createStore || createStore)(value) as [Store<T>, StoreSetter<T>];
    return [get, blockSetter(set as any)];
  }) as any;
}

/** `yield* $memo(function* () {…})` — create a memo in a component's setup. */
export function $memo<Y extends MemoOp, R>(
  body: () => Generator<Y, R, any>,
  options?: MemoOptions<R>
): CreateOp<MemoAccessor<R, Y>, "memo"> {
  return new Operation("create", "memo", () =>
    (primitives.createMemo || createMemo)(toBlock(body), options)
  ) as any;
}

/**
 * `yield* $effect(function* () {…})` — create an effect in a component's
 * setup. It reads, writes (deferred until flush) and cleans up. Compiled, the
 * compiler moves every read into the effect's compute phase; uncompiled it
 * runs as one tracked pass.
 */
export function $effect<Y extends EffectOp>(
  body: () => Generator<Y, void, any>,
  compute?: unknown
): CreateOp<void, "effect"> {
  return new Operation("create", "effect", () => effectBlock(body, compute)) as any;
}

/**
 * @internal Create an effect block. With `compute` (compiled: the block of the
 * effect's hoisted reads) it is a split effect: `compute` tracks the reads and
 * the body runs as the effect half with the values as its input, its
 * `$cleanup`s returned as the half's cleanup. Without, the body runs as one
 * tracked pass.
 */
export function effectBlock(body: unknown, compute?: unknown): void {
  const block = toBlock(body);
  if (!compute) {
    (primitives.createTrackedEffect || createTrackedEffect)(() => {
      runBlockAs(EFFECT, block, undefined);
    });
    return;
  }
  (primitives.createEffect || createEffect)(compute, (values: unknown) =>
    runEffectHalf(block, values)
  );
}

/** `yield* $cleanup(fn)` — run `fn` when the component (or the effect run) is disposed. */
export function $cleanup(fn: () => void): CleanupOp {
  return new Operation("cleanup", undefined, undefined, fn) as any;
}

/** `yield* $flush()` — drain pending writes now (event blocks only). */
export function $flush(): FlushOp {
  return new Operation("flush") as any;
}

/** A setter whose calls return a receipt: `yield* set(v)` is the new value. */
function blockSetter(set: (value: any) => any): (value: any) => WriteReceipt<any> {
  return (value: any) => new Receipt(set(value)) as any;
}

// --- context ------------------------------------------------------------------

function contextOp(context: Context<any>): ContextOp<any, any> {
  return new Operation("context", undefined, undefined, undefined, context, () =>
    getContext(context)
  ) as any;
}
setContextIterator(function* (context) {
  return yield* contextOp(context);
});

// --- $event ------------------------------------------------------------------

/**
 * `$event(function* (e) {…})` — an event handler. Reads return the current
 * value, writes are allowed, an async `attempt` suspends it, and a failure is
 * routed to the nearest error boundary above where the handler was created.
 */
export function $event<E = unknown, Y extends EventOp = never>(
  body: (event: E) => Generator<Y, unknown, any>
): EventHandler<E, Y> {
  const block = toBlock(body);
  const owner = getOwner();
  const handler = (event: E) => dispatchBlock(block, event, owner);
  return handler as any;
}

// --- $component ----------------------------------------------------------------

const PROPS_COMPILED = 1;

/**
 * `$component(function* (props) { setup; return function* () { view } })`.
 *
 * The setup runs once, under the component's owner and untracked: it creates
 * state and reads context. The returned generator is the view: it only
 * reads, and it is rendered where the component is used. Calling the
 * component returns its view, so `yield* Child(props)` inside a view renders
 * the child and carries its pending / failures into the parent's type.
 */
export function $component<P = {}, Y extends SetupOp = never, VY extends ViewOp = never>(
  body: (props: TypedProps<P>) => Generator<Y, () => Generator<VY, unknown, any>, any>,
  flags: number = 0
): Component<P, ViewOf<VY>[typeof PENDING], ViewOf<VY>[typeof FAILS]> {
  const setup = toBlock(body);
  const component = function (props: any): unknown {
    // Called inside a running view (uncompiled `Loading({ children: X(p) })`):
    // defer to where it renders, as the compiler's prop getters do.
    if (inBlock()) return lazyView(() => component(props));
    return untrack(() => {
      const viewBody = runBlockAs(
        COMPONENT,
        setup,
        flags & PROPS_COMPILED ? props : typedProps(props)
      );
      if (typeof viewBody !== "function") {
        throw new TypeError(
          "[COMPONENT_VIEW] A $component's setup must return its view: `return function* () { return <…/> }`"
        );
      }
      return view(viewBody as any);
    });
  };
  (component as any)[COMPONENT_MARK] = true;
  return component as any;
}

/** @internal Runtime brand of `$component` functions. */
export const COMPONENT_MARK = Symbol("component");
/** @internal Runtime brand of views. */
export const VIEW_MARK = VIEW;

export function isComponent(value: unknown): boolean {
  return typeof value === "function" && (value as any)[COMPONENT_MARK] === true;
}

/** A view: a JSX-host block. `yield*` on it evaluates to the view itself. */
function view(body: () => Generator<any, unknown, any>): unknown {
  const block = toBlock(body);
  block[VIEW_MARK] = true;
  block[Symbol.iterator] = viewIterator;
  return block;
}

/**
 * A prop read that reads deeper on property access: `yield* props.todo.id`
 * on the driver (compiled, it is one path read of the raw props). The read's
 * own fields (`source`, `root`, `path`, `kind`, `delegated`) shadow props of
 * those names below the first level.
 */
function propChain(root: object, path: string[]): unknown {
  const read = readProp(root, path) as any;
  return new Proxy(read, {
    get(target, key) {
      if (typeof key === "symbol" || key in target) return target[key];
      return propChain(root, [...path, key]);
    }
  });
}

/**
 * Props as reads: `props.x` is a prop read (`yield* props.x` performs it);
 * forwarding `props.x` to a child forwards the read.
 */
function typedProps(props: any): any {
  if (props == null) return props;
  const proxy = new Proxy(props, {
    get(target, key) {
      if (typeof key === "symbol") return target[key];
      return propChain(target, [key]);
    }
  });
  registerTypedProps(proxy, props);
  return proxy;
}
