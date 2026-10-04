/*
 * The type model of generator blocks.
 *
 * A block is a `function*`. Everything it does is an operation it delegates
 * to with `yield*`, and TypeScript collects the delegated operations' yield
 * types into the generator's yield union. The constructors (`$component`,
 * `$memo`, `$effect`, `$event`, row blocks) constrain that union: each kind
 * of block admits a fixed set of operations, so a disallowed operation is a
 * type error at the constructor call.
 *
 * Two facts travel with values: whether reading them may be *pending*
 * (async, not yet resolved) and which errors reading them may *fail* with.
 * Operations carry them as phantom fields; `PendingOf` / `FailsOf` fold a
 * yield union into them. Nothing here exists at runtime.
 */

/** Phantom: may this value / operation be pending? */
export declare const PENDING: unique symbol;
/** Phantom: the failures reading this value / performing this operation may raise. */
export declare const FAILS: unique symbol;
/** Phantom: the operation kind. */
export declare const KIND: unique symbol;
/** Phantom brand of library read sources. */
export declare const SOURCE: unique symbol;
/** Phantom brand of component views. */
export declare const VIEW: unique symbol;
/** Phantom brand of typed props (carries the declared props type). */
export declare const PROPS: unique symbol;
/** Phantom brand of no-JSX (`h`) output. */
export declare const HVIEW: unique symbol;
/** Phantom brand of `$event` handlers (a plain function is not one). */
export declare const EVENT: unique symbol;
/** Phantom brand of a call of an `$event` handler. */
export declare const EVENT_CALL: unique symbol;
/** Phantom key of an event call's async color. */
export declare const ASYNC: unique symbol;
/** Phantom brand of a stream an `attempt` handled. */
export declare const HANDLED: unique symbol;
/** A stream an `attempt` gave back: its failures go through the attempt's handler. */
export interface Handled {
  readonly [HANDLED]: true;
}
/** Phantom brand of `$component`s (a plain function is not one). */
export declare const COMPONENT: unique symbol;

// --- operations ------------------------------------------------------------------

/** A tracked read of a source that may be pending (`P`) and may fail with `E`. */
export interface Read<P extends boolean = boolean, E = unknown> {
  readonly [KIND]: "read";
  readonly [PENDING]: P;
  readonly [FAILS]: E;
}
/** An async `attempt`: the block suspends until the promise settles. */
export interface Wait {
  readonly [KIND]: "wait";
}
/** A typed failure: `yield* raise(e)` or a declared `attempt` failure. */
export interface Raise<E> {
  readonly [KIND]: "raise";
  readonly [FAILS]: E;
}
/** A write through a block setter's receipt (or a call of an `$event`). */
export interface Write {
  readonly [KIND]: "write";
}
/**
 * Delegating to a call of an `$event`: a write that carries the callee's
 * colors — `P`, it waits for pending data; `A`, it does async work — and its
 * failures, so the caller's type gets them.
 */
export interface EventCallOp<
  P extends boolean = boolean,
  A extends boolean = boolean,
  E = unknown
> {
  readonly [KIND]: "call";
  readonly [PENDING]: P;
  readonly [ASYNC]: A;
  readonly [FAILS]: E;
}
/** Creating owned state (`$signal`, `$store`, `$memo`, `$effect`, `$settled`). */
export interface Create<K extends string = string> {
  readonly [KIND]: "create";
  readonly kind: K;
}
/** `$cleanup(fn)`. */
export interface Cleanup {
  readonly [KIND]: "cleanup";
}
/** `yield* Ctx`. */
export interface ContextRead {
  readonly [KIND]: "context";
}
/** `yield* Child(props)`: the child's pending and failures, propagated. */
export interface ChildView<P extends boolean = boolean, E = unknown> {
  readonly [KIND]: "child";
  readonly [PENDING]: P;
  readonly [FAILS]: E;
}

export type AnyOp =
  | Read<boolean, any>
  | Wait
  | Raise<any>
  | Write
  | EventCallOp<boolean, boolean, any>
  | Create<string>
  | Cleanup
  | ContextRead
  | ChildView<boolean, any>;

/** Operations a component's (or a row block's) setup may perform: it creates, never reads (D-042). */
export type SetupOp = Create<string> | Cleanup | ContextRead;
/**
 * What a JSX view's generator yields, as TypeScript sees it: the reads and
 * child views of its holes (each `yield*` in a JSX position, which the
 * transform turns into a hole). The view's own body reads nothing (D-032) —
 * a rule TypeScript cannot see, since it types a `yield*` in JSX and one in
 * a statement alike; the runtime (`READ_IN_VIEW`) and the lint
 * (`no-read-in-view-body`) hold it.
 */
export type ViewOp = Read<boolean, any> | ChildView<boolean, any>;
/** What a no-JSX view yields: nothing (D-032). Its reads are holes, its pending and failures its output's. */
export type HViewOp = never;
/** Operations a memo may perform. */
export type MemoOp = Read<boolean, any> | Wait | Raise<any>;
/** Operations an effect may perform (a sync `attempt` only). */
export type EffectOp =
  | Read<boolean, any>
  | Write
  | Cleanup
  | Raise<any>
  | EventCallOp<false, false, any>;
/** Operations an event handler may perform. */
export type EventOp =
  | Read<boolean, any>
  | Write
  | Wait
  | EventCallOp<boolean, boolean, any>
  | Raise<any>;
/** Operations a no-JSX hole (a bare `function*` given to `h`) may perform: reads. */
export type HoleOp = Read<boolean, any> | Raise<any>;

// --- folding a yield union ---------------------------------------------------------

type PendingBits<Y> = Y extends Wait
  ? true
  : Y extends { readonly [PENDING]: infer P }
    ? true extends P
      ? true
      : never
    : never;
/** Whether any operation in `Y` may be pending. */
export type PendingOf<Y> = [PendingBits<Y>] extends [never] ? false : true;
/** The union of the failures of the operations in `Y`. */
export type FailsOf<Y> = Y extends { readonly [FAILS]: infer E } ? E : never;

type ReadPendingBits<Y> = Y extends { readonly [PENDING]: infer P }
  ? true extends P
    ? true
    : never
  : never;
/**
 * An event's first color: it reads a source that may be pending (or calls an
 * event that does), so it waits for that data.
 */
export type ReadsPendingOf<Y> = [ReadPendingBits<Y>] extends [never] ? false : true;
/**
 * An event's second color: it does async work of its own — an async
 * `attempt`, `until`, or a call of an event that does.
 */
type WaitBits<Y> = Y extends Wait
  ? true
  : Y extends { readonly [ASYNC]: infer A }
    ? true extends A
      ? true
      : never
    : never;
export type WaitsOf<Y> = [WaitBits<Y>] extends [never] ? false : true;

/** Something `yield*` can delegate to: yields `Y`, evaluates to `R`. */
export interface Yieldable<Y, R> {
  [Symbol.iterator](): Generator<Y, R, any>;
}

// --- sources -------------------------------------------------------------------------

/**
 * A readable source: `yield* source` is a tracked read. `P` / `E` say whether
 * the read may be pending and what it may fail with. Deliberately not
 * callable at the type level: inside a block, a read is a `yield*` (a call
 * would be a hidden read). Block code reads it with `yield*`.
 */
export interface Source<T, P extends boolean = false, E = never> {
  readonly [SOURCE]: T;
  readonly [PENDING]: P;
  readonly [FAILS]: E;
  [Symbol.iterator](): Generator<Read<P, E>, T, any>;
}
/** A source with nothing left to handle. */
export type SettledSource<T = unknown> = Source<T, false, never>;
/** Any source (for constraints). */
export type AnySource = Source<any, boolean, any>;

type Primitive = string | number | boolean | bigint | symbol | null | undefined;
type Opaque =
  | Primitive
  | ((...args: any[]) => any)
  | Node
  | Date
  | RegExp
  | Map<any, any>
  | Set<any>
  | Promise<any>;

/**
 * A path into an object: `yield* x.a.b` reads `a.b` as one tracked read.
 * Arrays are walked by index and `length`; functions, DOM nodes and other
 * opaque values stop the path.
 */
export type Path<T, P extends boolean = false, E = never> = Source<T, P, E> &
  PathKeys<NonNullable<T>, Nullish<T>, P, E>;
/**
 * The keys of a path. Through a nullable value a key may read `undefined`
 * (the read stops at the `null`); a key holding a source reads through it
 * and takes on its coloring (a context value `{ status: Source<Status> }`).
 */
type PathKeys<T, N, P extends boolean, E> = [T] extends [Opaque]
  ? unknown
  : T extends readonly (infer U)[]
    ? { readonly [n: number]: Path<U | N, P, E>; readonly length: Source<number | N, P, E> }
    : T extends object
      ? { readonly [K in keyof T]-?: PathThrough<T[K], N, P, E> }
      : unknown;
type Nullish<T> = [Extract<T, null | undefined>] extends [never] ? never : undefined;
type PathThrough<V, N, P extends boolean, E> = [V] extends [Source<infer U, infer P2, infer E2>]
  ? Path<U | N, P | P2, E | E2>
  : Path<V | N, P, E>;

/** A value read through: a source's value, else the value itself. */
export type ReadThrough<V> = V extends Source<infer T, any, any> ? T : V;
type ThroughPending<V> = V extends Source<any, infer P, any> ? P : false;
type ThroughFails<V> = V extends Source<any, any, infer E> ? E : never;

/** A store as blocks see it: every path is a read. */
export type TypedStore<T> = Path<T, false, never>;

// --- props ---------------------------------------------------------------------------

/**
 * Coloring the type linker (or an explicit declaration) attaches to a prop:
 * what callers may pass. `pending` / `fails` join into the prop's reads.
 */
export interface PropColor {
  readonly pending: boolean;
  readonly fails: unknown;
}
/**
 * Registry the type linker fills by declaration merging (the generated
 * `*.gen.d.ts`): `PropColors["UserCard"]["user"]` is the joined color of
 * every known caller's `user` prop. A component opts in by naming its key in
 * `TypedProps<P, "UserCard">`.
 */
export interface PropColors {}
/**
 * Components whose coloring the linker could not close over every caller
 * (exported beyond the project, passed as a value, rendered by `<Dynamic>`):
 * their props keep the declared (settled) type unless declared explicitly.
 */
export interface PropColorsOpen {}

type ColorOf<K extends string, Name extends PropertyKey> = [K] extends [never]
  ? { pending: false; fails: never }
  : K extends keyof PropColors
    ? Name extends keyof PropColors[K]
      ? PropColors[K][Name] extends PropColor
        ? PropColors[K][Name]
        : { pending: false; fails: never }
      : { pending: false; fails: never }
    : { pending: false; fails: never };

type PropPath<V, P extends boolean, E, Name> = Name extends "children"
  ? Source<V, P, E>
  : Path<ReadThrough<V>, P | ThroughPending<V>, E | ThroughFails<V>>;

/**
 * Props as a block sees them: every prop is a read (`yield* props.id`), and
 * forwarding `props.id` to a child forwards the read. `K` names the
 * component for the type linker (`TypedProps<{ user: User }, "UserCard">`):
 * the linker's `PropColors[K]` colors each prop with what its callers pass.
 */
export type TypedProps<P, K extends string = never> = {
  readonly [N in keyof P]-?: PropPath<
    Exclude<P[N], undefined> | (undefined extends P[N] ? undefined : never),
    ColorOf<K, N>["pending"] extends true ? true : false,
    ColorOf<K, N>["fails"],
    N
  >;
} & { readonly [PROPS]?: (props: P) => P };

/**
 * What callers may pass for each prop: the value, or a source of it. A prop
 * declared as a source (`who: Source<Presence, true, unknown>`) states the
 * coloring its readers handle: callers pass its value or any source within
 * that coloring (a settled one included).
 */
export type PropsInput<P> = {
  [N in keyof P]: [P[N]] extends [Source<infer T, infer Pd, infer E>]
    ? T | Source<T, Pd extends true ? boolean : false, E>
    : P[N] | Source<P[N], boolean, any>;
};

/** The props type a `TypedProps` annotation declares. */
export type PropsOf<TP> = unknown extends TP
  ? {}
  : TP extends { readonly [PROPS]?: (props: infer P) => any }
    ? P
    : {};

// --- views and components ---------------------------------------------------------

/**
 * What a component renders. `P` / `E` are the pending and failures it has
 * not handled; only a settled view (`View<false, never>`) is an element.
 * `yield* view` (inside another view) moves them into the enclosing view.
 */
export interface View<P extends boolean = boolean, E = unknown> {
  readonly [VIEW]: true;
  readonly [PENDING]: P;
  readonly [FAILS]: E;
  [Symbol.iterator](): Generator<ChildView<P, E>, SettledView, any>;
}
export type SettledView = View<false, never>;

/** A component built by `$component`: calling it renders it and returns its view. */
export type Component<P = {}, Pd extends boolean = boolean, E = unknown> = ({} extends P
  ? (props?: PropsInput<P>) => View<Pd, E>
  : (props: PropsInput<P>) => View<Pd, E>) & { readonly [COMPONENT]: true };

/** A view generator's pending: its reads' and, for a no-JSX view, its output's. */
export type ViewPending<VY, R> = PendingOf<VY | HOps<R>>;
export type ViewFails<VY, R> = FailsOf<VY | HOps<R>>;
type HOps<R> = R extends HView<infer P, infer E> ? ChildView<P, E> : never;

/**
 * Output of the no-JSX renderer (`h`): its pending / failures are
 * the union of its holes'.
 */
export interface HView<P extends boolean = boolean, E = unknown> {
  readonly [HVIEW]: true;
  readonly [PENDING]: P;
  readonly [FAILS]: E;
}

// --- events ----------------------------------------------------------------------------

/**
 * A call of an `$event` handler: it has started (a handler runs when it is
 * called, as a DOM dispatch needs), and it is a promise of the body's result.
 * In block code it is an operation: `yield* save(x)` waits for it — its
 * result, or its failure thrown at the `yield*` — and carries its colors into
 * the caller's type.
 */
export interface EventCall<
  R = unknown,
  E = never,
  P extends boolean = boolean,
  A extends boolean = boolean
>
  extends Promise<R | undefined>, Yieldable<EventCallOp<P, A, E>, R> {
  readonly [EVENT_CALL]: true;
}

/**
 * An `$event` handler, a Solid action: call it with the arguments its body
 * takes (an event, or anything else). Its colors: `P`, it reads pending data
 * (and waits for it); `A`, it does async work of its own.
 */
export interface EventHandler<
  Args extends unknown[] = any[],
  E = never,
  R = unknown,
  P extends boolean = boolean,
  A extends boolean = boolean
> {
  (...args: Args): EventCall<R, E, P, A>;
  readonly [EVENT]: true;
  readonly [FAILS]?: E;
}

/** Setter of a `$signal`: writes when called; `yield*` on the receipt is the new value. */
export type BlockSetter<T> = <U extends T>(value: U | ((prev: T) => U)) => Receipt<U>;
/** Setter of a `$store`. */
export type BlockStoreSetter<T> = (fn: (draft: T) => T | void) => Receipt<T>;
/** A write receipt. */
export interface Receipt<T> extends Yieldable<Write, T> {}

// --- row blocks ----------------------------------------------------------------------

/**
 * A render callback written as a block: its setup takes the flow control's
 * render arguments and creates, and returns its view, which only reads.
 * A flow control renders settled rows only.
 */
export type RowBlock<A extends readonly unknown[], Y, VY, R = unknown> = ((
  ...args: A
) => Generator<Y, () => Generator<VY, R, any>, any>) &
  RowCheck<Y, VY, R>;

type RowCheck<Y, VY, R> = [Y] extends [SetupOp]
  ? [VY] extends [[R] extends [HView<any, any>] ? HViewOp : ViewOp]
    ? ViewPending<VY, R> extends false
      ? [ViewFails<VY, R>] extends [never]
        ? unknown
        : {
            readonly "[UNSETTLED_ROW] this row's view may fail: handle it inside the row with Errored": never;
          }
      : {
          readonly "[UNSETTLED_ROW] this row's view may be pending: handle it inside the row with Loading": never;
        }
    : {
        readonly "[ROW_VIEW_OP] a row block's view only reads: create state in its setup": never;
      }
  : {
      readonly "[ROW_SETUP_OP] a row block's setup only creates: read in its view": never;
    };

export type ErrorClass<E = unknown> = abstract new (...args: any[]) => E;

/**
 * What a block may fail with (D-034): an `Error` with a literal `kind`.
 * Failures are removed from a type structurally (TypeScript compares shapes)
 * but matched at run time with `instanceof`, so two error classes with the
 * same shape would be one type: the literal `kind` tells them apart. Every
 * entry point of a failure type checks it — `attempt`, `until`, `raise`,
 * `Errored`'s `catch`.
 */
export type Failure = Error & { readonly kind: string };
/** The branded refusal of an error type without a literal `kind`. */
export interface NeedsKind {
  readonly '[FAILURE_KIND] an error class needs `readonly kind = "x" as const` so its failure can be told apart': never;
}
/** `unknown` when every member of `E` is a `Failure` with a literal `kind`; else `NeedsKind`. */
export type KindCheck<E> = [E] extends [never]
  ? unknown
  : [KindBits<E>] extends [never]
    ? unknown
    : NeedsKind;
type KindBits<E> = E extends Error & { readonly kind: infer K }
  ? string extends K
    ? true
    : never
  : true;
