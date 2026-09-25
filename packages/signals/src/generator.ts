import { STATUS_ERROR } from "./core/constants.js";
import { unwrapStatusError } from "./core/error.js";
import {
  cleanup,
  effect,
  getOwner,
  runWithOwner,
  setBlockGuard,
  untrack,
  type Owner
} from "./core/index.js";
import type { SourceAccessor } from "./signals.js";

/*
 * `$` blocks — typed reactive computations with host-restricted effects.
 *
 * A block is a generator body whose every effectful step is a *yielded
 * operation*. The generator's yield type is split into effect categories so
 * the *host* that consumes the block can admit or refuse each one:
 *
 *   yield* signal                 Reads      tracked read
 *   yield* store.user.name        Reads      a store path (StoreRead<Root, ["user","name"]>)
 *   yield* props.count            Reads      a prop path  (PropRead<Props, ["count"]>)
 *   yield* readStore(store, sel)  Reads      one selector run over a store (root recorded)
 *   yield* wait(promise, ...Errs) Tasks      async suspension (declared errs → Failures)
 *   yield* raise(error)           Failures   typed throw
 *   yield* attempt(fn, ...Errs)   Failures   typed fallible call
 *   yield* write(setter, value)   Writes     typed write
 *   yield* call(block, input)     (delegation: the callee's categories)
 *   yield* otherBlock             (delegation with no input)
 *
 * One `$` builds one generic `Block<Value, Reads, Tasks, Failures, Writes,
 * Input>`; nothing about the block chooses a mode. The host restricts:
 *
 *   reactive (createMemo, createSignal(fn), createEffect/createRenderEffect
 *            compute)                                 Writes = never
 *   jsx      (a block rendered as a JSX child)        Tasks = Failures = Writes = never
 *   event    (a block bound to a DOM event)           everything
 *
 * A JSX block may still be pending or error-typed *through its Reads*: a
 * read token carries the source's own metadata (`createMemo(block)` keeps it
 * on the accessor), and `BlockAsync` / `BlockErrors` derive the totals.
 *
 * Effects: the compute phase of `createEffect` is a reactive host (no
 * writes — the effect callback, an ordinary function, is where writes go).
 * That distinction is intentional: writes are imperative, and the effect
 * phase already exists for them.
 *
 * Enforcement, by layer:
 * - TypeScript: `Y extends Op` (only operations may be yielded; a bare
 *   `yield signal` fails); host admissibility via structural `[META]` checks
 *   (`ComputeFunction` refuses Writes, `JSX.Element` admits only
 *   read-only blocks). TypeScript cannot see a direct `signal()` call, a raw
 *   `setter()` call, a `throw`, or undeclared throws/rejections — those need
 *   a type-aware checker. Effects of an ordinary callback invoked from a
 *   block are unknown (`attempt(fn)` records `unknown` failures).
 * - Runtime: dev builds refuse a direct read inside a block body
 *   (`[DIRECT_READ_IN_BLOCK]`); the driver refuses a bare `yield`, async
 *   generators, reads after the first `wait`, and host-inadmissible
 *   operations (`[OP_NOT_ALLOWED_IN_JSX]`, `[WRITE_IN_REACTIVE_BLOCK]`).
 * - Compiler: `throw`, bare `yield` and `async function*` inside a `$` are
 *   compile errors; lowered output runs under the same runtime checks.
 *
 * The failure union is the set of *declared* failure types — never a proof
 * that nothing else can throw.
 *
 * Stores: `readStore` records the store root in Reads and infers the
 * selector's result; it does not type the path read, give store instances
 * fresh identities, or resolve shared references — the proxy does the exact
 * tracking at runtime. A plain `Store<T>` carries no `[META]`, so the async /
 * error coloring of a store derived from an ordinary function is not
 * reflected in a block's derived totals (it still surfaces at runtime as
 * NotReadyError / the error). A store derived from a block —
 * `createProjection(block, seed)`, `createStore(block, seed)`,
 * `createOptimisticStore(block, seed)` — is a `BlockStore`: it keeps the
 * block's metadata, so reading it accumulates the block's Reads, async
 * status and error union exactly as reading `createMemo(block)` does.
 * Writes use `write(setStore, updater)`; store setters stay ordinary.
 *
 * Direct property syntax (`yield* store.user.name`, `yield* props.count`):
 * - Runtime: inside a block body (strict guard raised) a store proxy answers a
 *   string-keyed read with a *path token* instead of a value; further
 *   property access extends the token's path, `yield*` performs the read by
 *   re-walking the path through the real proxy with the guard lowered (so
 *   the store tracks exactly the nodes touched), and any other use of a
 *   token throws. A token that a run never consumed with `yield*` (e.g.
 *   `if (store.flag)`) fails the run with `[UNREAD_PATH]`, so a forgotten
 *   `yield*` is loud in both modes. Props objects are plain compiler output
 *   (getters), not proxies: `yield* props.count` works in compiled
 *   (lowered) code, where it becomes `perform(readProp(props, ["count"]))`
 *   and the getter runs with the guard lowered; in uncompiled code the
 *   getter's signal read fails loudly (`[DIRECT_READ_IN_BLOCK]`).
 * - Types: stock TypeScript types `yield* e` from the value type of `e`, so
 *   the source spelling is only checkable through the typecheck projection
 *   (`@solidjs/compiler`'s `projectBlocksForTypecheck`, driven by
 *   `solid-tsc`), which rewrites the operand to `readPath(root, [...])` /
 *   `readProp(root, [...])` — the same ops the compiler lowers to — typed
 *   `StoreRead<Root, Path>` / `PropRead<Root, Path>` with the selected
 *   value inferred by `PathValue`. Roots are recorded as written: an alias
 *   (`const u = store.user`) is its own root; no alias or shared-reference
 *   resolution is claimed.
 */

/** Runtime tag on every yieldable operation. */
export const OP: unique symbol = Symbol("block-op");
/** Runtime tag on blocks (distinguishes them from plain accessors). */
export const BLOCK: unique symbol = Symbol("block");
/** The block's body, for delegation with an input (`call`). */
const BODY: unique symbol = Symbol("block-body");
/** The owner in scope when the block was created (its defining component). */
const OWNER: unique symbol = Symbol("block-owner");
/** Phantom metadata slot — never present at runtime. */
export declare const META: unique symbol;
/** Phantom brand of a strict (non-generator) marked callback — never present at runtime. */
export declare const STRICT: unique symbol;

export type ErrorClass<E> = abstract new (...args: any[]) => E;
export type AnySetter = (value: any) => any;

/** `yield* signal` — the driver performs the tracked read. */
export interface ReadOp<Source = any> {
  readonly [OP]: "read";
  readonly source: Source;
  /** @internal set by the iterator that produced the op (`yield*`, not `yield`). */
  delegated: boolean;
  [Symbol.iterator](): Generator<
    ReadOp<Source>,
    Source extends SourceAccessor<infer T> ? T : unknown,
    any
  >;
}
/**
 * `yield* readStore(store, selector)` — one read operation over a store: the
 * driver runs `selector(store)` with direct reads permitted, and the store
 * proxy tracks exactly what the selector touched (per property, index,
 * length, structural). The block's Reads record the store root.
 */
export interface StoreReadOp<Store, R> {
  readonly [OP]: "read";
  /** The selector bound to the store; what the driver performs. */
  readonly source: () => R;
  readonly store: Store;
  delegated: boolean;
  [Symbol.iterator](): Generator<StoreReadOp<Store, R>, R, any>;
}
export type PathKey = string | number;
/**
 * The value selected by walking `P` from `R` (index signatures, tuples and
 * array elements included). A key that is not in `R` selects `unknown`; the
 * typecheck projection additionally hands TypeScript the authored expression
 * so a wrong key is reported as the usual TS2339 at its column.
 */
export type PathValue<R, P> = P extends readonly [infer K, ...infer Rest]
  ? K extends keyof R
    ? PathValue<R[K], Rest>
    : R extends readonly unknown[]
      ? K extends number
        ? PathValue<R[K], Rest>
        : unknown
      : unknown
  : R;
/**
 * What `yield* x.path` produces: the path's value — read through when that
 * value is itself readable (a signal accessor or a block), exactly as
 * `yield*` behaves on the value in an uncompiled block, so `yield*
 * props.filter` with `filter: SourceAccessor<Filter>` is a `Filter`.
 */
export type PathResult<R, P> = ReadThrough<PathValue<R, P>>;
type ReadThrough<V> = V extends AnyBlock
  ? BlockValue<V>
  : V extends SourceAccessor<infer T>
    ? T
    : V;
interface PathRead<R, P extends readonly PathKey[], Kind extends string> {
  readonly [OP]: "read";
  /** The bound walk; what the driver performs (guard lowered, through the real proxy). */
  readonly source: () => PathResult<R, P>;
  readonly root: R;
  readonly path: P;
  readonly kind: Kind;
  delegated: boolean;
  [Symbol.iterator](): Generator<this, PathResult<R, P>, any>;
}
/** `yield* store.user.name` (projected: `readPath(store, ["user","name"])`). */
export interface StoreRead<R, P extends readonly PathKey[]> extends PathRead<R, P, "store"> {}
/** `yield* props.count` (projected: `readProp(props, ["count"])`). */
export interface PropRead<R, P extends readonly PathKey[]> extends PathRead<R, P, "prop"> {}
/** `yield* wait(promise)` — suspends the block (a Task). */
export interface AsyncOp<T, E = unknown> {
  readonly [OP]: "wait";
  readonly promise: PromiseLike<T>;
  delegated: boolean;
  [Symbol.iterator](): Generator<AsyncOp<T, E>, T, any>;
}
/** `yield* raise(error)` — the typed replacement for `throw`. */
export interface RaiseOp<E> {
  readonly [OP]: "raise";
  readonly error: E;
  delegated: boolean;
  [Symbol.iterator](): Generator<RaiseOp<E>, never, any>;
}
/** `yield* attempt(fn, ...Errors)` — a call whose declared failures are typed. */
export interface AttemptOp<T, E = unknown> {
  readonly [OP]: "attempt";
  readonly run: () => T;
  delegated: boolean;
  [Symbol.iterator](): Generator<AttemptOp<T, E>, T, any>;
}
/** `yield* write(setter, value)` — a typed write (event hosts only). */
export interface WriteOp<S extends AnySetter = AnySetter> {
  readonly [OP]: "write";
  readonly target: S;
  readonly value: Parameters<S>[0];
  delegated: boolean;
  [Symbol.iterator](): Generator<WriteOp<S>, ReturnType<S>, any>;
}
/**
 * `yield* call(block, input)` — delegate to a block with an input. Never
 * reaches the driver as an op: its iterator yields the callee's own
 * operations, so the callee's categories accumulate in the caller.
 */
export interface CallOp<B extends AnyBlock> {
  readonly [OP]: "call";
  readonly block: B;
  readonly input: BlockInput<B>;
  [Symbol.iterator](): Generator<BlockOps<B>, BlockValue<B>, any>;
}
export type Op =
  | ReadOp<any>
  | StoreReadOp<any, any>
  | StoreRead<any, any>
  | PropRead<any, any>
  | AsyncOp<any, any>
  | RaiseOp<any>
  | AttemptOp<any, any>
  | WriteOp<any>
  | CallOp<any>;

export interface BlockMeta<Reads, Tasks, Failures, Writes> {
  readonly reads: Reads;
  readonly tasks: Tasks;
  readonly failures: Failures;
  readonly writes: Writes;
}

/** The ops a block re-yields when delegated to. */
type OpsOf<Reads, Tasks, Failures, Writes> =
  | (Reads extends SourceAccessor<any> ? ReadOp<Reads> : never)
  | Tasks
  | ([Failures] extends [never] ? never : RaiseOp<Failures>)
  | (Writes extends AnySetter ? WriteOp<Writes> : never);

/**
 * A typed reactive computation: a compute callback (returns a Promise when
 * it has Tasks, so Solid's async-memo model carries it), iterable for
 * delegation, with phantom effect metadata. `Input` is the argument the
 * host passes: `prev` for reactive hosts, the event for event hosts.
 */
export interface Block<
  Value,
  Reads = never,
  Tasks = never,
  Failures = never,
  Writes = never,
  Input = unknown
> {
  (input?: Input): [Tasks] extends [never] ? Value : Promise<Value>;
  readonly [META]: BlockMeta<Reads, Tasks, Failures, Writes>;
  readonly [BLOCK]: true;
  [Symbol.iterator](): Generator<OpsOf<Reads, Tasks, Failures, Writes>, Value, any>;
}
export type AnyBlock = Block<any, any, any, any, any, any>;
export type BlockValue<B> = B extends Block<infer V, any, any, any, any, any> ? V : never;
export type BlockReads<B> = B extends Block<any, infer R, any, any, any, any> ? R : never;
export type BlockTasks<B> = B extends Block<any, any, infer T, any, any, any> ? T : never;
export type BlockFailures<B> = B extends Block<any, any, any, infer F, any, any> ? F : never;
export type BlockWrites<B> = B extends Block<any, any, any, any, infer W, any> ? W : never;
export type BlockInput<B> = B extends Block<any, any, any, any, any, infer I> ? I : never;
export type BlockOps<B> =
  B extends Block<any, infer R, infer T, infer F, infer W, any> ? OpsOf<R, T, F, W> : never;

/** Phantom metadata retained by reactive values derived from a block. */
export type BlockMetadata<B extends AnyBlock> = {
  readonly [META]: BlockMeta<BlockReads<B>, BlockTasks<B>, BlockFailures<B>, BlockWrites<B>>;
};
/** An accessor created from a block (`createMemo(block)`) keeps its metadata. */
export type BlockAccessor<B extends AnyBlock> = SourceAccessor<BlockValue<B>> & BlockMetadata<B>;
/**
 * An accessor annotated with derived totals only — what a boundary block
 * reads, or how a prop can declare "this signal may be pending / fail with
 * these errors" without exposing its sources.
 */
export type ColoredAccessor<
  V,
  Async extends boolean = false,
  Errors = never
> = SourceAccessor<V> & {
  readonly [META]: BlockMeta<
    never,
    Async extends true ? AsyncOp<unknown, never> : never,
    Errors,
    never
  >;
};

// --- derived totals ------------------------------------------------------------

// A path read colors its reader through the root it walks (a `BlockStore`
// keeps its block's metadata) and through the value it reads through (a
// colored accessor or block held in a prop or a store field).
type MetaOf<S> =
  S extends StoreRead<infer R, infer P>
    ? MetaOf<R> | MetaOf<PathValue<R, P>>
    : S extends PropRead<infer R, infer P>
      ? MetaOf<PathValue<R, P>>
      : S extends { readonly [META]: infer M extends BlockMeta<any, any, any, any> }
        ? M
        : never;
/** Async through reads: a source whose metadata has Tasks, or whose own reads do. */
type MetaAsync<M> =
  M extends BlockMeta<infer R, infer T, any, any>
    ? [T] extends [never]
      ? MetaAsync<MetaOf<R>>
      : true
    : never;
/** Failures through reads: a source's declared failures, recursively. */
type MetaErrors<M> =
  M extends BlockMeta<infer R, any, infer F, any> ? F | MetaErrors<MetaOf<R>> : never;

/** Total async status: own Tasks, or inherited from read sources. */
export type BlockAsync<B> = [BlockTasks<B> | MetaAsync<MetaOf<BlockReads<B>>>] extends [never]
  ? false
  : true;
/** Total error union: own Failures plus those inherited from read sources. */
export type BlockErrors<B> = BlockFailures<B> | MetaErrors<MetaOf<BlockReads<B>>>;

// --- accumulation from a generator's yield union ---------------------------------

// A store read is structurally a `ReadOp` whose source is the bound
// selector; test for it first so the Reads record the store root, not the
// closure.
export type ReadsOf<Y> = Y extends StoreRead<any, any> | PropRead<any, any>
  ? Y
  : Y extends StoreReadOp<infer S, any>
    ? S
    : Y extends ReadOp<infer S>
      ? S
      : never;
export type TasksOf<Y> = Extract<Y, AsyncOp<any, any>>;
export type FailuresOf<Y> =
  | (Y extends AsyncOp<any, infer E> ? E : never)
  | (Y extends RaiseOp<infer E> ? E : never)
  | (Y extends AttemptOp<any, infer E> ? E : never);
export type WritesOf<Y> = Y extends WriteOp<infer S> ? S : never;

// --- host admissibility -----------------------------------------------------------

/** Intersected into `ComputeFunction`: a reactive host admits no Writes. */
export type ReactiveHostBlock = {
  readonly [META]?: BlockMeta<any, any, any, never>;
};
/** A block a JSX host admits: direct effects are reads only. */
export type JsxBlock<Value = unknown> = Block<Value, any, never, never, never, any>;
/**
 * The same admission as a *non-callable* shape, for `JSX.Element`: a union
 * member with a call signature would take contextual typing away from
 * ordinary function-valued props (`children: item => …`), so `Element`
 * admits blocks by their metadata and iterator only. Every `Block` value
 * has these members; only read-only ones satisfy the metadata.
 */
export interface JsxBlockShape<Value = unknown> {
  readonly [META]: BlockMeta<any, never, never, never>;
  readonly [BLOCK]: true;
  [Symbol.iterator](): Generator<any, Value, any>;
}
/** A block an event host admits: everything, with the event as input. */
export type EventBlock<E = unknown, Value = unknown> = Block<Value, any, any, any, any, E>;

// --- operations --------------------------------------------------------------------

function* opIterator(this: Op): Generator<Op, unknown, unknown> {
  // Only `yield*` runs this iterator; a bare `yield op` hands the driver an
  // op that was never marked, which it rejects.
  (this as { delegated: boolean }).delegated = true;
  return yield this;
}

/** Installed on every signal accessor: `yield* signal` yields a read op. */
export function* accessorIterator<T>(
  this: SourceAccessor<T>
): Generator<ReadOp<SourceAccessor<T>>, T, T> {
  return (yield {
    [OP]: "read",
    source: this,
    delegated: true,
    [Symbol.iterator]: opIterator
  } as any) as T;
}

/**
 * Read a store through a selector as one read operation. The selector runs
 * with direct reads permitted (the store proxy is what tracks them, at its
 * usual granularity), and its result is the value of the `yield*`. The
 * block's Reads record the store root. A pending or failed derive surfaces
 * at runtime through the read (NotReadyError / the error) either way; at
 * the type level a plain store carries no async / error metadata, so the
 * block's derived totals stay quiet, while a store derived from a block
 * (`createProjection(block, seed)` and the derived `createStore` /
 * `createOptimisticStore` forms) keeps the block's metadata and colors the
 * reader transitively (see the module notes).
 */
export function readStore<S extends object, R>(
  store: S,
  selector: (state: S) => R
): StoreReadOp<S, R> {
  // `readStore(store.user, …)` inside a block: the argument is a path token.
  const token = tokenOf(store);
  if (token) consume(token);
  const source = token ? () => selector(walk(token.root, token.path) as S) : () => selector(store);
  return { [OP]: "read", source, store, delegated: false, [Symbol.iterator]: opIterator } as any;
}

// --- direct property syntax: path reads and tokens ------------------------------

/** Brand of a path token's target (read through the proxy's `get`). */
const TOKEN: unique symbol = Symbol("path-token");
interface TokenTarget {
  root: object;
  path: PathKey[];
  parent: TokenTarget | null;
  used: boolean;
}
/** Tokens created during the current synchronous block run (unread = error). */
let liveTokens: TokenTarget[] | null = null;

/**
 * Called by a store proxy's `get` trap while the strict guard is raised: the
 * read is deferred into a token that records the path; `yield*` performs it.
 */
export function pathToken(root: object, key: PathKey, parent: TokenTarget | null = null): object {
  const target: TokenTarget = {
    root,
    path: parent ? [...parent.path, key] : [key],
    parent,
    used: false
  };
  if (liveTokens !== null) liveTokens.push(target);
  return new Proxy(target, tokenTraps);
}

function consume(target: TokenTarget): void {
  for (let node: TokenTarget | null = target; node !== null && !node.used; node = node.parent) {
    node.used = true;
  }
}

function tokenOf(value: unknown): TokenTarget | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function"))
    return undefined;
  // A store proxy answers an unknown symbol through its tracked path: probe
  // untracked and with the guard lowered (never a dependency).
  return probe(() => (value as any)[TOKEN]);
}

function describePath(target: TokenTarget): string {
  return target.path.map(key => (typeof key === "number" ? `[${key}]` : `.${key}`)).join("");
}

function tokenMisuse(target: TokenTarget, how: string): Error {
  return new Error(
    `[DIRECT_READ_IN_BLOCK] \`<root>${describePath(target)}\` was used ${how} inside a \`$\` block; read it with \`yield* <root>${describePath(target)}\``
  );
}

const tokenTraps: ProxyHandler<TokenTarget> = {
  get(target, key) {
    if (key === TOKEN) return target;
    if (key === Symbol.iterator) {
      return function* () {
        consume(target);
        return yield pathRead(target.root, target.path, "store", true);
      };
    }
    if (typeof key === "symbol") throw tokenMisuse(target, `as a value (${String(key)})`);
    return pathToken(target.root, key, target);
  },
  has(target, key) {
    if (key === TOKEN) return true;
    if (typeof key === "symbol") return false;
    throw tokenMisuse(target, `with \`in\``);
  },
  ownKeys(target) {
    throw tokenMisuse(target, "by enumerating its keys");
  },
  getOwnPropertyDescriptor(target, key) {
    throw tokenMisuse(target, `by describing \`${String(key)}\``);
  },
  set(target, key) {
    throw tokenMisuse(target, `to write \`${String(key)}\``);
  },
  deleteProperty(target, key) {
    throw tokenMisuse(target, `to delete \`${String(key)}\``);
  },
  defineProperty(target) {
    throw tokenMisuse(target, "to define a property");
  },
  getPrototypeOf(target) {
    throw tokenMisuse(target, "as a value (prototype)");
  }
};

/** Every token created by the run must have been read with `yield*`. */
function checkTokens(tokens: TokenTarget[]): void {
  // Latest first: the deepest unread path names the whole access.
  for (let i = tokens.length - 1; i >= 0; i--) {
    const target = tokens[i];
    if (!target.used) {
      throw new Error(
        `[UNREAD_PATH] \`<root>${describePath(target)}\` was accessed inside a \`$\` block but never read with \`yield*\`; write \`yield* <root>${describePath(target)}\` (a bare access is a deferred token, not a value)`
      );
    }
  }
}

function walk(root: unknown, path: readonly PathKey[]): unknown {
  let value: any = root;
  for (const key of path) value = value[key];
  return value;
}

/**
 * `yield* x.path` reads through a value that is itself readable — a signal
 * accessor or a block — as `yield*` does on that value in an uncompiled
 * block (`yield* props.filter` on a plain props object iterates the
 * accessor). The lowered `readPath` / `readProp` and the store's path tokens
 * do the same, so both modes agree. A block that waits cannot be read
 * through in call form (`[ASYNC_BLOCK_OUTSIDE_DRIVER]`), as with `yield*
 * block` on a lowered identifier.
 */
function readThrough(value: unknown): unknown {
  return typeof value === "function" &&
    ((value as any)[BLOCK] || Symbol.iterator in (value as object))
    ? perform(value as SourceAccessor<unknown>)
    : value;
}

function pathRead(root: unknown, path: readonly PathKey[], kind: string, delegated: boolean): Op {
  const token = tokenOf(root);
  if (token) {
    consume(token);
    root = token.root;
    path = [...token.path, ...path];
  }
  const walked = root;
  const full = path;
  return {
    [OP]: "read",
    source: () => readThrough(walk(walked, full)),
    root: walked,
    path: full,
    kind,
    delegated,
    [Symbol.iterator]: opIterator
  } as any;
}

/**
 * The op the compiler lowers `yield* store.a.b` to and the typecheck
 * projection types it as: one path read of a store (or any object) —
 * `StoreRead<Root, Path>`, performed by re-walking the real proxy. Not a
 * use-site helper; the source spelling is the member chain.
 *
 * `_witness` is typecheck-only: the projection passes the authored
 * expression itself (`readPath(store, ["user", "name"], store.user.name)`)
 * so TypeScript reports a wrong key (TS2339) at its authored column; the
 * compiler's lowering never passes it and the runtime ignores it.
 */
export function readPath<R, const P extends readonly PathKey[]>(
  root: R,
  path: P,
  _witness?: unknown
): StoreRead<R, P> {
  return pathRead(root, path, "store", false) as StoreRead<R, P>;
}

/**
 * The same read for a component's props (`yield* props.count`): the prop
 * getter runs with the guard lowered, so it tracks exactly as `props.count`
 * would in an ordinary computation — `PropRead<Props, Path>`.
 */
export function readProp<R, const P extends readonly PathKey[]>(
  root: R,
  path: P,
  _witness?: unknown
): PropRead<R, P> {
  return pathRead(root, path, "prop", false) as PropRead<R, P>;
}

/**
 * Suspend the block on a promise (a Task). Declared rejection classes type
 * the failure union (`wait(fetchUser(id), HttpError)`); with none declared
 * the failure type is `unknown`. Undeclared rejections still propagate at
 * runtime. Reads after the first `wait` are refused: they would be untracked.
 */
export function wait<T, C extends ErrorClass<any>[] = []>(
  promise: PromiseLike<T>,
  ...errors: C
): AsyncOp<T, C extends [] ? unknown : InstanceType<C[number]>> {
  return { [OP]: "wait", promise, delegated: false, [Symbol.iterator]: opIterator } as any;
}

/** The typed replacement for `throw`: the error joins the failure union. */
export function raise<E>(error: E): RaiseOp<E> {
  return { [OP]: "raise", error, delegated: false, [Symbol.iterator]: opIterator } as any;
}

/**
 * Run `fn` as a typed fallible step: the declared classes join the failure
 * union (`attempt(() => JSON.parse(s), SyntaxError)`); with none declared the
 * failure type is `unknown` — the honest type for an arbitrary callback,
 * whose effects a block cannot see. Anything else `fn` throws still
 * propagates at runtime.
 */
export function attempt<T, C extends ErrorClass<any>[] = []>(
  run: () => T,
  ...errors: C
): AttemptOp<T, C extends [] ? unknown : InstanceType<C[number]>> {
  return { [OP]: "attempt", run, delegated: false, [Symbol.iterator]: opIterator } as any;
}

/**
 * A typed write: records the setter in the block's Writes, so only an event
 * host admits the block. Ordinary setters are not context-sensitive — a raw
 * `setter(v)` call inside a block is simply untyped (and, inside a reactive
 * host, refused by Solid's own owned-scope write guard in dev).
 */
export function write<S extends AnySetter>(target: S, value: Parameters<S>[0]): WriteOp<S> {
  return { [OP]: "write", target, value, delegated: false, [Symbol.iterator]: opIterator } as any;
}

/** Delegate to a block with an input; its categories accumulate in the caller. */
export function call<B extends AnyBlock>(block: B, input: BlockInput<B>): CallOp<B> {
  return {
    [OP]: "call",
    block,
    input,
    *[Symbol.iterator]() {
      return yield* blockGenerator(block, input);
    }
  } as any;
}

// --- hosts ---------------------------------------------------------------------------

const REACTIVE = 0;
const JSX = 1;
const EVENT = 2;
type Host = typeof REACTIVE | typeof JSX | typeof EVENT;
const HOST_NAMES = ["reactive", "jsx", "event"] as const;

/** The host of the innermost running block. */
let currentHost: Host = REACTIVE;
/** The host the next block invocation runs under (set by a host wrapper). */
let pendingHost: Host | -1 = -1;

export function isBlock(value: unknown): value is AnyBlock {
  return typeof value === "function" && (value as any)[BLOCK] === true;
}

function runBlockAs<B extends AnyBlock>(host: Host, block: B, input: unknown): unknown {
  pendingHost = host;
  try {
    return block(input);
  } finally {
    pendingHost = -1;
  }
}

/**
 * Render a block as a JSX child: reads only. Renderers call this at their
 * insertion sink (`insert`, `flatten`) so a block that waits, raises,
 * attempts or writes is refused there at runtime, matching the type-level
 * admission into `JSX.Element`.
 */
export function renderBlock<B extends AnyBlock>(block: B): BlockValue<B> {
  return runBlockAs(JSX, block, undefined) as BlockValue<B>;
}

/**
 * Dispatch a DOM event to a block: the event host. Admits every category,
 * runs like an ordinary handler (no owner context),
 * and routes a failure — synchronous, or the rejection of a block that waits
 * — to the nearest error boundary above the block's creation owner (the
 * component that defined it, which forwarding the block through props
 * preserves) or the owner the sink passes. Without a boundary the error
 * propagates as it would from an ordinary handler (thrown, or an unhandled
 * rejection).
 */
export function dispatchBlock<B extends AnyBlock>(
  block: B,
  event: BlockInput<B>,
  owner: Owner | null = (block as any)[OWNER] ?? getOwner()
): void {
  let result: unknown;
  try {
    // Event-time code runs with no owner context, exactly like an ordinary
    // handler (an owner context would make every write an owned-scope
    // violation); the captured owner is for error routing.
    result = runWithOwner(null, () => runBlockAs(EVENT, block, event));
  } catch (error) {
    if (!reportBlockError(owner, error)) throw error;
    return;
  }
  if (isThenableValue(result)) {
    (result as PromiseLike<unknown>).then(undefined, error => {
      if (!reportBlockError(owner, error)) throw error;
    });
  }
}

/**
 * Deliver an event failure to the nearest error boundary above `owner`:
 * a throwaway render effect owned by `owner` throws the error once, which
 * is exactly the channel a failing computation uses, so the boundary's
 * `reset()` clears it. Returns false (and creates nothing) when no boundary
 * would catch it — an uncaught render-effect error would halt reactivity,
 * which an event failure must never do.
 */
function reportBlockError(owner: Owner | null, error: unknown): boolean {
  if (!owner || !hasErrorBoundary(owner)) return false;
  let delivered = false;
  runWithOwner(owner, () => {
    effect(
      () => {
        if (!delivered) {
          delivered = true;
          throw error;
        }
      },
      () => {}
    );
  });
  return true;
}

function hasErrorBoundary(owner: Owner): boolean {
  let queue: any = owner._queue;
  while (queue) {
    if (queue._collectionType & STATUS_ERROR) return true;
    queue = queue._parent;
  }
  return false;
}

// --- $ ---------------------------------------------------------------------------------

/**
 * A strict marked callback: `$(fn)` with an ordinary (non-generator) arrow or
 * function expression. The marker is a *compile-time* request — the
 * compiler analyzes `fn` for the host that consumes it (`createMemo`,
 * `createSignal(fn)`, `createEffect` / `createRenderEffect` compute, a DOM
 * `on*` attribute), records its graph in a sidecar summary, and erases the
 * marker, so the host receives the ordinary callback. The brand only marks
 * the request: stock TypeScript cannot see the callback's reads, writes or
 * escapes, so the graph lives in the compiler / `solid-tsc` summary, never
 * in this type. Uncompiled, dev builds refuse the marker (`[STRICT_NOT_COMPILED]`).
 */
export type StrictCallback<Input, R> = ((input: Input) => R) & { readonly [STRICT]: true };

/**
 * Build a typed block from a generator body. See the module comment for the
 * contract. The compiler lowers `$(function* () { … yield* x … })` to
 * `$(function () { … perform(x) … })` — a body in call form that `$` runs
 * under the same strict scope and host checks — so compiled output has no
 * generator cost.
 *
 * With a non-generator callback, `$` is the strict compilation marker
 * (`StrictCallback`): compiled away by `@solidjs/compiler`; refused at
 * runtime in dev when it was not compiled.
 */
// `Input` is inferred from the body's parameter only (`NoInfer` keeps the
// host's contextual compute type from pinning it), so a parameterless body
// stays usable by every host.
export function $<Input, Y extends Op, R>(
  body: (input: Input) => Generator<Y, R, any>
): Block<R, ReadsOf<Y>, TasksOf<Y>, FailuresOf<Y>, WritesOf<Y>, NoInfer<Input>>;
// The marker form. A generator body that is not a block (a bare `yield`, an
// async generator) is not a strict callback either: the parameter type
// collapses to `never` so the argument is refused. `NoInfer` keeps the
// host's contextual compute type from pinning `Input` (as above), so the
// event parameter of a handler is annotated at the callback.
export function $<Input, R>(
  body: ((input: Input) => R) &
    ([R] extends [Generator<any, any, any> | AsyncGenerator<any, any, any>] ? never : unknown)
): StrictCallback<NoInfer<Input>, R>;
export function $(body: (input: any) => any): AnyBlock | StrictCallback<any, any> {
  if (__DEV__ && typeof body === "function" && (body as any).prototype === undefined) {
    // Arrow functions and async functions have no `prototype`; generator
    // functions and the compiler's lowered `function` bodies do. A marker
    // reaching the runtime was not compiled: it must never run under the
    // generator driver or as a plain block, so fail loudly.
    throw new TypeError(
      "[STRICT_NOT_COMPILED] `$` received a plain (arrow or async) callback at runtime. A non-generator callback is a strict compilation marker: @solidjs/compiler analyzes it for its host and erases the marker. Compile the module with the Solid compiler (`generators` on), or write a generator block (`$(function* () { … })`)"
    );
  }
  // Zero-arity on purpose: renderers and `flatten` unwrap a function child
  // only when `fn.length === 0` (an accessor), so a block returned from a
  // component must look like one. The input still arrives as the first
  // argument (`prev`, or the event).
  const block = function (...args: unknown[]) {
    const host = pendingHost === -1 ? REACTIVE : pendingHost;
    pendingHost = -1;
    const prevHost = currentHost;
    currentHost = host;
    const prevGuard = setBlockGuard(true);
    const prevTokens = liveTokens;
    const tokens: TokenTarget[] = (liveTokens = []);
    try {
      const result = body(args[0]);
      if (isAsyncIterator(result)) throw asyncGeneratorError();
      const value = isSyncIterator(result) ? drive(result, host) : result;
      checkTokens(tokens);
      return value;
    } finally {
      liveTokens = prevTokens;
      setBlockGuard(prevGuard);
      currentHost = prevHost;
    }
  } as unknown as AnyBlock;
  (block as any)[BLOCK] = true;
  (block as any)[BODY] = body;
  (block as any)[OWNER] = getOwner();
  (block as any)[Symbol.iterator] = function* () {
    return yield* blockGenerator(block, undefined);
  };
  return block;
}

/** Delegation: run the block's body inside the caller's generator frame. */
function* blockGenerator(block: AnyBlock, input: unknown): Generator<Op, unknown, any> {
  const result = (block as any)[BODY](input);
  if (isAsyncIterator(result)) throw asyncGeneratorError();
  return isSyncIterator(result) ? yield* result : result;
}

/**
 * Execute one yielded operation in call form under the current host. This
 * is what the compiler emits for `yield* x` inside a lowered block; the
 * runtime driver executes the same operations the same way, so the two
 * modes agree. Async operations cannot be performed in call form: the
 * compiler leaves blocks that wait to the runtime driver, and an async op
 * that reaches `perform` (through a variable the compiler could not see
 * through) fails loudly.
 */
export function perform<T>(target: SourceAccessor<T>): T;
export function perform<B extends AnyBlock>(target: B | CallOp<B>): BlockValue<B>;
export function perform<T>(
  target: ReadOp<SourceAccessor<T>> | StoreReadOp<any, T> | AttemptOp<T, any>
): T;
export function perform<R, P extends readonly PathKey[]>(
  target: StoreRead<R, P> | PropRead<R, P>
): PathResult<R, P>;
export function perform<S extends AnySetter>(target: WriteOp<S>): ReturnType<S>;
export function perform(target: RaiseOp<any> | AsyncOp<any, any>): never;
export function perform(target: unknown): unknown {
  if (typeof target === "function") {
    if ((target as any)[BLOCK]) return delegateSync(target as AnyBlock, undefined);
    return readGuarded(target as () => unknown);
  }
  // A lowered bare identifier that holds a path token (`const u = store.user;
  // yield* u`): perform the path read.
  const token = tokenOf(target);
  if (token) {
    consume(token);
    return readGuarded(() => readThrough(walk(token.root, token.path)));
  }
  if (isOp(target)) {
    checkHost(currentHost, target[OP]);
    switch (target[OP]) {
      case "read":
        return readGuarded(target.source);
      case "attempt":
        return readGuarded(target.run);
      case "write":
        return readGuarded(() => target.target(target.value));
      case "call":
        return delegateSync(target.block, target.input);
      case "raise":
        throw target.error;
      case "wait":
        throw new TypeError(
          "[ASYNC_OP_OUTSIDE_DRIVER] `wait` can only be performed by the generator driver. Keep `yield* wait(...)` inline in the block so the compiler leaves it to the runtime"
        );
    }
  }
  throw invalidYield(target);
}

/** Call-form delegation: the callee runs under the caller's host. */
function delegateSync(block: AnyBlock, input: unknown): unknown {
  const value = readGuarded(() => runBlockAs(currentHost, block, input));
  if (isThenableValue(value)) {
    throw new TypeError(
      "[ASYNC_BLOCK_OUTSIDE_DRIVER] A block that waits can only be delegated to from a generator block (`yield* block`); it cannot be lowered to call form"
    );
  }
  return value;
}

function checkHost(host: Host, kind: Op[typeof OP]): void {
  if (host === JSX && kind !== "read" && kind !== "call") {
    throw new Error(
      `[OP_NOT_ALLOWED_IN_JSX] A block rendered as JSX may only read signals; \`${kind}\` belongs in a reactive computation or an event block (host: ${HOST_NAMES[host]})`
    );
  }
  if (host === REACTIVE && kind === "write") {
    throw new Error(
      "[WRITE_IN_REACTIVE_BLOCK] A reactive computation may not write; move the write into an event block or the effect phase (host: reactive)"
    );
  }
}

// --- driver -----------------------------------------------------------------------------

interface RunState {
  host: Host;
  /** Set by the owner's cleanup: a later run superseded this one. */
  stale: boolean;
  /** The block has suspended at least once; later reads are untracked. */
  waited: boolean;
}

function drive<R>(iterator: Generator<Op, R, any>, host: Host): R | Promise<R> {
  const state: RunState = { host, stale: false, waited: false };
  // A superseding run (recompute) or disposal marks this run stale; its
  // pending continuation then closes the generator instead of resuming.
  if (getOwner()) cleanup(() => (state.stale = true));
  return step(iterator, iterator.next(), state);
}

function step<R>(
  iterator: Generator<Op, R, any>,
  result: IteratorResult<Op, R>,
  state: RunState
): R | Promise<R> {
  for (;;) {
    if (result.done) return result.value;
    const op = result.value;
    if (!isOp(op)) throw invalidYield(op);
    if (op[OP] === "call") throw invalidYield(op);
    if (!op.delegated) {
      throw new TypeError(
        "[PLAIN_YIELD_IN_BLOCK] Operations must be yielded with `yield*` (e.g. `yield* wait(p)`), not `yield`"
      );
    }
    op.delegated = false;
    checkHost(state.host, op[OP]);
    switch (op[OP]) {
      case "read":
        if (state.waited) {
          throw new Error(
            "[READ_AFTER_WAIT] A signal was read after the block's first `yield* wait(...)`. Reads after a suspension are not tracked; read every signal before the first wait"
          );
        }
        result = settle(iterator, op.source);
        continue;
      case "attempt":
        result = settle(iterator, op.run);
        continue;
      case "write": {
        const { target, value } = op;
        result = settle(iterator, () => target(value));
        continue;
      }
      case "raise":
        result = iterator.throw(op.error);
        continue;
      case "wait":
        state.waited = true;
        return Promise.resolve(op.promise).then(
          value => resume(iterator, state, () => iterator.next(value)),
          error => resume(iterator, state, () => iterator.throw(error))
        );
    }
  }
}

/** Run one read/attempt/write outside the guard and feed its outcome back. */
function settle<R>(iterator: Generator<Op, R, any>, run: () => unknown): IteratorResult<Op, R> {
  let value: unknown;
  try {
    value = readGuarded(run);
  } catch (error) {
    // The operation's error is the yield's error: the generator's `finally`
    // blocks run, and an uncaught error leaves through the driver. A read of
    // an errored source arrives in Solid's status wrapper; the block sees
    // the typed error itself, as a boundary would.
    return iterator.throw(unwrapStatusError(error));
  }
  return iterator.next(value);
}

function resume<R>(
  iterator: Generator<Op, R, any>,
  state: RunState,
  advance: () => IteratorResult<Op, R>
): R | Promise<R> {
  if (state.stale) {
    // Cancellation: close the generator (its `finally` blocks run) and let
    // the superseded promise reject — the owner already moved on and
    // ignores superseded flights.
    iterator.return(undefined as R);
    throw new Error("[BLOCK_SUPERSEDED] This block run was superseded before its wait settled");
  }
  const prevHost = currentHost;
  currentHost = state.host;
  const prevGuard = setBlockGuard(true);
  const prevTokens = liveTokens;
  const tokens: TokenTarget[] = (liveTokens = []);
  try {
    const value = step(iterator, advance(), state);
    checkTokens(tokens);
    return value;
  } finally {
    liveTokens = prevTokens;
    setBlockGuard(prevGuard);
    currentHost = prevHost;
  }
}

/** Perform one operation with the strict guard lowered around it (every
 * tier: the store proxy answers a raised guard with a path token). */
function readGuarded<T>(run: () => T): T {
  const prevGuard = setBlockGuard(false);
  try {
    return run();
  } finally {
    setBlockGuard(prevGuard);
  }
}

function isOp(value: unknown): value is Op {
  return value !== null && typeof value === "object" && OP in value;
}

// Shape probes on a block's result. A result may be a store proxy (a
// selector that returns the store itself), whose `has`/`get` traps are
// tracked reads: probe untracked and with the strict guard lowered, exactly
// as the core's `handleAsync` probes a computation's result — the probe is
// not a dependency of the block.
function probe<T>(run: () => T): T {
  return readGuarded(() => untrack(run));
}

function isSyncIterator(value: unknown): value is Generator<Op, unknown, any> {
  return (
    value !== null &&
    typeof value === "object" &&
    probe(
      () =>
        typeof (value as Partial<Generator>).next === "function" &&
        typeof (value as any)[Symbol.iterator] === "function" &&
        !(Symbol.asyncIterator in value)
    )
  );
}

function isAsyncIterator(value: unknown): boolean {
  return value !== null && typeof value === "object" && probe(() => Symbol.asyncIterator in value);
}

function isThenableValue(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    probe(() => typeof (value as any).then === "function")
  );
}

function asyncGeneratorError(): TypeError {
  return new TypeError(
    "[ASYNC_GENERATOR] `$` does not accept async generators (`await` is not allowed in a block); suspend with `yield* wait(promise)` instead"
  );
}

function invalidYield(value: unknown): TypeError {
  if (typeof value === "function") {
    return new TypeError(
      "[PLAIN_YIELD_IN_BLOCK] Signals and blocks must be delegated to with `yield*`, not `yield`"
    );
  }
  if (value !== null && typeof value === "object" && Symbol.asyncIterator in value) {
    return asyncGeneratorError();
  }
  if (isOp(value) && value[OP] === "call") {
    return new TypeError("[PLAIN_YIELD_IN_BLOCK] `call(...)` must be delegated to with `yield*`");
  }
  return new TypeError(
    `[INVALID_YIELD] \`$\` blocks may only yield operations (\`yield* signal\`, \`yield* wait(...)\`, \`yield* raise(...)\`, \`yield* attempt(...)\`, \`yield* write(...)\`, \`yield* call(...)\`, \`yield* block\`); received ${describe(value)}`
  );
}

function describe(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "object") {
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    return tag === "Object" ? "an object" : `a ${tag}`;
  }
  return type === "undefined" ? "undefined" : `a ${type}`;
}
