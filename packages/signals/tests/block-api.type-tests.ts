// Type-level contract of generator blocks v2 (checked by `tsc`, never executed):
// each block kind admits its operations, setters and creations type in plain
// TypeScript, and a component's pending / failures are part of its type.
import {
  $cleanup,
  $component,
  $effect,
  $event,
  $flush,
  $memo,
  $signal,
  $store,
  attempt,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  raise,
  type BlockComponent,
  type SourceAccessor,
  type TypedProps,
  type View
} from "../src/index.js";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
declare function assert<T extends true>(): void;

class NotFound extends Error {
  readonly kind = "not-found";
}
declare function fetchUser(id: string): Promise<{ name: string }>;
const Theme = createContext("light");
const [external] = createSignal(1);

// --- setup: creation, cleanup, context; results typed -------------------------
const Settled = $component(function* (props: TypedProps<{ label: string }>) {
  const theme = yield* Theme;
  assert<Equal<typeof theme, string>>();
  const [count, setCount] = yield* $signal(0);
  assert<Equal<typeof count, SourceAccessor<number>>>();
  const [store] = yield* $store({ n: 1 });
  const doubled = yield* $memo(function* () {
    return (yield* count) * 2;
  });
  yield* $effect(function* () {
    const next: number = yield* setCount(c => c + 1); // write → the new value
    yield* $cleanup(() => void next);
  });
  yield* $cleanup(() => {});
  const inc = $event(function* () {
    const n: number = yield* setCount(c => c + 1);
    yield* $flush();
    void n;
  });
  void inc;
  return function* () {
    const label: string = yield* props.label;
    const n: number = yield* doubled;
    const s: number = yield* store.n;
    return `${theme}${label}${n}${s}`;
  };
});
// Nothing async or fallible is read: the component is settled.
assert<Equal<typeof Settled, BlockComponent<{ label: string }, false, never>>>();

// --- setup may not read ---------------------------------------------------------
// @ts-expect-error a read in setup is not a setup operation
$component(function* () {
  yield* external;
  return function* () {
    return 1;
  };
});

// --- a view may not create ------------------------------------------------------
// @ts-expect-error creation in a view is not a view operation
$component(function* () {
  return function* () {
    yield* $signal(0);
    return 1;
  };
});

// --- memo: reads, async attempt, raise; no writes ---------------------------------
const Async = $component(function* (props: TypedProps<{ id: string }>) {
  const user = yield* $memo(function* () {
    const id = yield* props.id;
    const u = yield* attempt(() => fetchUser(id), NotFound);
    if (!u) yield* raise(new NotFound());
    return u;
  });
  return function* () {
    return (yield* user).name;
  };
});
// Reading an async, fallible memo: pending, fails with NotFound.
assert<Equal<typeof Async, BlockComponent<{ id: string }, true, NotFound>>>();

$component(function* () {
  const [, set] = yield* $signal(0);
  // @ts-expect-error a memo may not write
  yield* $memo(function* () {
    yield* set(1);
    return 1;
  });
  return function* () {
    return 1;
  };
});

// --- effect: no async ---------------------------------------------------------------
$component(function* () {
  // @ts-expect-error an effect may not suspend
  yield* $effect(function* () {
    yield* attempt(() => fetchUser("x"));
  });
  return function* () {
    return 1;
  };
});

// --- event: no creation or cleanup ----------------------------------------------------
// @ts-expect-error an event may not create
$event(function* () {
  yield* $signal(0);
});
// @ts-expect-error an event may not register cleanups
$event(function* () {
  yield* $cleanup(() => {});
});

// --- propagation: yield* Child(props) carries the child's effects ----------------------
const Parent = $component(function* () {
  return function* () {
    const child = yield* Async({ id: "1" });
    return child;
  };
});
assert<Equal<typeof Parent, BlockComponent<{}, true, NotFound>>>();

// A settled child adds nothing.
const Wrapper = $component(function* () {
  return function* () {
    return yield* Settled({ label: "x" });
  };
});
assert<Equal<typeof Wrapper, BlockComponent<{}, false, never>>>();

// Calling a component returns its view.
const v: View<true, NotFound> = Async({ id: "2" });
void v;

// --- interop: plain APIs accept generator bodies -----------------------------------------
const plainMemo = createMemo(function* () {
  return (yield* external) + 1;
});
assert<Equal<ReturnType<typeof plainMemo>, number>>();
createEffect(function* () {
  const n = yield* external;
  yield* $cleanup(() => void n);
});
// @ts-expect-error an effect block may not suspend
createEffect(function* () {
  yield* attempt(() => fetchUser("x"));
});
