/**
 * The strict rules, JSX flavor — checked by `tsc -p tsconfig.json`, never
 * executed. Every `@ts-expect-error` is a rule the editor enforces; every
 * line without one must typecheck.
 */
import {
  $component,
  $effect,
  $event,
  $memo,
  $optimistic,
  $optimisticStore,
  $signal,
  $untrack,
  $store,
  attempt,
  constant,
  createContext,
  Errored,
  For,
  Loading,
  raise,
  readStore,
  render,
  Repeat,
  Show,
  type Source,
  type Path,
  type TypedProps,
  type View,
  type ChildView,
  type Element,
  type EventHandler,
  type Read,
  lazy,
  view
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
export const ok1 = Settled({ label: "a" });

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
// @ts-expect-error $untrack is not a SetupOp: a setup never reads, tracked or not (D-042)
export const UntracksInSetup = $component(function* (props: TypedProps<{ start: number }>) {
  const v = yield* $untrack(props.start);
  return function* () {
    return <p>{v}</p>;
  };
});
// it reads once in a memo, an effect, an event, a hole
export const Untracks = $component(function* (props: TypedProps<{ start: number }>) {
  const doubled = yield* $memo(function* () {
    return (yield* $untrack(props.start)) * 2;
  });
  yield* $effect(function* () {
    void (yield* $untrack(props.start));
  });
  const log = $event(function* () {
    return yield* $untrack(props.start);
  });
  return function* () {
    return (
      <p onClick={log}>
        {yield* doubled} {yield* $untrack(props.start)}
      </p>
    );
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

// --- $optimistic / $optimisticStore mirror $signal / $store (D-014) ------------------------------
export const Optimistic = $component(function* () {
  const [sending] = yield* $optimistic(false);
  const [list] = yield* $optimisticStore({ items: ["a"] });
  const [derived] = yield* $optimisticStore(
    function* (draft: { items: string[] }) {
      draft.items = [String(yield* sending)];
    },
    { items: [] }
  );
  // @ts-expect-error $optimistic is the scalar form: a derived optimistic value is $optimisticStore's body
  yield* $optimistic(function* () {
    return 1;
  });
  // @ts-expect-error $optimisticStore is the object-or-body form: a scalar is $optimistic
  yield* $optimisticStore(1);
  return function* () {
    return (
      <p>
        {String(yield* sending)} {yield* list.items[0]} {yield* derived.items[0]}
      </p>
    );
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
  const user = yield* $memo(function* () {
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
export const seededOk = Errored({
  fallback: "!",
  children: function* () {
    return <>{yield* Seeded({ id: "1" })}</>;
  }
});
const pendingView: View<true, never> = Pending({ id: "1" });
const fallibleView: View<true, NotFound> = Fallible({ id: "1" });
void [pendingView, fallibleView];

// @ts-expect-error a block component is called, never a tag (D-062, D-067)
export const bad1 = <Pending id="1" />;
// called, its colors are its view's
const calledPending: View<true, never> = Pending({ id: "1" });
void calledPending;
// @ts-expect-error a pending view is not an element
export const bad2 = <div>{Pending({ id: "1" })}</div>;
export const ok2 = Loading({
  fallback: <p>…</p>,
  children: function* () {
    return <>{yield* Pending({ id: "1" })}</>;
  }
});
// the call form takes its content as a function (built inside the boundary)
export const ok3 = (
  <div>
    {Loading({
      fallback: <p>…</p>,
      children: function* () {
        return <>{yield* Pending({ id: "1" })}</>;
      }
    })}
  </div>
);
// @ts-expect-error Loading handles pending, not NotFound
export const bad3: View<false, never> = Loading({
  children: function* () {
    return <>{yield* Fallible({ id: "1" })}</>;
  }
});
export const ok4 = Errored({
  fallback: err => <p>{err().kind}</p>,
  children: function* () {
    return <>{yield* Loading({ fallback: <p>…</p>, children: Fallible({ id: "1" }) })}</>;
  }
});

// yield* Child(props) propagates to the parent
export const Parent = $component(function* () {
  return function* () {
    return <section>{yield* Fallible({ id: "1" })}</section>;
  };
});
// @ts-expect-error Parent inherits Fallible's pending and failures
export const bad4: View<false, never> = Parent();
export const ok5 = Errored({
  fallback: <p>error</p>,
  children: function* () {
    return (
      <>
        {
          yield* Loading({
            children: function* () {
              return <>{yield* Parent()}</>;
            }
          })
        }
      </>
    );
  }
});

// the root must be settled
const ok5Root = $component(function* () {
  return function* () {
    return <>{yield* Settled({ label: "x" })}</>;
  };
});
render(() => Settled({ label: "x" }), root);
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

// --- derivations are $memos; in JSX the hole is the yield* ----------------------------------
export const Blocks = $component(function* () {
  const [n] = yield* $signal(1);
  const user = pendingUser;
  const doubled = yield* $memo(function* () {
    return (yield* n) * 2;
  });
  const name = yield* $memo(function* () {
    return (yield* user).name;
  });
  const big = yield* $memo(function* () {
    return (yield* n) > 1 ? "big" : "";
  });
  return function* () {
    const settledChild = <div>{yield* doubled}</div>;
    // @ts-expect-error a memo is a source, not an element: read it with yield*
    const memoChild = <div>{name}</div>;
    const generatorChild = (
      <div>
        {/* @ts-expect-error a bare function* is not a JSX child (the web renderer does not drive it): the hole is a yield* */}
        {function* () {
          return yield* n;
        }}
      </div>
    );
    const asAttribute = <p title={String(yield* doubled)} class={yield* big} />;
    return [settledChild, memoChild, generatorChild, asAttribute];
  };
});
// a memo read in an attribute counts in the view: this view may be pending
export const PendingAttribute = $component(function* () {
  const user = pendingUser;
  const name = yield* $memo(function* () {
    return (yield* user).name;
  });
  return function* () {
    return <p title={yield* name} />;
  };
});
// @ts-expect-error PendingAttribute may be pending
export const bad5: View<false, never> = PendingAttribute();

// --- row blocks ---------------------------------------------------------------------------------
type Comment = { id: number; text: string; kids: Comment[] };
declare const comments: Comment[];
export const Rows = $component(function* () {
  // recursive: its view's yields are spelled out (TypeScript cannot infer a
  // type its own initializer references), as a recursive component's are
  function* comment(c: Source<Comment> & { kids: Source<Comment[]>; text: Source<string> }) {
    const [open] = yield* $signal(true);
    return function* (): Generator<Read<false, never> | ChildView<false, never>, Element> {
      return (
        <li>
          {yield* c.text}
          {
            yield* Show({
              when: open,
              children: function* () {
                return (
                  <>
                    {
                      yield* For({
                        each: c.kids,
                        children: comment
                      })
                    }
                  </>
                );
              }
            })
          }
        </li>
      );
    };
  }
  return function* () {
    return (
      <ul>
        {
          yield* For({
            each: comments,
            children: comment
          })
        }
        {
          yield* For({
            each: comments,
            children: function* (c, i) {
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
            }
          })
        }
        {
          yield* For({
            each: comments,
            children: function* (c) {
              return view(function* () {
                return <>{yield* Settled({ label: c.text })}</>;
              });
            }
          })
        }
        {
          yield* For({
            each: comments,
            children: function* (c) {
              // a row's body is a setup (as a $component's): a derivation is the row's $memo
              const shout = yield* $memo(function* () {
                return (yield* c.text).toUpperCase();
              });
              return function* () {
                return <li title={yield* shout}>{yield* shout}</li>;
              };
            }
          })
        }
        {
          yield* Repeat({
            count: 2,
            children: function* (i) {
              return function* () {
                return <b>{yield* i}</b>;
              };
            }
          })
        }
        {
          yield* For({
            each: comments,
            children: function* (c) {
              return function* () {
                return (
                  <li>
                    {Loading({
                      children: function* () {
                        return <>{yield* Pending({ id: c.text })}</>;
                      }
                    })}
                  </li>
                );
              };
            }
          })
        }
      </ul>
    );
  };
});

// --- flow controls take a hole as well as a source (D-038) --------------------------------------
export const FlowHoles = $component(function* () {
  const [n] = yield* $signal(1);
  const [list] = yield* $signal(["a", "b"]);
  return function* () {
    return (
      <div>
        {
          yield* Show({
            when: function* () {
              return (yield* n) > 1;
            },
            fallback: <i>small</i>,
            children: function* () {
              return <b>big</b>;
            }
          })
        }
        {
          yield* Show({
            when: function* () {
              return (yield* list)[0];
            },
            children: function* (first) {
              return function* () {
                return <b>{yield* first}</b>;
              };
            }
          })
        }
        {
          yield* For({
            each: function* () {
              return (yield* list).filter(x => x !== "b");
            },
            children: function* (item) {
              return function* () {
                return <li>{yield* item}</li>;
              };
            }
          })
        }
        {
          yield* Repeat({
            count: function* () {
              return yield* n;
            },
            children: function* (i) {
              return function* () {
                return <u>{yield* i}</u>;
              };
            }
          })
        }
      </div>
    );
  };
});
const pendingHole = function* () {
  return (yield* pendingUser).name;
};
// in call form a hole over a pending source colors the flow control's view
export const pendingHoleView: View<true, never> = Show({
  when: pendingHole,
  children: function* () {
    return <>!</>;
  }
});

// --- a pending row colors the holding view too (D-063) ------------------------------------------
const pendingRow = function* (c: Path<Comment>) {
  return function* () {
    return (
      <li>
        {
          yield* Pending({
            id: function* () {
              return String(yield* c.id);
            }
          })
        }
      </li>
    );
  };
};
export const PendingRows = $component(function* () {
  return function* () {
    return <ul>{yield* For({ each: comments, children: pendingRow })}</ul>;
  };
});
const pendingRowsView: View<true, never> = PendingRows();
void pendingRowsView;
export const pendingRowsOk = Loading({
  fallback: "…",
  children: function* () {
    return <>{yield* PendingRows()}</>;
  }
});

// --- a row need not be settled: its failures join the view holding the list (D-059) ------------
const failingRow = function* (c: Path<Comment>) {
  const shown = yield* $memo(function* () {
    const text = yield* c.text;
    if (!text) yield* raise(new NotFound());
    return text;
  });
  return function* () {
    return <li>{yield* shown}</li>;
  };
};
export const FailingRows = $component(function* () {
  return function* () {
    return <ul>{yield* For({ each: comments, children: failingRow })}</ul>;
  };
});
// a failing row colors the holding view
const failingRowsView: View<false, NotFound> = FailingRows();
void failingRowsView;
export const failingRowsOk = Errored({
  fallback: "!",
  children: function* () {
    return <>{yield* FailingRows()}</>;
  }
});
// @ts-expect-error a block component is never a tag (D-062): a flow control is called
export const failingRowsTag = <For each={comments}>{failingRow}</For>;

// --- view(): a view's mistake is reported at the view, not at $component (D-054) ----------------
export const WrappedCreates = $component(function* () {
  const [n] = yield* $signal(1);
  // @ts-expect-error reported here, at the view, naming the op (Create<"signal"> is not a ViewOp)
  return view(function* () {
    const [m] = yield* $signal(0);
    return (
      <p>
        {yield* n}
        {yield* m}
      </p>
    );
  });
});
// unwrapped, the same mistake is reported at the $component( call
// @ts-expect-error reported here, forty lines up in a long setup
export const UnwrappedCreates = $component(function* () {
  const [n] = yield* $signal(1);
  return function* () {
    const [m] = yield* $signal(0);
    return (
      <p>
        {yield* n}
        {yield* m}
      </p>
    );
  };
});
// a wrapped view keeps its colors
export const WrappedPending = $component(function* () {
  return view(function* () {
    return <b>{(yield* pendingUser).name}</b>;
  });
});
const wrappedPendingView: View<true, never> = WrappedPending();
void wrappedPendingView;

// --- a row receives item: Source<T> (a path) and index: Source<number> (D-055) -----------------
type Is<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
export const RowSignature = $component(function* () {
  const [list] = yield* $signal([{ id: 1, text: "a" }]);
  return function* () {
    return (
      <ul>
        {
          yield* For({
            each: list,
            children: function* (item, index) {
              const sig: [
                Is<typeof item, Path<{ id: number; text: string }>>,
                Is<typeof index, Source<number>>
              ] = [true, true];
              void sig;
              // both are sources: read with yield*, never as values
              // @ts-expect-error an item is not its value
              const text: string = item.text;
              void text;
              return function* () {
                return (
                  <li>
                    {yield* index}: {yield* item.text}
                  </li>
                );
              };
            }
          })
        }
        {
          yield* Repeat({
            count: 2,
            children: function* (i) {
              const sig: Is<typeof i, Source<number>> = true;
              void sig;
              return function* () {
                return <b>{yield* i}</b>;
              };
            }
          })
        }
      </ul>
    );
  };
});

// a row's setup does not read: derive with $memo, read in the view
const readsInRowSetup = function* (c: Path<Comment>) {
  const text = yield* c.text;
  return function* () {
    return <li>{text}</li>;
  };
};
// @ts-expect-error [ROW_SETUP_OP]
export const badRowSetup = For({ each: comments, children: readsInRowSetup });

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
export const bad6: View<false, never> = Through({ wire: wire });

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
export const ok6 = Errored({
  fallback: "!",
  children: function* () {
    return (
      <>
        {
          yield* Loading({
            children: function* () {
              return <>{yield* Declared({ user: settledUser })}</>;
            }
          })
        }
      </>
    );
  }
});
export const ok7 = Errored({
  fallback: "!",
  children: function* () {
    return (
      <>
        {
          yield* Loading({
            children: function* () {
              return <>{yield* Declared({ user: { name: "a" } })}</>;
            }
          })
        }
      </>
    );
  }
});
// @ts-expect-error a declared source's reads are pending and may fail
export const bad7: View<false, never> = Declared({ user: settledUser });

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

// --- lazy: pending while its chunk loads, and colored as the loaded component (D-047) -----------
const LazyPending = lazy(() => Promise.resolve({ default: Pending }));
// @ts-expect-error still pending: a lazy component is never a tag, and called it is pending
export const lazyBad: View<false, never> = LazyPending({ id: "1" });
export const lazyOk = Loading({
  fallback: "…",
  children: function* () {
    return <>{yield* LazyPending({ id: "1" })}</>;
  }
});
export const LazyHost = $component(function* () {
  return function* () {
    return <div>{yield* LazyPending({ id: "1" })}</div>;
  };
});
const lazyHostView: View<true, never> = LazyHost();
void lazyHostView;
// a view rendering a loading lazy is pending, even when the loaded component is settled
const LazySettled = lazy(() => Promise.resolve({ default: Settled }));
// @ts-expect-error pending while its chunk loads
export const lazySettledBad: View<false, never> = LazySettled({ label: "x" });
export const LazySettledHost = $component(function* () {
  return function* () {
    return <div>{yield* LazySettled({ label: "x" })}</div>;
  };
});
const lazySettledView: View<true, never> = LazySettledHost();
void lazySettledView;
// and it fails as the loaded component does
const LazyFallible = lazy(() => Promise.resolve({ default: Fallible }));
const lazyFallibleView: View<true, NotFound> = LazyFallible({ id: "1" });
void lazyFallibleView;
// the export option and preload, as Solid's lazy
const LazyNamed = lazy(() => Promise.resolve({ Settled }), { export: "Settled" });
export const lazyNamedOk = Loading({
  fallback: "…",
  children: function* () {
    return <>{yield* LazyNamed({ label: "x" })}</>;
  }
});
void LazyNamed.preload;

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
  const sync = $event(function* () {});
  const colors: [
    Same<Colors<typeof readsData>, [true, false]>,
    Same<Colors<typeof requests>, [false, true]>,
    Same<Colors<typeof callsBoth>, [true, true]>,
    Same<Colors<typeof sync>, [false, false]>
  ] = [true, true, true, true];
  void colors;
  // an $effect does not wait: it delegates to a sync event only (an async one
  // is reached through an event calling an event, or a $memo; D-035)
  yield* $effect(function* () {
    yield* sync();
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
  children: function* () {
    return (
      <>
        {
          yield* Errored({
            catch: [NotFoundE],
            fallback: err => {
              const e: NotFoundE = err();
              return <p>{e.kind}</p>;
            },
            children: function* () {
              return (
                <>
                  {
                    yield* Loading({
                      children: function* () {
                        return <>{yield* Fetches()}</>;
                      }
                    })
                  }
                </>
              );
            }
          })
        }
      </>
    );
  }
});
render(() => bothHandled, root);
// only NotFound handled: ForbiddenE still fails the tree
export const partlyHandled = Errored({
  catch: [NotFoundE],
  fallback: err => <p>{err().kind}</p>,
  children: function* () {
    return (
      <>
        {
          yield* Loading({
            children: function* () {
              return <>{yield* Fetches()}</>;
            }
          })
        }
      </>
    );
  }
});
// @ts-expect-error ForbiddenE is unhandled: the tree may fail
render(() => partlyHandled, root);
export const tagHandled = Errored({
  catch: [NotFoundE, ForbiddenE],
  fallback: err => <p>{err().kind}</p>,
  children: function* () {
    return (
      <>
        {
          yield* Loading({
            children: function* () {
              return <>{yield* Fetches()}</>;
            }
          })
        }
      </>
    );
  }
});
// @ts-expect-error ForbiddenE is unhandled: the view may fail
export const tagPartly: View<false, never> = Errored({
  catch: [NotFoundE],
  fallback: err => <p>{err().kind}</p>,
  children: function* () {
    return (
      <>
        {
          yield* Loading({
            children: function* () {
              return <>{yield* Fetches()}</>;
            }
          })
        }
      </>
    );
  }
});
render(
  () =>
    // @ts-expect-error async data outside a Loading: the tree would suspend
    Errored({
      fallback: "!",
      children: function* () {
        return <>{yield* Fetches()}</>;
      }
    }),
  root
);

// --- every failure type carries a literal kind (D-034) ------------------------------------------
// two structurally identical classes would be one type to TypeScript, while
// the runtime tells them apart with instanceof: a literal kind is required
class PlainA extends Error {}
class PlainB extends Error {}
class StringKind extends Error {
  readonly kind: string = "s";
}
class KindA extends Error {
  readonly kind = "a" as const;
}
class KindB extends Error {
  readonly kind = "b" as const;
}
const one = () => 1;
const toPlainA = () => new PlainA();
const toStringKind = () => new StringKind();
export const failures = $memo(function* () {
  // @ts-expect-error an error class needs `readonly kind = "x" as const`
  yield* attempt(one, toPlainA);
  // @ts-expect-error a plain-string kind cannot tell two classes apart
  yield* attempt(one, toStringKind);
  // @ts-expect-error raise is held to the same constraint
  yield* raise(new PlainB());
  // @ts-expect-error a plain Error has no kind
  yield* raise(new Error("x"));
  yield* attempt(
    () => 1,
    e => (e === "a" ? new KindA() : new KindB())
  );
  return 1;
});
// with literal kinds a catch removes only its own class
const KindFails = $component(function* () {
  const m = yield* $memo(function* () {
    return yield* attempt(
      () => Promise.resolve(1),
      e => (e === "a" ? new KindA() : new KindB())
    );
  });
  return function* () {
    return <b>{yield* m}</b>;
  };
});
const onlyA = Errored({
  catch: [KindA],
  fallback: "a",
  children: function* () {
    return (
      <>
        {
          yield* Loading({
            children: function* () {
              return <>{yield* KindFails()}</>;
            }
          })
        }
      </>
    );
  }
});
const stillB: View<false, KindB> = onlyA;
void stillB;
// @ts-expect-error a catch list needs classes with a literal kind
export const plainCatch = Errored({
  catch: [PlainA],
  fallback: "!",
  children: function* () {
    return <>{yield* KindFails()}</>;
  }
});

// --- constant(value): a settled source that never fails (D-060) ---------------------------------
const nobody = constant<{ name: string } | null>(null);
const nobodyIs: Source<{ name: string } | null, false, never> = nobody;
void nobodyIs;
export const ConstantContext = createContext(constant<{ name: string } | null>(null));
export const ReadsConstant = $component(function* () {
  const who = yield* ConstantContext;
  return function* () {
    return <b>{(yield* who)?.name ?? "nobody"}</b>;
  };
});
// settled: an element as it is
export const readsConstantOk = <div>{ReadsConstant()}</div>;
