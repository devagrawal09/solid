/**
 * The strict rules, JSX flavor — checked by `tsc -p tsconfig.json`, never
 * executed. Every `@ts-expect-error` is a rule the editor enforces; every
 * line without one must typecheck.
 */
import { lazy } from "solid-js";
import {
  $,
  adopt,
  $component,
  $effect,
  $event,
  $memo,
  $signal,
  $store,
  attempt,
  start,
  Errored,
  For,
  Loading,
  raise,
  readStore,
  render,
  Repeat,
  Show,
  type Source,
  type TypedProps,
  type View,
  type EventHandler
} from "@solidjs/blocks";

declare const root: HTMLElement;
declare function fetchUser(id: string): Promise<{ name: string }>;
/** Pending until its first value, and never failing (as a server border states it). */
declare const pendingUser: Source<{ name: string }, true, never>;
class NotFound extends Error {
  readonly kind = "not-found";
}

// --- setup creates; views and memos read; reads only via yield* -------------------------
export const Settled = $component(function* (props: TypedProps<{ label: string }>) {
  const [count, setCount] = yield* $signal(0);
  const [store] = yield* $store({ todos: [{ title: "a" }] });
  const doubled = yield* $memo(function* () {
    return (yield* count) * 2;
  });
  const inc = $event(function* () {
    const v = yield* setCount(c => c + 1);
    void v;
  });
  return function* () {
    return (
      <p onClick={inc} title={yield* props.label}>
        {yield* props.label}: {yield* doubled} {yield* store.todos[0].title}{" "}
        {yield* readStore(store, s => s.todos.length)}
      </p>
    );
  };
});
export const ok1 = <Settled label="a" />;

// $event is an action: it takes arguments and returns a promise of its result
const save = $event(function* (id: string, times: number) {
  return id.repeat(times);
});
export const saved: Promise<string | undefined> = save("a", 2);
// @ts-expect-error its arguments are typed
export const savedMissingArg = save("a");

// @ts-expect-error a setup does not read
export const ReadsInSetup = $component(function* () {
  const [count] = yield* $signal(0);
  const v = yield* count;
  return function* () {
    return <p>{v}</p>;
  };
});
// @ts-expect-error a view does not create
export const CreatesInView = $component(function* () {
  return function* () {
    const [count] = yield* $signal(0);
    return <p>{yield* count}</p>;
  };
});
export const HiddenRead = $component(function* () {
  const [count] = yield* $signal(0);
  return function* () {
    // @ts-expect-error a source is not callable: reads are `yield*`
    return <p>{count()}</p>;
  };
});
export const WritesInMemo = $component(function* () {
  const [count, setCount] = yield* $signal(0);
  // @ts-expect-error a memo does not write
  const m = yield* $memo(function* () {
    yield* setCount(1);
    return yield* count;
  });
  return function* () {
    return <p>{yield* m}</p>;
  };
});
// @ts-expect-error a view does not write
export const WritesInView = $component(function* () {
  const [, setCount] = yield* $signal(0);
  return function* () {
    const n = yield* setCount(1);
    return <p>{n}</p>;
  };
});

// --- no async function* blocks ---------------------------------------------------------------
// @ts-expect-error blocks are function*, never async function*
export const asyncMemo = $memo(async function* () {
  return 1;
});
// @ts-expect-error an effect's attempt is synchronous (Wait is not an EffectOp)
export const asyncInEffect = $effect(function* () {
  yield* attempt(
    () => fetchUser("1"),
    () => new NotFound()
  );
});

// --- only settled values render -------------------------------------------------------------
// pending, and nothing it reads can fail
export const Pending = $component(function* (props: TypedProps<{ id: string }>) {
  const user = $(function* () {
    yield* props.id;
    return yield* pendingUser;
  });
  return function* () {
    return <h3>{(yield* user).name}</h3>;
  };
});
export const Fallible = $component(function* (props: TypedProps<{ id: string }>) {
  const user = yield* $memo(function* () {
    const id = yield* props.id;
    const u = yield* attempt(
      () => fetchUser(id),
      () => new NotFound()
    );
    if (!u.name) yield* raise(new NotFound());
    return u;
  });
  return function* () {
    return <h3>{(yield* user).name}</h3>;
  };
});
// A memo with a loadingValue is never pending on read (commit #0 is the value)
export const Seeded = $component(function* (props: TypedProps<{ id: string }>) {
  const user = yield* $memo(
    function* () {
      const id = yield* props.id;
      return yield* attempt(
        () => fetchUser(id),
        () => new NotFound()
      );
    },
    { loadingValue: { name: "…" } }
  );
  // never pending (commit #0 is the value); it fails as its attempt does
  const seeded: Source<{ name: string }, false, NotFound> = user;
  void seeded;
  return function* () {
    return <h3>{(yield* user).name}</h3>;
  };
});
// never pending: an Errored alone renders it
export const seededOk = <Errored fallback="!">{Seeded({ id: "1" })}</Errored>;
const pendingView: View<true, never> = Pending({ id: "1" });
const fallibleView: View<true, NotFound> = Fallible({ id: "1" });
void [pendingView, fallibleView];

// @ts-expect-error Pending can suspend: not a valid JSX element outside a Loading
export const bad1 = <Pending id="1" />;
// @ts-expect-error a pending view is not an element
export const bad2 = <div>{Pending({ id: "1" })}</div>;
export const ok2 = <Loading fallback={<p>…</p>}>{Pending({ id: "1" })}</Loading>;
// the call form takes its content as a function (built inside the boundary)
export const ok3 = (
  <div>{Loading({ fallback: <p>…</p>, children: () => Pending({ id: "1" }) })}</div>
);
// @ts-expect-error Loading handles pending, not NotFound
export const bad3 = <Loading>{Fallible({ id: "1" })}</Loading>;
export const ok4 = (
  <Errored fallback={err => <p>{err().kind}</p>}>
    {Loading({ fallback: <p>…</p>, children: Fallible({ id: "1" }) })}
  </Errored>
);

// yield* Child(props) propagates to the parent
export const Parent = $component(function* () {
  return function* () {
    return <section>{yield* Fallible({ id: "1" })}</section>;
  };
});
// @ts-expect-error Parent inherits Fallible's pending and failures
export const bad4 = <Parent />;
export const ok5 = (
  <Errored fallback={<p>error</p>}>{Loading({ children: () => Parent() })}</Errored>
);

// the root must be settled
const ok5Root = $component(function* () {
  return function* () {
    return <Settled label="x" />;
  };
});
render(() => <Settled label="x" />, root);
render(ok5Root, root);
// @ts-expect-error Settled needs its props
render(Settled, root);
// @ts-expect-error the root would suspend and may fail
render(() => Parent(), root);

// --- no hidden reads in holes ------------------------------------------------------------------
export const Thunks = $component(function* () {
  const [n] = yield* $signal(1);
  const [user] = yield* $signal({ name: "x" });
  return function* () {
    // @ts-expect-error a plain thunk is not a child: read with yield*
    const a = <div>{() => 1}</div>;
    // @ts-expect-error a source is not a child: read it with yield*
    const b = <div>{n}</div>;
    // @ts-expect-error a plain thunk is not an attribute value
    const c = <p title={() => "x"} />;
    const ok = <p title={(yield* user).name}>{yield* n}</p>;
    return [a, b, c, ok];
  };
});

// --- blocks as children (settled only) and as attribute values ----------------------------
export const Blocks = $component(function* () {
  const [n] = yield* $signal(1);
  const user = pendingUser;
  const doubled = $(function* () {
    return (yield* n) * 2;
  });
  const name = $(function* () {
    return (yield* user).name;
  });
  const big = $(function* () {
    return (yield* n) > 1 ? "big" : "";
  });
  return function* () {
    const settledChild = <div>{doubled}</div>;
    // @ts-expect-error a pending block is not an element
    const pendingChild = <div>{name}</div>;
    const asAttribute = <p title={String(yield* doubled)} class={yield* big} />;
    return [settledChild, pendingChild, asAttribute];
  };
});
// a block read in an attribute counts in the view: this view may be pending
export const PendingAttribute = $component(function* () {
  const user = pendingUser;
  const name = $(function* () {
    return (yield* user).name;
  });
  return function* () {
    return <p title={yield* name} />;
  };
});
// @ts-expect-error PendingAttribute may be pending
export const bad5 = <PendingAttribute />;

// --- row blocks ---------------------------------------------------------------------------------
type Comment = { id: number; text: string; kids: Comment[] };
declare const comments: Comment[];
export const Rows = $component(function* () {
  function* comment(c: Source<Comment> & { kids: Source<Comment[]>; text: Source<string> }) {
    const [open] = yield* $signal(true);
    return function* () {
      return (
        <li>
          {yield* c.text}
          <Show when={yield* open}>
            <For each={yield* c.kids}>{comment}</For>
          </Show>
        </li>
      );
    };
  }
  return function* () {
    return (
      <ul>
        <For each={comments}>{comment}</For>
        <For each={comments}>
          {function* (c, i) {
            const [open, setOpen] = yield* $signal(false);
            const toggle = $event(function* () {
              yield* setOpen(o => !o);
            });
            return function* () {
              return (
                <li onClick={toggle}>
                  {yield* i}: {yield* c.text} {(yield* open) ? "-" : "+"}
                </li>
              );
            };
          }}
        </For>
        <For each={comments}>{c => <Settled label={c.text} />}</For>
        <Repeat count={2}>
          {function* (i) {
            return function* () {
              return <b>{yield* i}</b>;
            };
          }}
        </Repeat>
        <For each={comments}>
          {/* @ts-expect-error the row's view is pending: handle it inside the row */}
          {function* (c) {
            return function* () {
              return <li>{yield* Pending({ id: String(yield* c.id) })}</li>;
            };
          }}
        </For>
        <For each={comments}>
          {function* (c) {
            return function* () {
              return <li>{Loading({ children: () => Pending({ id: c.text }) })}</li>;
            };
          }}
        </For>
      </ul>
    );
  };
});

// --- paths through nullable values and nested sources --------------------------------------------
export const Nullable = $component(function* (props: TypedProps<{ me: { name: string } | null }>) {
  return function* () {
    // through a nullable object a key may read `undefined`
    const name: Source<string | undefined> = props.me.name;
    return <b>{yield* name}</b>;
  };
});
declare const wire: { status: Source<"on" | "off", true, NotFound> };
// a key holding a source reads through it, with its coloring
export const Through = $component(function* (props: TypedProps<{ wire: typeof wire }>) {
  return function* () {
    const status: Source<"on" | "off", boolean, NotFound> = props.wire.status;
    return <b>{yield* status}</b>;
  };
});
// @ts-expect-error the status may be pending and fail: so may Through's view
export const bad6 = <Through wire={wire} />;

// --- a prop declared as a source states the coloring its readers handle ----------------------------
export const Declared = $component(function* (
  props: TypedProps<{ user: Source<{ name: string }, true, unknown> }>
) {
  return function* () {
    return <b>{(yield* props.user).name}</b>;
  };
});
declare const settledUser: Source<{ name: string }>;
// callers pass any source within it (a settled one too) or the value
export const ok6 = (
  <Errored fallback="!">{Loading({ children: () => Declared({ user: settledUser }) })}</Errored>
);
export const ok7 = (
  <Errored fallback="!">{Loading({ children: () => Declared({ user: { name: "a" } }) })}</Errored>
);
// @ts-expect-error a declared source's reads are pending and may fail
export const bad7 = <Declared user={settledUser} />;

// --- a memo over a promise of a stream is the stream's values (Solid flattens one level) ---------
declare function stream(): Promise<AsyncIterable<number>>;
export const Streamed = $component(function* () {
  const n = yield* $memo(function* () {
    return yield* attempt(
      () => stream(),
      () => new NotFound()
    );
  });
  // pending (a stream), failing as its attempt's handler says
  const typed: Source<number, true, NotFound> = n;
  return function* () {
    return <b>{yield* typed}</b>;
  };
});
export const StreamedWithoutAttempt = $component(function* () {
  // @ts-expect-error a body returns a promise or a stream through attempt
  const n = yield* $memo(function* () {
    return stream();
  });
  void n;
  return function* () {
    return <b />;
  };
});

// --- adopt: a lazily loaded block component keeps its coloring ---------------------------------
const LazyPending = adopt(lazy(() => Promise.resolve({ default: Pending })));
// @ts-expect-error still pending: not a valid JSX element outside a Loading
export const lazyBad = <LazyPending id="1" />;
export const lazyOk = <Loading fallback="…">{LazyPending({ id: "1" })}</Loading>;
export const LazyHost = $component(function* () {
  return function* () {
    return <div>{yield* LazyPending({ id: "1" })}</div>;
  };
});
const lazyHostView: View<true, never> = LazyHost();
void lazyHostView;

// --- web's serializable attribute values (the router's action(), typed paths) ------------------
declare const serializable: import("@solidjs/web").JSX.SerializableAttributeValue;
export const formAction = <form action={serializable} />;
export const linkHref = <a href={serializable} />;

// events carry two colors: P (reads pending data, and waits for it), A (async work of its own)
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Colors<H> = H extends EventHandler<any, any, any, infer P, infer A> ? [P, A] : never;
export const EventColors = $component(function* () {
  const [n] = yield* $signal(1);
  const data = yield* $memo(function* () {
    const v = yield* n;
    return yield* attempt(
      () => Promise.resolve(v),
      () => new NotFound()
    );
  });
  const readsData = $event(function* () {
    return yield* data;
  });
  const requests = $event(function* () {
    yield* attempt(
      () => Promise.resolve(1),
      () => new NotFound()
    );
  });
  const callsBoth = $event(function* () {
    yield* readsData();
    yield* requests();
  });
  const startsBoth = $event(function* () {
    yield* start(readsData());
    yield* start(requests());
  });
  const sync = $event(function* () {});
  const colors: [
    Same<Colors<typeof readsData>, [true, false]>,
    Same<Colors<typeof requests>, [false, true]>,
    Same<Colors<typeof callsBoth>, [true, true]>,
    Same<Colors<typeof startsBoth>, [false, false]>,
    Same<Colors<typeof sync>, [false, false]>
  ] = [true, true, true, true, true];
  void colors;
  // an $effect does not wait: it delegates to a sync event, and starts an async one
  yield* $effect(function* () {
    yield* sync();
    yield* start(requests());
  });
  // @ts-expect-error an $effect does not wait on an event doing async work
  yield* $effect(function* () {
    yield* requests();
  });
  // @ts-expect-error nor on an event that waits for pending data
  yield* $effect(function* () {
    yield* readsData();
  });
  return function* () {
    return <p />;
  };
});

// each error type is its own color; an Errored with `catch` handles only the types it lists
class NotFoundE extends Error {
  readonly kind = "not-found" as const;
}
class ForbiddenE extends Error {
  readonly kind = "forbidden" as const;
}
const Fetches = $component(function* () {
  const [id] = yield* $signal("1");
  const user = yield* $memo(function* () {
    const v = yield* id;
    return yield* attempt(
      () => Promise.resolve({ name: v }),
      error => (error === "forbidden" ? new ForbiddenE() : new NotFoundE())
    );
  });
  return function* () {
    return <p>{(yield* user).name}</p>;
  };
});
// one boundary per type: both handled, renderable
export const bothHandled = Errored({
  catch: [ForbiddenE],
  fallback: "no access",
  children: () =>
    Errored({
      catch: [NotFoundE],
      fallback: err => {
        const e: NotFoundE = err();
        return <p>{e.kind}</p>;
      },
      children: () => Loading({ children: () => Fetches() })
    })
});
render(() => bothHandled, root);
// only NotFound handled: ForbiddenE still fails the tree
export const partlyHandled = Errored({
  catch: [NotFoundE],
  fallback: err => <p>{err().kind}</p>,
  children: () => Loading({ children: () => Fetches() })
});
// @ts-expect-error ForbiddenE is unhandled: the tree may fail
render(() => partlyHandled, root);
export const tagHandled = (
  <Errored catch={[NotFoundE, ForbiddenE]} fallback={err => <p>{err().kind}</p>}>
    {Loading({ children: () => Fetches() })}
  </Errored>
);
export const tagPartly = (
  // @ts-expect-error tag form: ForbiddenE is unhandled
  <Errored catch={[NotFoundE]} fallback={err => <p>{err().kind}</p>}>
    {Loading({ children: () => Fetches() })}
  </Errored>
);
// @ts-expect-error async data outside a Loading: the tree would suspend
render(() => Errored({ fallback: "!", children: () => Fetches() }), root);
