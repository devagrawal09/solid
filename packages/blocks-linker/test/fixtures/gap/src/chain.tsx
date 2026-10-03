import {
  $component,
  $memo,
  $signal,
  attempt,
  raise,
  Loading,
  type TypedProps
} from "@solidjs/blocks";
import { Dynamic } from "@solidjs/web";

export class Missing extends Error {}
declare function load(): Promise<{ name: string }>;

// Grand → Middle (props.user passed through) → Card: Card's `user` is pending.
export const Card = $component(function* (props: TypedProps<{ user: { name: string } }, "Card">) {
  return function* () {
    return <b>{(yield* props.user).name}</b>;
  };
});

export const Middle = $component(function* (
  props: TypedProps<{ user: { name: string } }, "Middle">
) {
  return function* () {
    return (
      <div>
        <Card user={props.user} />
      </div>
    );
  };
});

export const Grand = $component(function* () {
  const user = yield* $memo(function* () {
    const u = yield* attempt(
      () => load(),
      () => new Missing()
    );
    if (!u.name) yield* raise(new Missing());
    return u;
  });
  const [label] = yield* $signal("x");
  return function* () {
    return (
      <Loading>
        <Middle user={user} />
        <Plain title="static" count={3} label={label} />
      </Loading>
    );
  };
});

// A settled caller: static and live facts only.
export const Plain = $component(function* (
  props: TypedProps<{ title: string; count: number; label: string }, "Plain">
) {
  return function* () {
    return (
      <i>
        {yield* props.title}
        {yield* props.count}
        {yield* props.label}
      </i>
    );
  };
});

// Used as a value: its callers are unknown, it keeps its declared type.
export const Hidden = $component(function* (
  props: TypedProps<{ user: { name: string } }, "Hidden">
) {
  return function* () {
    return <s>{(yield* props.user).name}</s>;
  };
});
export const UsesDynamic = $component(function* () {
  const user = yield* $memo(function* () {
    return yield* attempt(
      () => load(),
      () => new Missing()
    );
  });
  return function* () {
    return <Loading>{Dynamic({ component: Hidden, user } as any)}</Loading>;
  };
});
