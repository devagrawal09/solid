/*
 * Flow controls and boundaries for block apps: Solid's own, typed for
 * blocks, with render callbacks adapted so that
 *
 * - a callback's arguments are reads (`yield* item.title`, `yield* index`),
 *   never raw values that would be read without `yield*`;
 * - a callback may be a row block (a bare `function*`, or a named generator
 *   declared in a setup): its body is a setup that runs once per row and
 *   returns the row's view, as a `$component`'s does.
 *
 * Only the children are adapted; every other prop is forwarded as a getter,
 * so the flow control reads it where it always did.
 */
import {
  createComponent,
  Errored as SolidErrored,
  For as SolidFor,
  Loading as SolidLoading,
  Match as SolidMatch,
  Repeat as SolidRepeat,
  Show as SolidShow,
  Switch as SolidSwitch,
  untrack,
  type Accessor
} from "solid-js";
import { BOUNDARY, READ, VIEW_MARK, isRowBlock, rowArg, runRow, throughHole } from "./runtime.js";
import type { Element } from "./element.js";
import type {
  ErrorClass,
  COMPONENT,
  FailsOf,
  HoleOp,
  HView,
  Path,
  PendingOf,
  Read,
  RowBlock,
  SettledView,
  Source,
  View
} from "./types.js";
import type { Hole, OpsOfHole } from "./holes.js";

/** No-JSX output of a flow control: its source's coloring joined with its content's. */
type FlowOutput<P extends boolean, E, C> = HView<
  PendingOf<Read<P, E> | OpsOfHole<C>>,
  FailsOf<Read<P, E> | OpsOfHole<C>>
>;

/** A no-JSX hole as a flow control's source prop: a bare zero-arity `function*`. */
type GeneratorHole<Y, T> = () => Generator<Y, T, any>;

/** Flow controls are components (`<${For} …>` in `html`, `h(For, …)`). */
type Branded = { readonly [COMPONENT]: true };

/** Forward every prop as a getter, replacing `children` (and `fallback` when given). */
function forward(props: any, adaptChildren: (children: unknown) => unknown): any {
  const out: any = {};
  for (const key of Object.keys(props)) {
    if (key === "children") continue;
    // A source passed straight to a flow control (`each={todos}` in `h`, or
    // a call `For({ each: todos, … })`) is read where the prop is read; so is
    // a bare `function*` hole (`Show({ when: function* () { … } })`).
    Object.defineProperty(out, key, { get: () => throughHole(props[key]), enumerable: true });
  }
  // Children stay as lazy as they were written: JSX element children are a
  // getter the flow control reads when (and each time) it renders the branch
  // — reading it here would build the content once, eagerly, outside the
  // branch; a render callback is a plain value, adapted once.
  const d = Object.getOwnPropertyDescriptor(props, "children");
  if (d && d.get) {
    Object.defineProperty(out, "children", {
      get: () => adaptChildren(props.children),
      enumerable: true
    });
  } else if (d) out.children = adaptChildren(d.value);
  return out;
}

/**
 * Adapt a render callback. `args` maps the flow control's raw render
 * arguments to reads; `arity` is the arity the flow control expects to see.
 */
function adapt(cb: unknown, args: (...raw: any[]) => unknown[], arity: number): unknown {
  if (typeof cb !== "function") return cb;
  // A view that is a function (a component re-rendering as a whole, an
  // adopted lazy page) is content, not a render callback.
  if ((cb as any)[VIEW_MARK] === true) return cb;
  const row = isRowBlock(cb);
  if (!row && (cb as any)[READ] !== undefined) return cb;
  const run = row
    ? (...raw: any[]) => runRow(cb as any, args(...raw))
    : (...raw: any[]) => (cb as any)(...args(...raw));
  if (arity === 2) return (a: any, b: any) => run(a, b);
  return (a: any) => run(a);
}

// --- For ------------------------------------------------------------------------------------------

type EachOf<T> = T extends readonly (infer U)[] ? U : never;
type ForProps<T extends readonly any[]> = {
  each: T | undefined | null | false | Source<T | undefined | null | false, false, never>;
  fallback?: Element;
  keyed?: boolean | ((item: EachOf<T>) => any);
};

/**
 * `<For each={yield* todos}>{todo => <TodoItem todo={todo} />}</For>`, or
 * with per-row state, `{function* (todo) { setup; return function* () { view } }}`.
 * The row's item is a read (`yield* todo.title`), its index a source.
 */
function ForBlocks<T extends readonly any[], Y, VY, R>(
  props: ForProps<T> & {
    children: RowBlock<[item: Path<EachOf<T>>, index: Source<number>], Y, VY, R>;
  }
): SettledView;
function ForBlocks<T extends readonly any[]>(
  props: ForProps<T> & {
    children: (item: Path<EachOf<T>>, index: Source<number>) => Element;
  }
): SettledView;
/**
 * No-JSX, `each` a bare `function*` hole (`For({ each: function* () { … }, … })`):
 * the output carries the hole's coloring and the rows' `h` output's.
 */
function ForBlocks<T extends readonly any[], Y extends HoleOp, C extends Hole>(props: {
  each: GeneratorHole<Y, T | undefined | null | false>;
  fallback?: Hole;
  keyed?: boolean | ((item: EachOf<T>) => any);
  children: (item: Path<EachOf<T>>, index: Source<number>) => C;
}): FlowOutput<PendingOf<Y>, FailsOf<Y>, C>;
/**
 * No-JSX (`For({ each: todos, children: todo => h(TodoItem, { todo }) })`):
 * `each` may be a pending source; the output carries its coloring and the
 * rows' `h` output's.
 */
function ForBlocks<T extends readonly any[], P extends boolean, E, C extends Hole>(props: {
  each: Source<T | undefined | null | false, P, E> | T | undefined | null | false;
  fallback?: Hole;
  keyed?: boolean | ((item: EachOf<T>) => any);
  children: (item: Path<EachOf<T>>, index: Source<number>) => C;
}): FlowOutput<P, E, C>;
function ForBlocks(props: any): any {
  const keyedFalse = props.keyed === false;
  return SolidFor(
    forward(props, children =>
      adapt(
        children,
        (item: any, index: any) => [
          rowArg(item, keyedFalse),
          rowArg(index, typeof index === "function")
        ],
        typeof children === "function" && children.length > 1 ? 2 : 1
      )
    )
  );
}

// --- Repeat ---------------------------------------------------------------------------------------

type RepeatProps = {
  count: number | Source<number, false, never>;
  from?: number | undefined;
  fallback?: Element;
};
/** `<Repeat count={n}>{function* (index) { … }}</Repeat>`: the index is a source. */
function RepeatBlocks<Y, VY, R>(
  props: RepeatProps & { children: RowBlock<[index: Source<number>], Y, VY, R> }
): SettledView;
function RepeatBlocks(
  props: RepeatProps & { children: ((index: Source<number>) => Element) | Element }
): SettledView;
function RepeatBlocks(props: any): any {
  return SolidRepeat(
    forward(props, children => adapt(children, (index: number) => [rowArg(index, false)], 1))
  );
}

// --- Show / Match -------------------------------------------------------------------------------

type Cond<T> = T | undefined | null | false | Source<T | undefined | null | false, false, never>;
type ShowProps<T> = { when: Cond<T>; keyed?: boolean; fallback?: Element };

/**
 * `<Show when={yield* user}>{u => <p>{yield* u.name}</p>}</Show>` — the
 * branch's value is a read — or a row block with its own setup.
 */
/**
 * No-JSX, `when` a bare `function*` hole (`Show({ when: function* () { … }, … })`):
 * the output carries the hole's coloring and the content's.
 */
function ShowBlocks<T, Y extends HoleOp, C extends Hole>(props: {
  when: GeneratorHole<Y, T | undefined | null | false>;
  keyed?: boolean;
  fallback?: Hole;
  children: C | ((value: Path<NonNullable<T>>) => C);
}): FlowOutput<PendingOf<Y>, FailsOf<Y>, C>;
function ShowBlocks<T, Y, VY, R>(
  props: ShowProps<T> & { children: RowBlock<[value: Path<NonNullable<T>>], Y, VY, R> }
): SettledView;
function ShowBlocks<T>(
  props: ShowProps<T> & { children: Element | ((value: Path<NonNullable<T>>) => Element) }
): SettledView;
/**
 * No-JSX (`Show({ when: open, children: h(…) })`): `when` may be a pending
 * source; the output carries its coloring and the content's.
 */
function ShowBlocks<T, P extends boolean, E, C extends Hole>(props: {
  when: Source<T | undefined | null | false, P, E> | T | undefined | null | false;
  keyed?: boolean;
  fallback?: Hole;
  children: C | ((value: Path<NonNullable<T>>) => C);
}): FlowOutput<P, E, C>;
function ShowBlocks(props: any): any {
  const keyed = !!props.keyed;
  return SolidShow(
    forward(props, children => adapt(children, (value: any) => [rowArg(value, !keyed)], 1))
  );
}

/** `<Switch>` over `<Match>`es. */
export const Switch: ((props: { fallback?: Element; children: Element }) => SettledView) & Branded =
  SolidSwitch as any;

type MatchProps<T> = { when: Cond<T>; keyed?: boolean };
/** A branch of `<Switch>`; its render callback may be a row block. */
function MatchBlocks<T, Y, VY, R>(
  props: MatchProps<T> & { children: RowBlock<[value: Path<NonNullable<T>>], Y, VY, R> }
): SettledView;
function MatchBlocks<T>(
  props: MatchProps<T> & { children: Element | ((value: Path<NonNullable<T>>) => Element) }
): SettledView;
function MatchBlocks(props: any): any {
  const keyed = !!props.keyed;
  return SolidMatch(
    forward(props, children => adapt(children, (value: any) => [rowArg(value, !keyed)], 1))
  );
}

// --- boundaries ---------------------------------------------------------------------------------

declare const __DEV__: boolean;

/** Whether a value is an `h` / automatic-`jsx` element thunk (built where it is inserted). */
function isElementThunk(value: any): boolean {
  const symbols = Object.getOwnPropertySymbols(value);
  for (let i = 0; i < symbols.length; i++)
    if (symbols[i].description === "hyper-element") return true;
  return false;
}

/** Content that was built before the boundary: a component's DOM. */
function isBuilt(value: any): boolean {
  if (value == null) return false;
  if (Array.isArray(value)) return value.some(isBuilt);
  return typeof Node !== "undefined" && value instanceof Node;
}

/**
 * A boundary's content. JSX children arrive as a getter (built inside the
 * boundary, and again after a reset). In the call form the content is what
 * the caller passed: `children: () => UserCard({ user })` is built inside
 * the boundary; `children: UserCard({ user })` was built before it — its
 * pending reads and failures reach the boundary above instead — and is a
 * dev error. (`h` output is built where it is inserted: either is fine.)
 */
function content(props: any, name: string): () => unknown {
  const d = Object.getOwnPropertyDescriptor(props, "children");
  if (!d || d.get) return () => props.children;
  const v = d.value;
  if (
    typeof v === "function" &&
    v[READ] === undefined &&
    v[VIEW_MARK] !== true &&
    !isElementThunk(v)
  )
    return v;
  if (__DEV__ && isBuilt(v))
    throw new Error(
      `[BOUNDARY_CONTENT_BUILT] ${name}'s content was built before the boundary: pass it as a function (\`children: () => View()\`) or use the tag form.`
    );
  return () => v;
}

/**
 * Handles pending below it. Tag form takes settled or pending children
 * (`<Loading fallback={…}>{UserCard({ user })}</Loading>`); it returns a
 * view without pending, so failures still have to be handled above.
 * `on` may be a source (`Loading({ on: props.room, … })`): it is read where
 * Solid's `Loading` reads it, so the call form keys the boundary too.
 */
function LoadingBlocks(props: { fallback?: Element; on?: unknown; children: Element }): SettledView;
function LoadingBlocks<P extends boolean, E>(props: {
  fallback?: Element;
  on?: unknown;
  children: View<P, E> | readonly View<P, E>[] | (() => View<P, E> | readonly View<P, E>[]);
}): View<false, E>;
function LoadingBlocks(props: any): any {
  const children = content(props, "Loading");
  // `on` may be a source: every other prop is read through where it is read
  const out: any = {};
  for (const key of Object.keys(props))
    if (key !== "children")
      Object.defineProperty(out, key, { get: () => throughHole(props[key]), enumerable: true });
  Object.defineProperty(out, "children", { get: children, enumerable: true });
  return SolidLoading(out);
}

/**
 * Handles failures below it. The fallback receives the error (typed with the
 * failures of the children) and a `reset`. `$event` failures under it are
 * routed here.
 *
 * With `catch` it handles only those error types: `<Errored catch={[NotFound]}
 * fallback={err => …}>` removes `NotFound` from its children's failures (the
 * rest still have to be handled above), its fallback receives a `NotFound`,
 * and any other failure is rethrown to the boundary above. Each error type is
 * its own color: give each class a member of its own (`readonly kind =
 * "not-found"`), or TypeScript cannot tell two of them apart.
 */
function ErroredBlocks<P extends boolean, E, C extends readonly ErrorClass[]>(props: {
  catch: C;
  fallback: Element | ((error: Accessor<InstanceType<C[number]>>, reset: () => void) => Element);
  children: View<P, E> | readonly View<P, E>[] | (() => View<P, E> | readonly View<P, E>[]);
}): View<P, Exclude<E, InstanceType<C[number]>>>;
function ErroredBlocks(props: {
  fallback: Element | ((error: Accessor<unknown>, reset: () => void) => Element);
  children: Element;
}): SettledView;
function ErroredBlocks<P extends boolean, E>(props: {
  fallback: Element | ((error: Accessor<E>, reset: () => void) => Element);
  children: View<P, E> | readonly View<P, E>[] | (() => View<P, E> | readonly View<P, E>[]);
}): View<P, never>;
function ErroredBlocks(props: any): any {
  const children = content(props, "Errored");
  const fallback = props.fallback as any;
  const handles = props.catch as readonly ErrorClass[] | undefined;
  const adapted =
    typeof fallback === "function" && isRowBlock(fallback)
      ? (err: Accessor<unknown>, reset: () => void) => runRow(fallback, [rowArg(err, true), reset])
      : undefined;
  return SolidErrored({
    get fallback() {
      const render = adapted || props.fallback;
      if (!handles) return render;
      // only the listed error types: any other goes to the boundary above
      return (err: Accessor<unknown>, reset: () => void) => {
        const error = err();
        if (!handles.some(C => error instanceof (C as any))) throw error;
        return typeof render === "function" ? render(err, reset) : render;
      };
    },
    get children() {
      return createComponent(BOUNDARY as any, {
        value: true,
        get children() {
          return children();
        }
      });
    }
  } as any) as any;
}

/**
 * Created untracked, as a JSX tag is (`createComponent`): called inside a
 * view's hole (`{yield* Loading({ … })}`), a flow control's creation must
 * not subscribe the hole — the hole would re-create it, and its content, on
 * every change the flow control reads.
 */
function untracked(fn: (props: any) => any): any {
  return (props: any) => {
    const out = untrack(() => fn(props));
    // its output is a view: `yield*` / `perform` passes it on unread
    if (typeof out === "function") out[VIEW_MARK] = true;
    return out;
  };
}

export const For: typeof ForBlocks & Branded = untracked(ForBlocks);
export const Repeat: typeof RepeatBlocks & Branded = untracked(RepeatBlocks);
export const Show: typeof ShowBlocks & Branded = untracked(ShowBlocks);
export const Match: typeof MatchBlocks & Branded = untracked(MatchBlocks);
export const Loading: typeof LoadingBlocks & Branded = untracked(LoadingBlocks);
export const Errored: typeof ErroredBlocks & Branded = untracked(ErroredBlocks);
