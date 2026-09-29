/**
 * The strict rules, JSX flavor — checked by `tsc -p tsconfig.json`, never
 * executed. Every `@ts-expect-error` is a rule the editor enforces; every
 * line without one must typecheck.
 */
import {
  $,
  $component,
  $effect,
  $event,
  $memo,
  $signal,
  $store,
  attempt,
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
  type View
} from "@solidjs/blocks";

declare const root: HTMLElement;
declare function fetchUser(id: string): Promise<{ name: string }>;
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
  yield* attempt(() => fetchUser("1"));
});

// --- only settled values render -------------------------------------------------------------
export const Pending = $component(function* (props: TypedProps<{ id: string }>) {
  const user = yield* $memo(function* () {
    const id = yield* props.id;
    return yield* attempt(() => fetchUser(id));
  });
  return function* () {
    return <h3>{(yield* user).name}</h3>;
  };
});
export const Fallible = $component(function* (props: TypedProps<{ id: string }>) {
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
// A memo with a loadingValue is never pending on read (commit #0 is the value)
export const Seeded = $component(function* (props: TypedProps<{ id: string }>) {
  const user = yield* $memo(
    function* () {
      const id = yield* props.id;
      return yield* attempt(() => fetchUser(id));
    },
    { loadingValue: { name: "…" } }
  );
  const seeded: Source<{ name: string }, false, never> = user;
  void seeded;
  return function* () {
    return <h3>{(yield* user).name}</h3>;
  };
});
export const seededOk = <Seeded id="1" />;
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
  const user = yield* $memo(function* () {
    return yield* attempt(() => fetchUser("x"));
  });
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
  const user = yield* $memo(function* () {
    return yield* attempt(() => fetchUser("x"));
  });
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
              setOpen(o => !o);
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
    return stream();
  });
  const typed: Source<number, true, unknown> = n;
  return function* () {
    return <b>{yield* typed}</b>;
  };
});
