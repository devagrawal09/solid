/**
 * @jsxImportSource @solidjs/web
 */
// Generator blocks v2 at the JSX level (checked by `tsc`, never executed): a
// component's pending / failures travel with its view, JSX admits settled
// views only, and Loading / Errored remove what they handle.
import {
  $component,
  $memo,
  $signal,
  attempt,
  Errored,
  Loading,
  raise,
  type TypedProps,
  type View
} from "solid-js";
import { render } from "../src/index.js";

class NotFound extends Error {
  readonly kind = "not-found";
}
declare function fetchUser(id: string): Promise<{ name: string }>;
declare const root: HTMLElement;

const Settled = $component(function* (props: TypedProps<{ label: string }>) {
  const [count] = yield* $signal(0);
  return function* () {
    return (
      <p>
        {yield* props.label}: {yield* count}
      </p>
    );
  };
});

// Async only (pending, no declared failures).
const Pending = $component(function* (props: TypedProps<{ id: string }>) {
  const user = yield* $memo(function* () {
    return yield* attempt(() => fetchUser("x"));
  });
  void props;
  return function* () {
    return <h3>{(yield* user).name}</h3>;
  };
});

// Async and fallible.
const Fallible = $component(function* (props: TypedProps<{ id: string }>) {
  const user = yield* $memo(function* () {
    const id = yield* props.id;
    const u = yield* attempt(() => fetchUser(id), NotFound);
    if (!u.name) yield* raise(new NotFound());
    return u;
  });
  return function* () {
    return <h3>{(yield* user).name}</h3>;
  };
});

// --- settled components are ordinary tags and children ------------------------
const ok1 = <Settled label="a" />;
const ok2 = <div>{Settled({ label: "b" })}</div>;

// --- an unhandled pending / failure is a type error ----------------------------
// @ts-expect-error Pending can suspend: not a valid JSX element
const bad1 = <Pending id="1" />;
// @ts-expect-error a pending view is not an element
const bad2 = <div>{Pending({ id: "1" })}</div>;

// --- Loading removes pending; Errored removes failures -----------------------------
const ok3 = <div>{Loading({ fallback: <p>…</p>, children: Pending({ id: "1" }) })}</div>;
// Loading alone leaves Fallible's failures:
// @ts-expect-error still fails with NotFound
const bad3 = <div>{Loading({ fallback: <p>…</p>, children: Fallible({ id: "1" }) })}</div>;
const ok4 = (
  <div>
    {Errored({
      fallback: err => <p>{err().kind}</p>, // the fallback's error is typed
      children: Loading({ fallback: <p>…</p>, children: Fallible({ id: "1" }) })
    })}
  </div>
);
const handled: View<false, never> = Errored({
  fallback: <p>error</p>,
  children: Loading({ children: Fallible({ id: "1" }) })
});

// --- yield* Child(props) propagates to the parent ----------------------------------
const Parent = $component(function* () {
  return function* () {
    return <section>{yield* Fallible({ id: "1" })}</section>;
  };
});
// @ts-expect-error Parent inherits Fallible's pending and failures
const bad4 = <Parent />;
const HandledParent = $component(function* () {
  return function* () {
    return (
      <section>
        {Errored({
          fallback: <p>error</p>,
          children: Loading({ children: Fallible({ id: "1" }) })
        })}
      </section>
    );
  };
});
const ok5 = <HandledParent />;

// --- render: the root must be settled ------------------------------------------------
render(() => <HandledParent />, root);
// @ts-expect-error the root would suspend and may fail
render(() => <Parent />, root);

void [ok1, ok2, ok3, ok4, ok5, bad1, bad2, bad3, bad4, handled];
