/*
 * Flow controls and boundaries for block apps: Solid's own, typed for
 * blocks, with render callbacks adapted so that
 *
 * - a callback's arguments are reads (`yield* item.title`, `yield* index`),
 *   never raw values that would be read without `yield*`;
 * - a callback may be a row block (a bare `function*`, `$(function* (x) …)`,
 *   `$scope(…)`, or a named generator declared in a setup) with its own
 *   setup and view.
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
  type Accessor
} from "solid-js";
import { BODY, BOUNDARY, READ, isRowBlock, rowArg, runRow } from "./runtime.js";
import type { Element } from "./element.js";
import type { Path, RowBlock, Source, View } from "./types.js";

/** Forward every prop as a getter, replacing `children` (and `fallback` when given). */
function forward(props: any, overrides: Record<string, unknown>): any {
  const out: any = {};
  for (const key of Object.keys(props)) {
    if (key in overrides) continue;
    Object.defineProperty(out, key, { get: () => props[key], enumerable: true });
  }
  for (const key in overrides) out[key] = overrides[key];
  return out;
}

function bodyOf(fn: any): any {
  return fn[BODY] || fn;
}

/**
 * Adapt a render callback. `args` maps the flow control's raw render
 * arguments to reads; `arity` is the arity the flow control expects to see.
 */
function adapt(cb: unknown, args: (...raw: any[]) => unknown[], arity: number): unknown {
  if (typeof cb !== "function") return cb;
  const isBlock = (cb as any)[BODY] !== undefined;
  const row = isBlock || isRowBlock(cb);
  if (!row && (cb as any)[READ] !== undefined) return cb;
  const run = row
    ? (...raw: any[]) => runRow(bodyOf(cb), args(...raw))
    : (...raw: any[]) => (cb as any)(...args(...raw));
  if (arity === 2) return (a: any, b: any) => run(a, b);
  return (a: any) => run(a);
}

// --- For ------------------------------------------------------------------------------------------

type EachOf<T> = T extends readonly (infer U)[] ? U : never;
type ForProps<T extends readonly any[]> = {
  each: T | undefined | null | false;
  fallback?: Element;
  keyed?: boolean | ((item: EachOf<T>) => any);
};

/**
 * `<For each={yield* todos}>{todo => <TodoItem todo={todo} />}</For>`, or
 * with per-row state, `{function* (todo) { setup; return function* () { view } }}`.
 * The row's item is a read (`yield* todo.title`), its index a source.
 */
export function For<T extends readonly any[], Y, VY, R>(
  props: ForProps<T> & {
    children: RowBlock<[item: Path<EachOf<T>>, index: Source<number>], Y, VY, R>;
  }
): Element;
export function For<T extends readonly any[]>(
  props: ForProps<T> & {
    children: (item: Path<EachOf<T>>, index: Source<number>) => Element;
  }
): Element;
export function For(props: any): any {
  const keyedFalse = props.keyed === false;
  const children = props.children;
  const arity = typeof children === "function" && children.length > 1 ? 2 : 1;
  return SolidFor(
    forward(props, {
      children: adapt(
        children,
        (item: any, index: any) => [
          rowArg(item, keyedFalse),
          rowArg(index, typeof index === "function")
        ],
        arity
      )
    })
  );
}

// --- Repeat ---------------------------------------------------------------------------------------

type RepeatProps = { count: number; from?: number | undefined; fallback?: Element };
/** `<Repeat count={n}>{function* (index) { … }}</Repeat>`: the index is a source. */
export function Repeat<Y, VY, R>(
  props: RepeatProps & { children: RowBlock<[index: Source<number>], Y, VY, R> }
): Element;
export function Repeat(
  props: RepeatProps & { children: ((index: Source<number>) => Element) | Element }
): Element;
export function Repeat(props: any): any {
  return SolidRepeat(
    forward(props, {
      children: adapt(props.children, (index: number) => [rowArg(index, false)], 1)
    })
  );
}

// --- Show / Match -------------------------------------------------------------------------------

type Cond<T> = T | undefined | null | false;
type ShowProps<T> = { when: Cond<T>; keyed?: boolean; fallback?: Element };

/**
 * `<Show when={yield* user}>{u => <p>{yield* u.name}</p>}</Show>` — the
 * branch's value is a read — or a row block with its own setup.
 */
export function Show<T, Y, VY, R>(
  props: ShowProps<T> & { children: RowBlock<[value: Path<NonNullable<T>>], Y, VY, R> }
): Element;
export function Show<T>(
  props: ShowProps<T> & { children: Element | ((value: Path<NonNullable<T>>) => Element) }
): Element;
export function Show(props: any): any {
  const keyed = !!props.keyed;
  return SolidShow(
    forward(props, {
      children: adapt(props.children, (value: any) => [rowArg(value, !keyed)], 1)
    })
  );
}

/** `<Switch>` over `<Match>`es. */
export const Switch: (props: { fallback?: Element; children: Element }) => Element =
  SolidSwitch as any;

type MatchProps<T> = { when: Cond<T>; keyed?: boolean };
/** A branch of `<Switch>`; its render callback may be a row block. */
export function Match<T, Y, VY, R>(
  props: MatchProps<T> & { children: RowBlock<[value: Path<NonNullable<T>>], Y, VY, R> }
): Element;
export function Match<T>(
  props: MatchProps<T> & { children: Element | ((value: Path<NonNullable<T>>) => Element) }
): Element;
export function Match(props: any): any {
  const keyed = !!props.keyed;
  return SolidMatch(
    forward(props, {
      children: adapt(props.children, (value: any) => [rowArg(value, !keyed)], 1)
    })
  );
}

// --- boundaries ---------------------------------------------------------------------------------

/**
 * Handles pending below it. Tag form takes settled or pending children
 * (`<Loading fallback={…}>{UserCard({ user })}</Loading>`); it returns a
 * view without pending, so failures still have to be handled above.
 */
export function Loading<P extends boolean = false, E = never>(props: {
  fallback?: Element;
  on?: unknown;
  children: View<P, E> | Element;
}): View<false, E> {
  return SolidLoading(props as any) as any;
}

/**
 * Handles failures below it. The fallback receives the error (typed with the
 * failures of the children) and a `reset`. `$event` failures under it are
 * routed here.
 */
export function Errored<P extends boolean = false, E = unknown>(props: {
  fallback: Element | ((error: Accessor<E>, reset: () => void) => Element);
  children: View<P, E> | Element;
}): View<P, never> {
  const fallback = props.fallback as any;
  const adapted =
    typeof fallback === "function" && (isRowBlock(fallback) || fallback[BODY] !== undefined)
      ? (err: Accessor<unknown>, reset: () => void) =>
          runRow(bodyOf(fallback), [rowArg(err, true), reset])
      : undefined;
  return SolidErrored({
    get fallback() {
      return adapted || props.fallback;
    },
    get children() {
      return createComponent(BOUNDARY as any, {
        value: true,
        get children() {
          return props.children;
        }
      });
    }
  } as any) as any;
}
