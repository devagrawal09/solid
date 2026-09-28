import { markAsyncCapability } from "./core/dev.js";
import { STATUS_ERROR } from "./core/constants.js";
import { unwrapStatusError } from "./core/error.js";
import { blockGuard } from "./core/core.js";
import { flush } from "./core/scheduler.js";
import {
  cleanup,
  createOwner,
  effect,
  getOwner,
  idScopeEndCount,
  reserveIdScope,
  runInIdScope,
  runWithOwner,
  setBlockGuard,
  trackedEffect,
  untrack,
  type Owner
} from "./core/index.js";
import { installGeneratorHook, type SourceAccessor } from "./signals.js";
import { installBlockRenderer } from "./block-hooks.js";

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
 *   yield* attempt(() => p, ...Errs) Tasks  async suspension (declared errs → Failures)
 *   yield* raise(error)           Failures   typed throw
 *   yield* attempt(fn, ...Errs)   Failures   typed fallible call
 *   yield* set(value)             Writes     a v2 setter's receipt (`$signal` / `$store`)
 *   yield* otherBlock             (delegation: the callee's categories)
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
 *   generators, reads after the first suspension, and host-inadmissible
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
 * Typed writes are `yield* set(updater)` with a `$store` setter; plain store
 * setters stay ordinary calls.
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
/** @internal Brand of a component's view: `yield*` on it evaluates to the view. */
export const VIEW: unique symbol = Symbol("view");
/** The block's body, for delegation with an input (`call`). */
const BODY: unique symbol = Symbol("block-body");
/** The owner in scope when the block was created (its defining component). */
const OWNER: unique symbol = Symbol("block-owner");
/** Compiler-emitted metadata flags (`$(body, flags)`). */
const FLAGS: unique symbol = Symbol("block-flags");

/**
 * Block metadata flags. Each is a proof the compiler established about the
 * lowered body from local facts (see the compiler's `block_proofs`); the
 * runtime trusts a flag in production and verifies it in development.
 */
/** The body is in call form and its result is a plain value: never a
 * generator, a thenable or an async iterable. `$` skips its result-shape
 * probes; a reactive host may run the block on the `sync: true` path. */
export const BLOCK_SYNC = 1;
/** The body never raises a reactive status: no `raise` / `attempt`, no read
 * of a source that can be pending or errored, no unknown call. A reactive
 * host may run the block on the status-free path (`noThrow: true`). */
export const BLOCK_NOTHROW = 2;

/** The metadata flags a block was created with (0 for an unannotated block,
 * or for a value that is not a block). */
export function blockFlags(value: unknown): number {
  return typeof value === "function" ? ((value as any)[FLAGS] ?? 0) : 0;
}
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
/** A value read through when readable: a block's value, an accessor's value, else itself. */
export type ReadThrough<V> = V extends AnyBlock
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
/** An async `yield* attempt(() => promise)` — suspends the block (a Task). */
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
/** A typed write: what a v2 setter's receipt yields (`yield* set(value)`). */
export interface WriteOp<S extends AnySetter = AnySetter> {
  readonly [OP]: "write";
  readonly target: S;
  readonly value: Parameters<S>[0];
  delegated: boolean;
  [Symbol.iterator](): Generator<WriteOp<S>, ReturnType<S>, any>;
}
/** @internal Block delegation with an input (type-level; no public constructor). */
export interface CallOp<B extends AnyBlock> {
  readonly [OP]: "call";
  readonly block: B;
  readonly input: BlockInput<B>;
  [Symbol.iterator](): Generator<BlockOps<B>, BlockValue<B>, any>;
}
/**
 * `yield* $signal(v)` / `$store` / `$memo` / `$effect` — create owned state in
 * a component's setup (generator blocks v2). The driver runs `make` under the
 * component's owner and resumes with its result.
 */
export interface CreateOp<V = unknown, K extends string = string> {
  readonly [OP]: "create";
  readonly kind: K;
  readonly make: () => V;
  delegated: boolean;
  [Symbol.iterator](): Generator<CreateOp<V, K>, V, any>;
}
/** `yield* $cleanup(fn)` — register a cleanup on the running component or effect. */
export interface CleanupOp {
  readonly [OP]: "cleanup";
  readonly fn: () => void;
  delegated: boolean;
  [Symbol.iterator](): Generator<CleanupOp, void, any>;
}
/** `yield* Ctx` — read a context in a component's setup. */
export interface ContextOp<T = unknown, C = unknown> {
  readonly [OP]: "context";
  readonly context: C;
  readonly read: () => T;
  delegated: boolean;
  [Symbol.iterator](): Generator<ContextOp<T, C>, T, any>;
}
/** `yield* $flush()` — drain pending writes synchronously (event blocks only). */
export interface FlushOp {
  readonly [OP]: "flush";
  delegated: boolean;
  [Symbol.iterator](): Generator<FlushOp, void, any>;
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
  | CallOp<any>
  | CreateOp<any, any>
  | CleanupOp
  | ContextOp<any, any>
  | FlushOp;

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
/** Phantom brand of a typed (`$store`) store: the value it holds. */
declare const STORE_VALUE: unique symbol;
export interface StoreValueBrand<T> {
  readonly [STORE_VALUE]: T;
}
// A `$store` store (`TypedStore<T>`): the selector sees the plain value.
export function readStore<T, R>(
  store: StoreValueBrand<T>,
  selector: (state: T) => R
): StoreReadOp<T & object, R>;
export function readStore<S extends object, R>(
  store: S,
  selector: (state: S) => R
): StoreReadOp<S, R>;
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
/**
 * Tokens created during the running block runs (unread = error), innermost
 * run last: a run records where its tokens start (`tokenBase`, -1 outside
 * any run), checks from there and truncates back — no per-run allocation.
 */
const liveTokens: TokenTarget[] = [];
let tokenBase = -1;
/**
 * Every token proxy → its target. Answers "is this a token" without touching
 * the value: probing a store proxy for the brand was a full `get` trap (plus
 * a guard/untrack bracket) on every path read and `readStore` root, and a
 * foreign proxy must never be probed at all. `tokensCreated` keeps the
 * lookup off every read of an app whose compiled blocks never alias a path.
 */
const tokenTargets = new WeakMap<object, TokenTarget>();
let tokensCreated = false;

/**
 * @internal What a store proxy's `get` trap calls while the strict guard is
 * raised. Installed by the first `$` block (the guard is only ever raised by
 * a block run), so a bundle that never builds a block — a plain store app —
 * does not retain the token machinery and, through it, `perform`.
 */
export let makePathToken: (root: object, key: PathKey) => object = noBlockRuntime;
function noBlockRuntime(): never {
  throw new Error("[NO_BLOCK_RUNTIME] the strict guard is raised but no `$` block was built");
}

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
  if (tokenBase !== -1) liveTokens.push(target);
  const token = new Proxy(target, tokenTraps);
  tokenTargets.set(token, target);
  tokensCreated = true;
  return token;
}

function consume(target: TokenTarget): void {
  for (let node: TokenTarget | null = target; node !== null && !node.used; node = node.parent) {
    node.used = true;
  }
}

function tokenOf(value: unknown): TokenTarget | undefined {
  if (!tokensCreated || value === null || typeof value !== "object") return undefined;
  return tokenTargets.get(value);
}

function describePath(target: TokenTarget): string {
  return target.path.map(key => (typeof key === "number" ? `[${key}]` : `.${key}`)).join("");
}

function tokenMisuse(target: TokenTarget, how: string): Error {
  return new Error(
    __DEV__
      ? `[DIRECT_READ_IN_BLOCK] \`<root>${describePath(target)}\` was used ${how} inside a \`$\` block; read it with \`yield* <root>${describePath(target)}\``
      : "[DIRECT_READ_IN_BLOCK]"
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
function checkTokens(from: number): void {
  // Latest first: the deepest unread path names the whole access.
  for (let i = liveTokens.length - 1; i >= from; i--) {
    const target = liveTokens[i];
    if (!target.used) {
      throw new Error(
        __DEV__
          ? `[UNREAD_PATH] \`<root>${describePath(target)}\` was accessed inside a \`$\` block but never read with \`yield*\`; write \`yield* <root>${describePath(target)}\` (a bare access is a deferred token, not a value)`
          : "[UNREAD_PATH]"
      );
    }
  }
}

// --- proxy-free path walks ------------------------------------------------------
//
// A path read walks `root[k0][k1]…` with the strict guard lowered. The store
// module records every child target it serves and exposes the latest through
// `storeServed`; a hop whose value is that child — its proxy (a proxy has one
// target, so the identity is exact) or the target itself (only a handle-mode
// read hands a target out) — runs the store's `get` trap on the target as a
// plain call in handle mode (`storeGet`), which hands the next child back as
// its target. So a compiled `yield* store.a.b.c` pays one Proxy [[Get]] (the
// root's first key; none from a handle root), allocates nothing, and never
// materializes a child proxy unless the walk ends on that child
// (`handleValue`) or a getter needs a receiver.
//
// Anything else — a proxy root, a props object, a raw or raw-marked object,
// a foreign proxy (merge/omit, the SSR pending store), a primitive — takes
// the ordinary `value[key]`, exactly the access a proxy walk makes; when that
// is itself a store trap, the child it serves is resolved for the next hop.
// Numeric keys are coerced as a Proxy coerces them (ToPropertyKey of a number
// is its string); any other key type goes through the proxy. Only the readers
// reference `hop`; a store-only app keeps just the setter below.

/** Structural view of a store target the walk touches (store/next/target.ts). */
interface ServedTarget {
  px: any;
}
interface StoreHooks {
  /** The `get` trap; called with `handleReceiver` it is a handle-mode read
   * (a wrapped child comes back as its target). */
  get(target: ServedTarget, key: PropertyKey, receiver: any): any;
  /** The receiver that selects handle mode. */
  handleReceiver: object;
  /** The child target most recently served, or null. */
  served(): ServedTarget | null;
  /** A target's compatibility proxy, materialized on first need. */
  proxy(target: ServedTarget): any;
}
// Unpacked into module variables: the hot hop calls them directly.
let storeGet: StoreHooks["get"] = plainGet;
let handleReceiver: object | undefined;
let storeServed: StoreHooks["served"] = noneServed;
let storeProxyOf: StoreHooks["proxy"] = plainGet as any;
let storeHooks: StoreHooks | null = null;

function plainGet(value: any, key?: any): any {
  return value[key];
}
function noneServed(): null {
  return null;
}

/** @internal Installed once by the store module. */
export function setStoreHooks(hooks: StoreHooks): void {
  storeHooks = hooks;
  storeGet = hooks.get;
  handleReceiver = hooks.handleReceiver;
  storeServed = hooks.served;
  storeProxyOf = hooks.proxy;
}

/** A hop of a walk from a proxy (or any non-handle) root — the stage-1
 * readers: children come back as PROXIES (they already have them), so the
 * walk never hands a target out. */
function hop(value: any, key: any): any {
  const t = storeServed();
  if (t !== null && value !== null && (value === t.px || value === t)) {
    // (`value === t` never happens in compiled code — handles only reach the
    // handle readers — but a target must never leak: read it as its proxy.)
    const receiver = value === t ? storeProxyOf(t) : value;
    if (typeof key === "string") return storeGet(t, key, receiver);
    if (typeof key === "number") return storeGet(t, "" + key, receiver);
  }
  return value[key];
}

/** A hop of a walk from a HANDLE: children come back as targets (no proxy
 * is materialized); `handleValue` converts the walk's final value. */
function hhop(value: any, key: any): any {
  const t = storeServed();
  if (t !== null && (value === t || (value !== null && value === t.px))) return handleHop(t, key);
  return value[key];
}

/** One hop off a store target (a served child or a handle root). */
function handleHop(t: ServedTarget, key: any): any {
  if (typeof key === "string") return storeGet(t, key, handleReceiver);
  if (typeof key === "number") return storeGet(t, "" + key, handleReceiver);
  return storeProxyOf(t)[key];
}

/** The public value a finished walk hands out: a child target the last hop
 * served becomes its proxy (materialized here if the walk created it). */
function handleValue(value: any): any {
  const t = storeServed();
  return t !== null && value === t ? storeProxyOf(t) : value;
}

/** The proxy walk: what the runtime driver's path tokens and `readPath`
 * operations perform (uncompiled blocks). Deliberately not the handle walk:
 * tokens are reachable from every store bundle (the store trap creates
 * them), and keeping `hop` off that path lets a store-only app drop it. */
function walk(root: unknown, path: readonly PathKey[]): unknown {
  let value: any = root;
  for (const key of path) value = value[key];
  return value;
}

/** A walk from a proxy (or any non-handle) root: `readPathN`. Such a walk
 * never produces a target (children come back as proxies), so it needs no
 * `handleValue`. */
function walkProxies(root: unknown, path: readonly PathKey[]): unknown {
  let value: any = root;
  for (let i = 0, n = path.length; i < n; i++) value = hop(value, path[i]);
  return value;
}

/** A walk that may run in handle mode, from `start` in `path`. */
function walkHandles(root: unknown, path: readonly PathKey[], start = 0): unknown {
  let value: any = root;
  for (let i = start, n = path.length; i < n; i++) value = hhop(value, path[i]);
  return handleValue(value);
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
  // A forwarded prop read (`Child({ id: props.id })` in a v2 component)
  // arrives as the parent's read operation: perform it.
  if (isOp(value) && value[OP] === "read") return readThrough(value.source());
  return typeof value === "function" &&
    ((value as any)[BLOCK] || Symbol.iterator in (value as object))
    ? readFunction(value)
    : value;
}

/**
 * `perform` of a readable function found at a path (`readThrough`): an
 * accessor is read, a view is a value, a block is delegated to under the
 * current host, and any other iterable function — a context provider — is
 * stepped, each operation it yields performed as the driver would.
 *
 * Deliberately not `perform` itself, so the path readers (in every compiled
 * block app) do not retain the generic dispatch: the one difference is that
 * an iterable that yields something other than an operation fails with
 * `[INVALID_YIELD]` here — the driver's verdict for the same iterable —
 * where `perform` would dispatch on the yielded value.
 */
function readFunction(target: any): unknown {
  if (target[Symbol.iterator] === accessorIterator) {
    return blockGuard ? readGuarded(target) : target();
  }
  if (target[VIEW]) return target;
  if (target[BLOCK]) return delegateSync(target as AnyBlock, undefined);
  if (ownIterator(target)) {
    const it = target[Symbol.iterator]() as Iterator<unknown>;
    let step = it.next();
    while (!step.done) {
      const op = step.value as Op;
      if (!isOp(op)) throw invalidYield(op);
      const kind = op[OP];
      // A read or a context read (a context provider yields one): the
      // operation switch's own cases. Any other operation was built by a
      // constructor that installed the switch (`performFound`).
      step = it.next(
        kind === "read" || kind === "context"
          ? (checkHost(currentHost, kind),
            readGuarded(kind === "read" ? (op as ReadOp<() => unknown>).source : (op as any).read))
          : performFound!(op)
      );
    }
    return step.value;
  }
  return readGuarded(target);
}

/**
 * The operation switch (`performOp`) for iterables `readFunction` steps,
 * installed by every constructor of an operation other than a read or a
 * context read (`raise`, `attempt`, the v2 creations, `$cleanup`, `$flush`):
 * such an operation exists only once its constructor ran, and a bundle that
 * calls none of them — a fully compiled app, whose only iterables at a path
 * are context providers — does not retain the switch through the path
 * readers.
 */
let performFound: ((op: Op) => unknown) | undefined;
/** @internal See `performFound`. */
export function usePerformOp(): void {
  performFound = performOp;
}

/**
 * `perform(readPath(root, keys))` for a root that is a path token (`const u
 * = store.user` in a block body, then `yield* u.name`): the token is
 * consumed and its prefix prepended, the host admits the read, and the walk
 * runs with the guard lowered — without `perform`'s dispatch.
 */
function readTokenPath(root: unknown, keys: readonly PathKey[]): unknown {
  const op = pathRead(root, keys, "store", false) as ReadOp<() => unknown>;
  checkHost(currentHost, "read");
  return readGuarded(op.source);
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

// --- lowered path readers ----------------------------------------------------------
//
// What the compiler emits for `yield* root.a.b` (store and prop paths alike —
// the runtime read is the same; only the typecheck projection's phantom
// `StoreRead` / `PropRead` differ): one call, no operation object, no path
// array, no closure, no token probe. Each is exactly `perform(readPath(root,
// [keys]))`: the walk runs with the strict guard lowered, reads through an
// accessor or block found at the path (`readThrough`), and a root that is a
// path token (`const u = store.user` inside the body) takes the operation
// path so the token is consumed and its prefix prepended. A `read` is
// admitted by every host, so no host check applies. Fixed arities cover the
// common depths without an argument array; `readPathN` takes the keys as an
// array (the compiler hoists all-literal key arrays to module constants).

// A `$component`'s typed props (a proxy whose keys are prop reads): a lowered
// path read walks the raw props, so `yield* props.todo.id` is one walk.
let typedPropsCreated = false;
const typedPropsTargets = new WeakMap<object, object>();
/** @internal Register a typed-props proxy and the props it wraps. */
export function registerTypedProps(proxy: object, target: object): void {
  typedPropsCreated = true;
  typedPropsTargets.set(proxy, target);
}
function propsTarget(root: any): any {
  return (root !== null && typeof root === "object" && typedPropsTargets.get(root)) || root;
}

/** `yield* root[k0]`, lowered. */
export function readPath1<R, const K0 extends PathKey>(root: R, k0: K0): PathResult<R, [K0]>;
export function readPath1(root: any, k0: PathKey): any {
  if (typedPropsCreated) root = propsTarget(root);
  if (tokensCreated && isToken(root)) return readTokenPath(root, [k0]);
  if (!blockGuard) return readThrough(hop(root, k0));
  const prev = setBlockGuard(false);
  try {
    return readThrough(hop(root, k0));
  } finally {
    setBlockGuard(prev);
  }
}

/** `yield* root[k0][k1]`, lowered. */
export function readPath2<R, const K0 extends PathKey, const K1 extends PathKey>(
  root: R,
  k0: K0,
  k1: K1
): PathResult<R, [K0, K1]>;
export function readPath2(root: any, k0: PathKey, k1: PathKey): any {
  if (typedPropsCreated) root = propsTarget(root);
  if (tokensCreated && isToken(root)) return readTokenPath(root, [k0, k1]);
  if (!blockGuard) return readThrough(hop(hop(root, k0), k1));
  const prev = setBlockGuard(false);
  try {
    return readThrough(hop(hop(root, k0), k1));
  } finally {
    setBlockGuard(prev);
  }
}

/** `yield* root[k0][k1][k2]`, lowered. */
export function readPath3<
  R,
  const K0 extends PathKey,
  const K1 extends PathKey,
  const K2 extends PathKey
>(root: R, k0: K0, k1: K1, k2: K2): PathResult<R, [K0, K1, K2]>;
export function readPath3(root: any, k0: PathKey, k1: PathKey, k2: PathKey): any {
  if (typedPropsCreated) root = propsTarget(root);
  if (tokensCreated && isToken(root)) return readTokenPath(root, [k0, k1, k2]);
  if (!blockGuard) return readThrough(hop(hop(hop(root, k0), k1), k2));
  const prev = setBlockGuard(false);
  try {
    return readThrough(hop(hop(hop(root, k0), k1), k2));
  } finally {
    setBlockGuard(prev);
  }
}

/** `yield* root[k0][k1][k2][k3]`, lowered. */
export function readPath4<
  R,
  const K0 extends PathKey,
  const K1 extends PathKey,
  const K2 extends PathKey,
  const K3 extends PathKey
>(root: R, k0: K0, k1: K1, k2: K2, k3: K3): PathResult<R, [K0, K1, K2, K3]>;
export function readPath4(root: any, k0: PathKey, k1: PathKey, k2: PathKey, k3: PathKey): any {
  if (typedPropsCreated) root = propsTarget(root);
  if (tokensCreated && isToken(root)) return readTokenPath(root, [k0, k1, k2, k3]);
  if (!blockGuard) return readThrough(hop(hop(hop(hop(root, k0), k1), k2), k3));
  const prev = setBlockGuard(false);
  try {
    return readThrough(hop(hop(hop(hop(root, k0), k1), k2), k3));
  } finally {
    setBlockGuard(prev);
  }
}

/** `yield* root[k0]…[kn]`, lowered: any depth, keys as an array (never retained). */
export function readPathN<R, const P extends readonly PathKey[]>(
  root: R,
  keys: P
): PathResult<R, P>;
export function readPathN(root: any, keys: readonly PathKey[]): any {
  if (typedPropsCreated) root = propsTarget(root);
  if (tokensCreated && isToken(root)) return readTokenPath(root, keys);
  if (!blockGuard) return readThrough(walkProxies(root, keys));
  const prev = setBlockGuard(false);
  try {
    return readThrough(walkProxies(root, keys));
  } finally {
    setBlockGuard(prev);
  }
}

// --- store handles (Track B slice 2, stage 2) ----------------------------------------
//
// A store HANDLE is the store's internal target (or, for a root that is not
// a store — a raw-marked value — a `PlainHandle`). Compiled code holds one
// where the compiler proved the store's uses are path reads it lowers and
// compiled consumers (see documentation/plans/track-b-slice-2-proxy-free-
// stores.md): `createStoreHandle` creates the store without its proxy,
// `readHandleK` walks from it with no Proxy [[Get]] at all, and every other
// use goes through `storeProxy`, which materializes the compatibility proxy
// on first escape. Handles are opaque to user code (`StoreHandle<T>`).

declare const STORE_HANDLE: unique symbol;
/** An opaque compiled-code reference to a store (see `createStoreHandle`). */
export interface StoreHandle<T> {
  readonly [STORE_HANDLE]: T;
}
/**
 * Typed escape contract for a component prop: the component only reads
 * typed paths from it (`yield* props.todo.title`) and never lets it escape.
 * The type is `T` itself (callers pass stores as usual); the compiler
 * verifies the contract in the component's body and, where it holds, lets
 * compiled callers pass a store handle instead of a proxy. A violated
 * contract deoptimizes to ordinary proxies and is reported in the module's
 * store summary.
 */
export type Borrowed<T> = T;

/** Every handle handed out: the `Borrowed` prop readers must tell a handle
 * from any other value without touching it (a proxy's traps are observable). */
const handles = new WeakSet<object>();

/** @internal Record a handle (store module / child handles). */
export function markHandle<H extends object>(handle: H): H {
  handles.add(handle);
  return handle;
}

function isHandle(value: unknown): value is ServedTarget {
  return value !== null && typeof value === "object" && handles.has(value);
}

/** A handle is a store target unless it wraps a non-store root (`{ v }`, no `px`). */
function plainValueOf(handle: any): any {
  return handle.px === undefined ? handle.v : handle;
}

/** `yield* store[k0]` from a handle root, lowered. */
export function readHandle1<T, const K0 extends PathKey>(
  handle: StoreHandle<T>,
  k0: K0
): PathResult<T, [K0]>;
export function readHandle1(handle: any, k0: PathKey): any {
  if (handle.px === undefined) return readPath1(handle.v, k0);
  if (!blockGuard) return readThrough(handleValue(handleHop(handle, k0)));
  const prev = setBlockGuard(false);
  try {
    return readThrough(handleValue(handleHop(handle, k0)));
  } finally {
    setBlockGuard(prev);
  }
}

/** `yield* store[k0][k1]` from a handle root, lowered. */
export function readHandle2<T, const K0 extends PathKey, const K1 extends PathKey>(
  handle: StoreHandle<T>,
  k0: K0,
  k1: K1
): PathResult<T, [K0, K1]>;
export function readHandle2(handle: any, k0: PathKey, k1: PathKey): any {
  if (handle.px === undefined) return readPath2(handle.v, k0, k1);
  if (!blockGuard) return readThrough(handleValue(hhop(handleHop(handle, k0), k1)));
  const prev = setBlockGuard(false);
  try {
    return readThrough(handleValue(hhop(handleHop(handle, k0), k1)));
  } finally {
    setBlockGuard(prev);
  }
}

/** `yield* store[k0][k1][k2]` from a handle root, lowered. */
export function readHandle3<
  T,
  const K0 extends PathKey,
  const K1 extends PathKey,
  const K2 extends PathKey
>(handle: StoreHandle<T>, k0: K0, k1: K1, k2: K2): PathResult<T, [K0, K1, K2]>;
export function readHandle3(handle: any, k0: PathKey, k1: PathKey, k2: PathKey): any {
  if (handle.px === undefined) return readPath3(handle.v, k0, k1, k2);
  if (!blockGuard) return readThrough(handleValue(hhop(hhop(handleHop(handle, k0), k1), k2)));
  const prev = setBlockGuard(false);
  try {
    return readThrough(handleValue(hhop(hhop(handleHop(handle, k0), k1), k2)));
  } finally {
    setBlockGuard(prev);
  }
}

/** `yield* store[k0][k1][k2][k3]` from a handle root, lowered. */
export function readHandle4<
  T,
  const K0 extends PathKey,
  const K1 extends PathKey,
  const K2 extends PathKey,
  const K3 extends PathKey
>(handle: StoreHandle<T>, k0: K0, k1: K1, k2: K2, k3: K3): PathResult<T, [K0, K1, K2, K3]>;
export function readHandle4(handle: any, k0: PathKey, k1: PathKey, k2: PathKey, k3: PathKey): any {
  if (handle.px === undefined) return readPath4(handle.v, k0, k1, k2, k3);
  if (!blockGuard)
    return readThrough(handleValue(hhop(hhop(hhop(handleHop(handle, k0), k1), k2), k3)));
  const prev = setBlockGuard(false);
  try {
    return readThrough(handleValue(hhop(hhop(hhop(handleHop(handle, k0), k1), k2), k3)));
  } finally {
    setBlockGuard(prev);
  }
}

/** `yield* store[k0]…[kn]` from a handle root, lowered (keys never retained). */
export function readHandleN<T, const P extends readonly PathKey[]>(
  handle: StoreHandle<T>,
  keys: P
): PathResult<T, P>;
export function readHandleN(handle: any, keys: readonly PathKey[]): any {
  if (handle.px === undefined) return readPathN(handle.v, keys);
  if (keys.length === 0) return storeHandleProxy(handle);
  if (!blockGuard) return readThrough(walkHandles(handleHop(handle, keys[0]), keys, 1));
  const prev = setBlockGuard(false);
  try {
    return readThrough(walkHandles(handleHop(handle, keys[0]), keys, 1));
  } finally {
    setBlockGuard(prev);
  }
}

/**
 * A child HANDLE — what a compiled caller passes to a verified `Borrowed`
 * prop for `<Row todo={store.rows[i]} />`: the same tracked walk as the
 * member chain, ending on the child's target instead of its proxy (no read
 * through; a value that is not a store child is returned as is).
 */
export function readHandleChild<T, const P extends readonly PathKey[]>(
  handle: StoreHandle<T>,
  keys: P
): StoreHandle<PathValue<T, P>>;
export function readHandleChild(handle: any, keys: readonly PathKey[]): any {
  if (handle.px === undefined) return proxyWalk(handle.v, keys);
  const prev = setBlockGuard(false);
  try {
    let value: any = keys.length ? handleHop(handle, keys[0]) : handle;
    for (let i = 1; i < keys.length; i++) value = hhop(value, keys[i]);
    const t = storeServed();
    return t !== null && value === t ? markHandle(value) : value;
  } finally {
    setBlockGuard(prev);
  }
}

function proxyWalk(root: any, keys: readonly PathKey[]): any {
  const prev = setBlockGuard(false);
  try {
    return handleValue(walkHandlesRaw(root, keys));
  } finally {
    setBlockGuard(prev);
  }
}

function walkHandlesRaw(root: any, keys: readonly PathKey[]): any {
  let value = root;
  for (let i = 0; i < keys.length; i++) value = hhop(value, keys[i]);
  return value;
}

/**
 * `yield* props.todo.a.b` where `todo` is a verified `Borrowed` prop,
 * lowered: `props.todo` is read as usual (the tracked getter), then walked as
 * a handle when a compiled caller passed one, else exactly as `readPathN`
 * walks any value (an uncompiled caller's proxy, a plain object). `keys[0]`
 * is the prop name.
 */
export function readBorrowed<R, const P extends readonly PathKey[]>(
  props: R,
  keys: P
): PathResult<R, P>;
export function readBorrowed(props: any, keys: readonly PathKey[]): any {
  const prev = setBlockGuard(false);
  try {
    let value: any = props[keys[0]];
    if (isHandle(value)) {
      const root = plainValueOf(value);
      if (keys.length === 1) return readThrough(root === value ? storeProxyOf(value) : root);
      value = root === value ? handleHop(value, keys[1]) : hhop(root, keys[1]);
      return readThrough(walkHandles(value, keys, 2));
    }
    return readThrough(walkHandles(value, keys, 1));
  } finally {
    setBlockGuard(prev);
  }
}

/** The proxy (or plain value) behind a handle. */
function storeHandleProxy(handle: any): any {
  return handle.px === undefined ? handle.v : storeProxyOf(handle);
}

function isToken(value: unknown): boolean {
  return value !== null && typeof value === "object" && tokenTargets.has(value);
}

/**
 * The fused form of a lowered path read. With the compiler's `hostFusion`
 * option, a block that is the direct argument of a reactive host is erased
 * into the host's own compute function (`createMemo($(fn))` →
 * `createMemo(fn)`), and `perform(readPath(root, ["a", "b"]))` becomes
 * `readValue(root.a.b)`: the member chain is the tracked walk itself (inside
 * a computation the strict guard is down, so a store proxy answers with
 * values, not path tokens), and this keeps the one step the chain cannot
 * express — reading *through* a readable found at the path, an accessor or
 * a block, as `yield*` does on that value — under the reactive host the
 * erased block ran as. A block that waits cannot be read through in call
 * form (`[ASYNC_BLOCK_OUTSIDE_DRIVER]`). Not a use-site helper.
 */
export function readValue<V>(value: V): ReadThrough<V> {
  if (
    typeof value === "function" &&
    ((value as any)[BLOCK] || Symbol.iterator in (value as object))
  ) {
    // Between `runBlockAs` calls the pending host is unset, so a direct call
    // runs a block under the reactive host — exactly what `delegateSync` does
    // from a reactive block — and an accessor call is the tracked read
    // (`readGuarded` is a no-op with the guard already down).
    const result = (value as () => unknown)();
    if ((value as any)[BLOCK] && isThenableValue(result)) throw asyncBlockError();
    return result as ReadThrough<V>;
  }
  return value as ReadThrough<V>;
}

/** The typed replacement for `throw`: the error joins the failure union. */
export function raise<E>(error: E): RaiseOp<E> {
  performFound = performOp;
  return { [OP]: "raise", error, delegated: false, [Symbol.iterator]: opIterator } as any;
}

/**
 * Run `fn` as a typed step (a thin try/catch). A promise result suspends the
 * block until it settles — the async form, for memo and event blocks — and
 * resumes with its value, or with the rejection thrown at the `yield*`.
 *
 * Failures are *declared*: `attempt(fn, NotFound)` adds `NotFound` to the
 * block's failures; `attempt(fn)` declares none. Anything `fn` throws still
 * propagates at runtime (catch it with `try` / `catch`, and `yield*
 * raise(...)` a typed failure from the `catch` when it should be handled by
 * an `Errored`). The failure union is the set of declared failures, never a
 * proof that nothing else can throw.
 */
export function attempt<T, C extends ErrorClass<any>[] = []>(
  run: () => PromiseLike<T>,
  ...errors: C
): AsyncOp<T, C extends [] ? never : InstanceType<C[number]>>;
export function attempt<T, C extends ErrorClass<any>[] = []>(
  run: () => T,
  ...errors: C
): AttemptOp<T, C extends [] ? never : InstanceType<C[number]>>;
export function attempt(run: () => unknown, ..._errors: ErrorClass<any>[]): Op {
  performFound = performOp;
  return { [OP]: "attempt", run, delegated: false, [Symbol.iterator]: opIterator } as any;
}

// --- hosts ---------------------------------------------------------------------------

// Hosts. v2 names: memo = REACTIVE, view = JSX; COMPONENT is a component's
// setup, EFFECT a `$effect` / generator `createEffect` body.
/** @internal */
export const REACTIVE = 0;
/** @internal */
export const JSX = 1;
/** @internal */
export const EVENT = 2;
/** @internal */
export const COMPONENT = 3;
/** @internal */
export const EFFECT = 4;
/** @internal */
export type Host = typeof REACTIVE | typeof JSX | typeof EVENT | typeof COMPONENT | typeof EFFECT;
const HOST_NAMES = ["reactive", "jsx", "event", "component", "effect"] as const;

/** The host of the innermost running block. */
let currentHost: Host = REACTIVE;
/** The host the next block invocation runs under (set by a host wrapper). */
let pendingHost: Host | -1 = -1;

export function isBlock(value: unknown): value is AnyBlock {
  return typeof value === "function" && (value as any)[BLOCK] === true;
}

/** @internal Run a block under a host (the host decides which operations it admits). */
export function runBlockAs<B extends AnyBlock>(host: Host, block: B, input: unknown): unknown {
  pendingHost = host;
  try {
    return block(input);
  } finally {
    pendingHost = -1;
  }
}

/**
 * Where `$cleanup` registers: the owner (a component setup, a tracked
 * effect run), or — for the effect half of a split effect, which has no owner
 * of its own — the list the half returns as its cleanup.
 */
// `undefined`: not collecting (register on the owner); `null`: an effect
// half is collecting and has none yet; else the collected list. Lazy, so a
// half that registers nothing allocates nothing.
let cleanupSink: (() => void)[] | null | undefined = undefined;
function registerCleanup(fn: () => void): void {
  if (cleanupSink === undefined) cleanup(fn);
  else if (cleanupSink === null) cleanupSink = [fn];
  else cleanupSink.push(fn);
}
/**
 * @internal Compiled `yield* $cleanup(fn)`: exactly what `perform` does with
 * the cleanup operation (the compiler has already checked the host), without
 * the operation object and the dispatch.
 */
export function blockCleanup(fn: () => void): void {
  registerCleanup(fn);
}
/**
 * @internal Run the effect half of a split effect block: the body under the
 * effect host with the compute values as its input. Its `$cleanup`s become
 * the returned cleanup (the function itself when there is one).
 */
export function runEffectHalf(block: AnyBlock, values: unknown): (() => void) | undefined {
  const prev = cleanupSink;
  cleanupSink = null;
  let sink: (() => void)[] | null | undefined;
  try {
    runBlockAs(EFFECT, block, values);
  } finally {
    sink = cleanupSink as (() => void)[] | null | undefined;
    cleanupSink = prev;
  }
  if (!sink) return undefined;
  if (sink.length === 1) return sink[0];
  const fns = sink;
  return () => {
    for (const fn of fns) fn();
  };
}

let generatorHookInstalled = false;
const GENERATOR_FUNCTION_PROTO = Object.getPrototypeOf(function* () {});

/** @internal A generator function (`function* …`), which plain APIs accept as a block body. */
export function isGeneratorFunction(value: unknown): value is (...args: any[]) => Generator {
  return typeof value === "function" && Object.getPrototypeOf(value) === GENERATOR_FUNCTION_PROTO;
}

/**
 * @internal The hook behind `createMemo(function* …)` / `createEffect(function* …)`:
 * a generator body becomes a memo block, or an effect block created as a
 * tracked effect (reads, writes and `$cleanup` in one pass; writes deferred
 * until flush), which returns true. Anything else returns undefined.
 */
function generatorBody(fn: unknown, asEffect?: boolean | "settled"): unknown {
  if (!isGeneratorFunction(fn)) return undefined;
  const block = $(fn as any) as AnyBlock;
  if (!asEffect) return block;
  if (asEffect === "settled") return settledCallback(block);
  trackedEffect(() => {
    runBlockAs(EFFECT, block, undefined);
  });
  return true;
}

/**
 * @internal `onSettled(function* …)` / `$settled(…)`: an effect block run
 * once after the graph settles, never re-run (its reads are current values,
 * not subscriptions). Returns the `onSettled` callback: it runs the block
 * under the effect host and hands back its `$cleanup`s as the cleanup.
 */
export function settledCallback(block: AnyBlock): () => void | (() => void) {
  return () => runEffectHalf(block, undefined);
}

/**
 * Render a block as a JSX child: reads only. Renderers call this at their
 * insertion sink (`insert`, `flatten`) so a block that waits, raises,
 * attempts or writes is refused there at runtime, matching the type-level
 * admission into `JSX.Element`.
 */
export function renderBlock<B extends AnyBlock>(block: B): BlockValue<B> {
  // A deferred component call (`lazyView`) resolves to its view first.
  if (!(block as any)[BLOCK] && (block as any)[VIEW]) return renderBlock((block as any)()) as any;
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
    // violation); the captured owner is for error routing. (Called from a
    // handler, the owner is almost always already null: skip the bracket.)
    result =
      getOwner() === null
        ? runBlockAs(EVENT, block, event)
        : runWithOwner(null, () => runBlockAs(EVENT, block, event));
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
 * @internal Dispatch an event to a fused handler: the compiler erased the
 * `$event` block of a body it lowered and proved synchronous, with every
 * operation erased (reads of proven accessors are direct calls, writes are
 * setter calls), so no operation runs under the event host. What remains of
 * `dispatchBlock` is the handler contract: no owner context while it runs,
 * and a failure routed to the nearest error boundary above `owner`.
 */
export function dispatchFused<E>(fn: (event: E) => unknown, event: E, owner: Owner | null): void {
  let result: unknown;
  try {
    result = getOwner() === null ? fn(event) : runWithOwner(null, () => fn(event));
  } catch (error) {
    if (!reportBlockError(owner, error)) throw error;
    return;
  }
  // As `dispatchBlock`: a handler that waits (a compiled async body, see
  // `asyncBody`) routes its rejection to the same boundary.
  if (isThenableValue(result)) {
    (result as PromiseLike<unknown>).then(undefined, error => {
      if (!reportBlockError(owner, error)) throw error;
    });
  }
}

// --- compiled async bodies ----------------------------------------------------------
//
// The client lowering compiles a memo or event body that waits (`yield*
// attempt(() => promise)`) to an `async function` instead of leaving the
// generator to the driver, when the body has no other operation left (every
// read is a direct accessor call or a path read, every write a setter call —
// the conditions under which a synchronous body loses its block):
//
//   $event(function* (e) { const id = yield* props.id; yield* attempt(() => save(id)); })
//   // →
//   $eventCompiled(asyncBody(async function (e, _$a) {
//     try {
//       const id = readValue(props.id);
//       _$a.t(() => save(id)) ? _$a.r(await _$a.p) : _$a.v;
//     } catch (_$e) { _$a.x(_$e); } finally { _$a.f(); }
//   }));
//
// Each `yield* attempt(run, ...errors)` becomes `(_$a.t(run, ...errors) ?
// _$a.r(await _$a.p) : _$a.v)`: `t` runs `run` as the driver does (a
// synchronous throw is the typed error at the `yield*`) and awaits only a
// thenable, so a body whose attempts all return plain values completes
// synchronously — exactly as the driver steps it. `asyncBody` runs the body
// and hands back the driver's result: the returned value (or the thrown
// error) when the body never waited, else the run's result promise.
//
// Driver parity, point by point:
// - the first suspension registers the run's staleness on the running owner
//   (a memo recompute or disposal supersedes the run); a stale run is never
//   resumed (`r` throws `[BLOCK_SUPERSEDED]` instead of continuing, as the
//   driver closes the generator) and a stale rejection is reported as
//   superseded. The compiler lowers a memo only when no `attempt` sits in a
//   `try` (so no user `catch` / `finally` could observe the difference
//   between closing and throwing), none sits in a loop, and no read follows
//   the first `attempt` (the driver's `[READ_AFTER_WAIT]`);
// - a continuation runs in the settled promise's reaction, as the driver's
//   `then` callback does: side effects happen at the same microtask;
// - the result promise has the driver's shape, microtask for microtask. The
//   driver returns `P0 = Promise.resolve(w0).then(cb0)`; a callback that
//   suspends again returns the next step's promise, which its own `then`
//   promise adopts, so with n suspensions `P0` settles n − 1 reactions after
//   the body returns (one per level), and a returned thenable is adopted by
//   the innermost level. The async function's own promise settles as soon as
//   the body returns, so it is never handed out: each suspension opens a
//   level (a promise whose settle functions the run keeps) — the first is
//   the result, each later one resolves the previous level with its own
//   promise (as the callback's return value would) — and the wrapper's
//   `finally` settles the innermost level with the body's outcome (`f`), in
//   the job the body returns in. The adoption job of a level is queued when
//   the next suspension starts rather than when the callback returns, a
//   difference no code can observe: that job only subscribes to a native
//   promise that is still pending (it settles in a later continuation);
// - host and strict guard: the body is only compiled when no operation is
//   left to check (the same erasure proof as a synchronous body), so the
//   host the driver re-enters per step is not observable.
//
// `_$a.ret(v)` wraps every `return v` (and `return;`), recording the outcome
// the `finally` reports; `x` records a failure instead of rethrowing, so the
// async function's own promise never rejects (nothing observes it).

/** @internal One run of a compiled async block body (see above). */
export class AsyncRun {
  /** Still in the synchronous first segment (no suspension yet). */
  s = true;
  /** Superseded (set by the owner's cleanup after the first suspension). */
  stale = false;
  /** The pending thenable of the last `t`, awaited by the body. */
  p: unknown = undefined;
  /** The plain value of the last `t`. */
  v: unknown = undefined;
  /** The body's outcome: the returned value, or the thrown error. */
  value: unknown = undefined;
  threw = false;
  error: unknown = undefined;
  /** The result promise (the first level), once the body suspends. */
  head: Promise<unknown> | undefined = undefined;
  /** The innermost level's settle functions. */
  private ok: ((value: unknown) => void) | undefined = undefined;
  private fail: ((error: unknown) => void) | undefined = undefined;
  /** `attempt(run)`: true when the result is a thenable to await (`p`). */
  t(run: () => unknown): boolean {
    let value: unknown;
    try {
      value = readGuarded(run);
    } catch (error) {
      throw unwrapStatusError(error);
    }
    if (isThenableValue(value)) {
      if (this.s) {
        this.s = false;
        if (getOwner()) cleanup(() => (this.stale = true));
        this.head = this.level();
      } else {
        const outer = this.ok!;
        outer(this.level());
      }
      this.p = value;
      return true;
    }
    this.v = value;
    return false;
  }
  /** Open the next level of the result promise. */
  private level(): Promise<unknown> {
    return new Promise((ok, fail) => {
      this.ok = ok;
      this.fail = fail;
    });
  }
  /** Resume after an await: a superseded run does not continue. */
  r<T>(value: T): T {
    if (this.stale) throw supersededError();
    return value;
  }
  /** `return value`: the outcome (reported by `f`). */
  ret(value: unknown): undefined {
    this.value = value;
    return undefined;
  }
  /** The body's `catch`: the outcome is a failure. */
  x(error: unknown): void {
    this.threw = true;
    this.error = this.stale ? supersededError() : error;
  }
  /** The body's `finally`: settle the innermost level with the outcome. */
  f(): void {
    if (this.s) return;
    if (this.threw) this.fail!(this.error);
    else this.ok!(this.value);
  }
}

function supersededError(): Error {
  return new Error(
    __DEV__
      ? "[BLOCK_SUPERSEDED] This block run was superseded before its wait settled"
      : "[BLOCK_SUPERSEDED]"
  );
}

/**
 * @internal A compiled async memo / event body (see above) as the function
 * its host calls: `(input) => result`, where `result` is what the driver
 * would have returned for the same run.
 */
export function asyncBody<I, R>(
  body: (input: I, run: AsyncRun) => Promise<unknown>
): (input: I) => R | Promise<R> {
  return (input: I) => {
    const run = new AsyncRun();
    body(input, run);
    if (!run.s) return run.head as Promise<R>;
    if (run.threw) throw run.error;
    return run.value as R;
  };
}

// --- compiled reads -------------------------------------------------------------------

/**
 * @internal Compiled `yield* acc` for a binding the compiler proved to be a
 * signal / memo accessor, where the read may run with the strict guard up
 * (a prop getter, an attribute evaluated in the view body): exactly what
 * `perform(acc)` does with an accessor, without its dispatch. Inside a
 * computation the compiler emits the call itself.
 */
export function readAccessor<T>(accessor: () => T): T {
  return blockGuard ? readGuarded(accessor) : accessor();
}

/**
 * @internal Compiled `yield* readStore(store, selector)` outside a fused
 * computation: `perform(readStore(store, selector))` without the operation
 * object — a path-token argument (`readStore(store.user, …)` in a block
 * body) is consumed and walked, the host admits the read, and the selector
 * runs with the guard lowered.
 */
export function readSelected<S, R>(store: S, selector: (state: S) => R): R {
  const token = tokenOf(store);
  if (token) consume(token);
  checkHost(currentHost, "read");
  const prev = setBlockGuard(false);
  try {
    return selector(token ? (walk(token.root, token.path) as S) : store);
  } finally {
    setBlockGuard(prev);
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
//
// `flags` is compiler-emitted block metadata (a bitfield; see BLOCK_SYNC /
// BLOCK_NOTHROW). The runtime never guesses a flag: absent metadata is the
// unoptimized block. A claimed proof is verified in dev builds.
export function $<Input, Y extends Op, R>(
  body: (input: Input) => Generator<Y, R, any>,
  flags?: number
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
export function $(
  body: (input: any) => any,
  flags: number = 0
): AnyBlock | StrictCallback<any, any> {
  if (__DEV__ && typeof body === "function" && (body as any).prototype === undefined) {
    // Arrow functions and async functions have no `prototype`; generator
    // functions and the compiler's lowered `function` bodies do. A marker
    // reaching the runtime was not compiled: it must never run under the
    // generator driver or as a plain block, so fail loudly.
    throw new TypeError(
      __DEV__
        ? "[STRICT_NOT_COMPILED] `$` received a plain (arrow or async) callback at runtime. A non-generator callback is a strict compilation marker: @solidjs/compiler analyzes it for its host and erases the marker. Compile the module with the Solid compiler (`generators` on), or write a generator block (`$(function* () { … })`)"
        : "[STRICT_NOT_COMPILED]"
    );
  }
  if (!generatorHookInstalled) {
    generatorHookInstalled = true;
    installGeneratorHook(generatorBody);
    // Renderers reach blocks through block-hooks.ts (install-on-use): a
    // block exists from here on, so its render / dispatch / deferred-view
    // implementations do too.
    installBlockRenderer(renderBlock, dispatchBlock, lazyView);
    // The strict guard is only ever raised by a block run, so the store's
    // path tokens are only reachable once a block exists.
    makePathToken = pathToken;
  }
  // BLOCK_SYNC: the compiler lowered the body to call form and proved its
  // result is a plain value (never a generator, thenable or async iterable),
  // so the result-shape probes — an untracked, guard-lowered walk of the
  // result's prototype chain on every run — are skipped. Dev builds keep
  // the probes as a verification of the claim.
  // (`syncBlock` is the same wrapper for modules whose every block is SYNC;
  // it is not called from here, so a bundle only retains it when one exists.)
  const sync = (flags & BLOCK_SYNC) !== 0;
  // An uncompiled body (a `function*`): every call returns a fresh native
  // generator object, so the result needs no shape probe — it is driven.
  const driven = !sync && isGeneratorFunction(body);
  // Zero-arity on purpose: renderers and `flatten` unwrap a function child
  // only when `fn.length === 0` (an accessor), so a block returned from a
  // component must look like one. The input still arrives as the first
  // argument (`prev`, or the event).
  const block = function () {
    const host = pendingHost === -1 ? REACTIVE : pendingHost;
    pendingHost = -1;
    const prevHost = currentHost;
    currentHost = host;
    const prevGuard = setBlockGuard(true);
    const prevBase = tokenBase;
    const base = (tokenBase = liveTokens.length);
    try {
      // `arguments[0]`, not a rest parameter: no array per run.
      const result = body(arguments[0]);
      let value: unknown;
      if (sync) {
        if (__DEV__) verifySyncBlockResult(result);
        value = result;
      } else if (driven) {
        value = drive(result as Generator<Op>, host);
      } else if (result !== null && typeof result === "object") {
        const shape = objectShape(result);
        if (shape === ASYNC_ITERATOR) throw asyncGeneratorError();
        value = shape === SYNC_ITERATOR ? drive(result as Generator<Op>, host) : result;
      } else {
        value = result;
      }
      if (liveTokens.length !== base) checkTokens(base);
      return value;
    } finally {
      if (liveTokens.length !== base) liveTokens.length = base;
      tokenBase = prevBase;
      setBlockGuard(prevGuard);
      currentHost = prevHost;
    }
  } as unknown as AnyBlock;
  (block as any)[BLOCK] = true;
  (block as any)[BODY] = body;
  (block as any)[FLAGS] = flags;
  (block as any)[OWNER] = getOwner();
  (block as any)[Symbol.iterator] = blockIterator;
  return block;
}

let syncRuntimeInstalled = false;

/**
 * @internal Compiled-only block constructor. The compiler emits it (as `$`'s
 * stand-in) in a module where every block body it built was lowered to call
 * form and proven `BLOCK_SYNC`: the body never returns a generator, thenable
 * or async iterable, so the block never drives, never probes its result and
 * never needs the generator-body hook. A module that only builds blocks with
 * `syncBlock` (and the `…Compiled` constructors of `block-api.ts`) does not
 * retain the runtime generator driver (`drive` / `step` / `settle` /
 * `resume`) — `$` references it, this does not. Everything a run observes is
 * `$`'s: the host the block runs under, the raised strict guard, path tokens
 * checked and released per run, dev verification of the SYNC claim.
 */
export function syncBlock<Input, R>(
  body: (input: Input) => R,
  flags: number = BLOCK_SYNC
): Block<R, any, never, any, any, Input> {
  if (!syncRuntimeInstalled) {
    syncRuntimeInstalled = true;
    // As in `$`: renderers reach blocks through block-hooks.ts, and the
    // store's path tokens are only reachable once a block exists. (No
    // generator-body hook: that is the driver.)
    installBlockRenderer(renderBlock, dispatchBlock, lazyView);
    makePathToken = pathToken;
  }
  const block = function () {
    const host = pendingHost === -1 ? REACTIVE : pendingHost;
    pendingHost = -1;
    const prevHost = currentHost;
    currentHost = host;
    const prevGuard = setBlockGuard(true);
    const prevBase = tokenBase;
    const base = (tokenBase = liveTokens.length);
    try {
      // `arguments[0]`, not a rest parameter: no array per run.
      const result = body(arguments[0]);
      if (__DEV__) verifySyncBlockResult(result);
      if (liveTokens.length !== base) checkTokens(base);
      return result;
    } finally {
      if (liveTokens.length !== base) liveTokens.length = base;
      tokenBase = prevBase;
      setBlockGuard(prevGuard);
      currentHost = prevHost;
    }
  } as unknown as AnyBlock;
  // Branded here, not through a helper shared with `$`: a shared store site
  // made uncompiled path reads measurably slower (+3.5% Ir, blocks-v2 bench).
  (block as any)[BLOCK] = true;
  (block as any)[BODY] = body;
  (block as any)[FLAGS] = flags;
  (block as any)[OWNER] = getOwner();
  (block as any)[Symbol.iterator] = blockIterator;
  return block as any;
}

/** `yield* block`: delegation (shared by every block; `this` is the block). */
function* blockIterator(this: AnyBlock): Generator<Op, unknown, any> {
  return yield* blockGenerator(this, undefined);
}

/**
 * Hydration id scope for a JSX-producing block body. The compiler emits
 * `$(blockScope(body))` for every `$` block whose body contains JSX, in the
 * pass shared by the client and server generates, so both sides wrap the same
 * blocks.
 *
 * A block defers its JSX to whichever sink runs it (the client's `insert`
 * effect or a flow control's flatten; the server's template-hole resolution),
 * and those sinks run at different times under different owners on each side
 * — content ids drifted apart (the JSX-block hydration-id parity defect).
 * `blockScope` reserves one child-id slot when the block is CREATED (the `$()`
 * call, in source order on both sides, exactly where a component's own JSX
 * would allocate) and runs every invocation of the body under that id with a
 * zeroed counter. The scope is virtual (see `runInIdScope`): ownership,
 * disposal and tracking stay with the sink. A runtime-driven (generator) body
 * keeps the scope across its steps.
 *
 * Outside an id-carrying tree nothing is reserved and `body` is returned
 * as-is. The server twin (`solid-js` server runtime) must stay slot-for-slot
 * identical.
 *
 * @internal Compiler-emitted; not for hand-written code.
 */
export function blockScope<F extends (...args: any[]) => any>(body: F): F {
  const scopeId = reserveIdScope();
  if (scopeId === undefined) return body;
  return function (this: unknown, input?: unknown) {
    const result = runInIdScope(scopeId, 0, body, this, input);
    return isSyncIterator(result) ? scopeSteps(result, scopeId, idScopeEndCount()) : result;
  } as unknown as F;
}

/** A runtime-driven body: every step runs in the scope, continuing its count. */
function scopeSteps(
  it: Generator<Op, unknown, any>,
  scopeId: string,
  count: number
): Generator<Op, unknown, any> {
  const step = (method: "next" | "throw" | "return", value: unknown) => {
    const result = runInIdScope(scopeId, count, it[method] as any, it, value);
    count = idScopeEndCount();
    return result;
  };
  const scoped = {
    next: (v?: unknown) => step("next", v),
    throw: (e?: unknown) => step("throw", e),
    return: (v?: unknown) => step("return", v),
    [Symbol.iterator]: () => scoped
  };
  return scoped as unknown as Generator<Op, unknown, any>;
}

/** Delegation: run the block's body inside the caller's generator frame. */
function* blockGenerator(block: AnyBlock, input: unknown): Generator<Op, unknown, any> {
  const result = (block as any)[BODY](input);
  if (isAsyncIterator(result)) throw asyncGeneratorError();
  return isSyncIterator(result) ? yield* result : result;
}

/**
 * @internal What a v2 setter (`$signal` / `$store`) returns: `yield* receipt`
 * evaluates to the written value. One shared prototype iterator — the
 * receipt is created on every write, so it must not carry a closure — and
 * `perform` reads `value` directly (compiled `yield* set(v)`).
 */
export class Receipt<T = unknown> {
  constructor(readonly value: T) {}
  *[Symbol.iterator](): Generator<never, T, unknown> {
    return this.value;
  }
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
    // Fast path: a signal / memo accessor (every accessor carries the shared
    // `accessorIterator`; blocks, views and context providers never do).
    // With the guard already down (a JSX hole, a fused compute) the read is
    // the call itself.
    if ((target as any)[Symbol.iterator] === accessorIterator) {
      return blockGuard ? readGuarded(target as () => unknown) : (target as () => unknown)();
    }
    // A child view (a view block or a deferred call, `yield* Child(p)`) is a value.
    if ((target as any)[VIEW]) return target;
    if ((target as any)[BLOCK]) return delegateSync(target as AnyBlock, undefined);
    // A context provider (`yield* Ctx`) is stepped; an accessor is read.
    if (ownIterator(target)) return stepSync(target as any);
    return readGuarded(target as () => unknown);
  }
  return performValue(target);
}

/**
 * `perform` of a non-function operand. Kept out of `perform` itself: the
 * closures below capture the operand, and a function whose parameter a
 * closure captures allocates that closure context on EVERY call — the
 * accessor fast path above must not pay for it.
 */
function performValue(target: unknown): unknown {
  // A lowered bare identifier that holds a path token (`const u = store.user;
  // yield* u`): perform the path read. (Before any other probe: a token is a
  // proxy whose traps refuse everything but `yield*`.)
  const token = tokenOf(target);
  if (token) {
    consume(token);
    return readGuarded(() => readThrough(walk(token.root, token.path)));
  }
  // A v2 setter's receipt (`yield* set(v)`): the written value.
  if (target instanceof Receipt) return target.value;
  if (isOp(target)) return performOp(target);
  // Setter receipts, context objects and helper generators (`yield*
  // useTodos()`): step their iterator here.
  if (ownIterator(target) || isGeneratorObject(target)) return stepSync(target as any);
  throw invalidYield(target);
}

/** One operation, performed in call form under the current host (the
 * host check, then the operation). */
function performOp(op: Op): unknown {
  checkHost(currentHost, op[OP]);
  switch (op[OP]) {
    case "read":
      return readGuarded(op.source);
    case "attempt": {
      const value = readGuarded(op.run);
      if (isThenableValue(value)) {
        throw new TypeError(
          __DEV__
            ? "[ASYNC_OP_OUTSIDE_DRIVER] An async `attempt` can only be performed by the generator driver. Keep `yield* attempt(...)` inline in the block so the compiler leaves it to the runtime"
            : "[ASYNC_OP_OUTSIDE_DRIVER]"
        );
      }
      return value;
    }
    case "create":
      return readGuarded(op.make);
    case "cleanup":
      return void registerCleanup(op.fn);
    case "context":
      return readGuarded(op.read);
    case "flush":
      return void flush();
    case "write":
      return readGuarded(() => op.target(op.value));
    case "call":
      return delegateSync(op.block, op.input);
    case "raise":
      throw op.error;
    case "wait":
      throw new TypeError(
        __DEV__
          ? "[ASYNC_OP_OUTSIDE_DRIVER] A suspension can only be performed by the generator driver. Keep `yield* attempt(...)` inline in the block so the compiler leaves it to the runtime"
          : "[ASYNC_OP_OUTSIDE_DRIVER]"
      );
  }
  return undefined;
}

function isGeneratorObject(target: unknown): boolean {
  return (
    target != null &&
    typeof (target as any).next === "function" &&
    typeof (target as any).throw === "function" &&
    typeof (target as any)[Symbol.iterator] === "function"
  );
}

function ownIterator(target: unknown): boolean {
  return (
    target != null &&
    Object.prototype.hasOwnProperty.call(target, Symbol.iterator) &&
    (target as any)[Symbol.iterator] !== accessorIterator
  );
}

/** Call-form `yield*` over a non-op iterable: perform each operation it yields. */
function stepSync(iterable: Iterable<unknown>): unknown {
  const it = (iterable as any)[Symbol.iterator]() as Iterator<unknown>;
  let step = it.next();
  while (!step.done) step = it.next(perform(step.value as any));
  return step.value;
}

/** Call-form delegation: the callee runs under the caller's host. */
function delegateSync(block: AnyBlock, input: unknown): unknown {
  const value = readGuarded(() => runBlockAs(currentHost, block, input));
  if (isThenableValue(value)) throw asyncBlockError();
  return value;
}

function asyncBlockError(): TypeError {
  return new TypeError(
    __DEV__
      ? "[ASYNC_BLOCK_OUTSIDE_DRIVER] A block that waits can only be delegated to from a generator block (`yield* block`); it cannot be lowered to call form"
      : "[ASYNC_BLOCK_OUTSIDE_DRIVER]"
  );
}

/**
 * Which hosts admit each operation. v1 blocks keep their rules (reactive: no
 * writes; jsx: reads only; event: everything v1 had); the v2 operations are
 * admitted only where the design allows them (generator-blocks-v2.md).
 */
const ALLOWED: Record<Op[typeof OP], number> = {
  read: bit(REACTIVE) | bit(JSX) | bit(EVENT) | bit(EFFECT),
  call: bit(REACTIVE) | bit(JSX) | bit(EVENT) | bit(EFFECT),
  wait: bit(REACTIVE) | bit(EVENT),
  attempt: bit(REACTIVE) | bit(EVENT) | bit(EFFECT),
  raise: bit(REACTIVE) | bit(EVENT) | bit(EFFECT),
  write: bit(EVENT) | bit(EFFECT),
  create: bit(COMPONENT),
  cleanup: bit(COMPONENT) | bit(EFFECT),
  context: bit(COMPONENT),
  flush: bit(EVENT)
};
function bit(host: Host): number {
  return 1 << host;
}

function checkHost(host: Host, kind: Op[typeof OP]): void {
  if (ALLOWED[kind] & bit(host)) return;
  if (host === JSX) {
    throw new Error(
      __DEV__
        ? `[OP_NOT_ALLOWED_IN_JSX] A block rendered as JSX may only read signals; \`${kind}\` belongs in a reactive computation or an event block (host: ${HOST_NAMES[host]})`
        : "[OP_NOT_ALLOWED_IN_JSX] " + kind
    );
  }
  if (host === REACTIVE && kind === "write") {
    throw new Error(
      __DEV__
        ? "[WRITE_IN_REACTIVE_BLOCK] A reactive computation may not write; move the write into an event block or the effect phase (host: reactive)"
        : "[WRITE_IN_REACTIVE_BLOCK]"
    );
  }
  throw new Error(
    __DEV__
      ? `[OP_NOT_ALLOWED] \`${kind}\` is not allowed in a ${HOST_NAMES[host]} block. ${HOST_RULES[host]}`
      : "[OP_NOT_ALLOWED] " + kind
  );
}

const HOST_RULES = [
  "A memo reads, attempts and raises; it may not write, create, clean up, read context or flush.",
  "A view only reads.",
  "An event reads, writes, attempts, raises and flushes; it may not create, clean up or read context.",
  "A component's setup creates ($signal, $store, $memo, $effect), cleans up and reads context; reads belong in its view.",
  "An effect reads, writes, cleans up, attempts (synchronously) and raises."
] as const;

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
  return step(iterator, iterator.next(), state);
}

/**
 * The run's first suspension (always inside the synchronous `drive` call,
 * under the run's owner): from now on a superseding run (recompute) or
 * disposal marks this run stale, and its pending continuation closes the
 * generator instead of resuming. Registered here rather than per run — a
 * run that never suspends (every run of a sync body) needs no cleanup.
 */
function suspend(state: RunState): void {
  if (state.waited) return;
  state.waited = true;
  if (getOwner()) cleanup(() => (state.stale = true));
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
        __DEV__
          ? "[PLAIN_YIELD_IN_BLOCK] Operations must be yielded with `yield*` (e.g. `yield* attempt(() => p)`), not `yield`"
          : "[PLAIN_YIELD_IN_BLOCK]"
      );
    }
    op.delegated = false;
    checkHost(state.host, op[OP]);
    switch (op[OP]) {
      case "read":
        // After a suspension the read is untracked: fine in an event (it
        // reads the current value), an error in a computation.
        if (state.waited && state.host === REACTIVE) {
          throw new Error(
            __DEV__
              ? "[READ_AFTER_WAIT] A signal was read after the block's first suspension (an async `yield* attempt(...)`). Reads after a suspension are not tracked; read every signal before the first suspension"
              : "[READ_AFTER_WAIT]"
          );
        }
        result = state.waited
          ? settle(iterator, () => untrack(op.source))
          : settle(iterator, op.source);
        continue;
      case "attempt": {
        // `attempt(fn)`: run `fn`; a promise result suspends the block like
        // `wait` (the rejection is thrown at the `yield*`).
        let value: unknown;
        try {
          value = readGuarded(op.run);
        } catch (error) {
          result = iterator.throw(unwrapStatusError(error));
          continue;
        }
        if (isThenableValue(value)) {
          if (state.host === EFFECT) {
            throw new Error(
              __DEV__
                ? "[ASYNC_IN_EFFECT] An effect block cannot suspend; `attempt` returned a promise. Start async work from an event block, or read an async memo"
                : "[ASYNC_IN_EFFECT]"
            );
          }
          suspend(state);
          return Promise.resolve(value as PromiseLike<unknown>).then(
            v => resume(iterator, state, () => iterator.next(v)),
            error => resume(iterator, state, () => iterator.throw(error))
          );
        }
        result = iterator.next(value);
        continue;
      }
      case "create":
        result = settle(iterator, op.make);
        continue;
      case "cleanup": {
        const fn = op.fn;
        result = settle(iterator, () => void registerCleanup(fn));
        continue;
      }
      case "context":
        result = settle(iterator, op.read);
        continue;
      case "flush":
        result = settle(iterator, () => void flush());
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
        suspend(state);
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
    throw new Error(
      __DEV__
        ? "[BLOCK_SUPERSEDED] This block run was superseded before its wait settled"
        : "[BLOCK_SUPERSEDED]"
    );
  }
  const prevHost = currentHost;
  currentHost = state.host;
  const prevGuard = setBlockGuard(true);
  const prevBase = tokenBase;
  const base = (tokenBase = liveTokens.length);
  try {
    const value = step(iterator, advance(), state);
    if (liveTokens.length !== base) checkTokens(base);
    return value;
  } finally {
    if (liveTokens.length !== base) liveTokens.length = base;
    tokenBase = prevBase;
    setBlockGuard(prevGuard);
    currentHost = prevHost;
  }
}

/** Perform one operation with the strict guard lowered around it (every
 * tier: the store proxy answers a raised guard with a path token). */
/**
 * @internal Run framework plumbing that reads signals (dev tooling such as the
 * HMR registry) inside a block without tripping the strict read guard.
 */
export function outsideBlock<T>(run: () => T): T {
  return readGuarded(run);
}

/**
 * @internal Whether a block body is running now (its strict read guard is
 * up). A component or boundary called here is deferred (`lazyView`).
 */
export function inBlock(): boolean {
  return blockGuard;
}

/**
 * @internal A component or boundary call made inside a running block body
 * (`Loading({ children: Child(p) })` in an uncompiled view): a view thunk
 * the renderer or the enclosing boundary resolves where it renders it —
 * under that owner, outside the block's guard, once per evaluation, exactly
 * like the prop getters the compiler emits for the same call.
 * `yield* thunk` evaluates to the thunk (a view).
 */
export function lazyView<T>(make: () => T): () => T {
  // One instance per deferred call, created under the owner ABOVE the
  // computation that first resolves it (a boundary's children computation,
  // an insert effect). That computation re-running — its view read a pending
  // memo that settled — reuses the instance instead of re-creating it (and
  // re-starting its fetches); the instance lives until that owner is
  // disposed, like a component the compiler created in a prop getter.
  let instance: { value: T } | undefined;
  const thunk = () =>
    readGuarded(() => {
      if (instance) return instance.value;
      const current = getOwner() as any;
      const host = current && current._parent ? current._parent : current;
      const owner = runWithOwner(host, () => createOwner());
      const value = runWithOwner(owner, () => {
        cleanup(() => {
          instance = undefined;
        });
        return untrack(make);
      });
      instance = { value };
      return value;
    });
  (thunk as any)[VIEW] = true;
  (thunk as any)[Symbol.iterator] = viewIterator;
  return thunk;
}

/**
 * @internal `yield*` on a view (a view block or a deferred call) evaluates to
 * the view itself. Shared: `this` is the view.
 */
// eslint-disable-next-line require-yield
export function* viewIterator(this: unknown): Generator<never, unknown, unknown> {
  return this;
}

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

const PLAIN = 0;
const SYNC_ITERATOR = 1;
const ASYNC_ITERATOR = 2;
/**
 * An object block result's shape, in one probe (untracked, guard lowered): an async
 * iterator, a sync iterator (a generator body to drive), or a plain value.
 * The same tests in the same order as `isAsyncIterator` then `isSyncIterator`.
 */
function objectShape(value: object): number {
  // Callers test `typeof value === "object"` first: this function allocates
  // the probe's closure context, which must never happen for a plain result.
  return probe(() =>
    Symbol.asyncIterator in value
      ? ASYNC_ITERATOR
      : typeof (value as Partial<Generator>).next === "function" &&
          typeof (value as any)[Symbol.iterator] === "function"
        ? SYNC_ITERATOR
        : PLAIN
  );
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

/**
 * Dev verification of BLOCK_SYNC: the probes production skips, run as a
 * check. A generator result means the compiler flagged a body it did not
 * lower; a thenable / async iterable result means the sync proof was wrong.
 */
function verifySyncBlockResult(result: unknown): void {
  if (result === null || typeof result !== "object") return;
  if (isAsyncIterator(result) || isSyncIterator(result) || isThenableValue(result)) {
    throw new TypeError(
      "[BLOCK_SYNC_VIOLATED] A `$` block flagged BLOCK_SYNC by the compiler produced a generator, " +
        "Promise or async iterable. The compiler's synchrony proof was wrong for this block; " +
        "production would hand the object to the host as a plain value"
    );
  }
}

function asyncGeneratorError(): TypeError {
  return new TypeError(
    __DEV__
      ? "[ASYNC_GENERATOR] `$` does not accept async generators (`await` is not allowed in a block); suspend with `yield* attempt(() => promise)` instead"
      : "[ASYNC_GENERATOR]"
  );
}

function invalidYield(value: unknown): TypeError {
  if (typeof value === "function") {
    return new TypeError(
      __DEV__
        ? "[PLAIN_YIELD_IN_BLOCK] Signals and blocks must be delegated to with `yield*`, not `yield`"
        : "[PLAIN_YIELD_IN_BLOCK]"
    );
  }
  if (value !== null && typeof value === "object" && Symbol.asyncIterator in value) {
    return asyncGeneratorError();
  }
  return new TypeError(
    __DEV__
      ? `[INVALID_YIELD] blocks may only yield operations (\`yield* signal\`, \`yield* store.path\`, \`yield* set(value)\`, \`yield* raise(...)\`, \`yield* attempt(...)\`, \`yield* Child(props)\`, \`yield* Ctx\`, \`yield* block\`); received ${describe(value)}`
      : "[INVALID_YIELD]"
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
