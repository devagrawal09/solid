/**
 * @jsxImportSource @solidjs/web
 */
// Render callbacks as blocks (generator blocks v2, "Render callbacks as
// blocks"), checked by `tsc`, never executed: a `<For>` / `<Show>` /
// `<Match>` / `<Repeat>` render callback may be a block with its own setup
// and view. Its setup creates, its view reads, and a flow control renders
// settled rows only — a row's pending / failures propagate into its own view
// (like a child component's) and are handled there.
import {
  $component,
  $event,
  $memo,
  $scope,
  $signal,
  attempt,
  Errored,
  For,
  Loading,
  Match,
  Repeat,
  Show,
  Switch,
  type TypedProps
} from "solid-js";

type CommentDefinition = { id: number; user: string; comments: CommentDefinition[] };
declare const comments: CommentDefinition[];
declare function fetchUser(id: number): Promise<{ name: string }>;

// --- Show / Match branches, Repeat rows ---------------------------------------------------
declare const maybe: { name: string } | undefined;
export const KeyedBranch = (
  <Show when={maybe} keyed>
    {function* (m) {
      const [n] = yield* $signal(m.name.length);
      return function* () {
        return <i>{yield* n}</i>;
      };
    }}
  </Show>
);
const Branch = (
  <Show when={maybe}>
    {function* (m) {
      const [seen] = yield* $signal(false);
      return function* () {
        return (
          <i>
            {m().name} {String(yield* seen)}
          </i>
        );
      };
    }}
  </Show>
);
const ParameterlessBranch = (
  <Show when={maybe}>
    {function* () {
      const [open] = yield* $signal(true);
      return function* () {
        return <i>{String(yield* open)}</i>;
      };
    }}
  </Show>
);
const MatchBranch = (
  <Switch>
    <Match when={maybe}>
      {function* (m) {
        const [x] = yield* $signal(0);
        return function* () {
          return (
            <i>
              {m().name}
              {yield* x}
            </i>
          );
        };
      }}
    </Match>
  </Switch>
);
const RepeatRows = (
  <Repeat count={3}>
    {function* (index) {
      const [x] = yield* $signal(index);
      return function* () {
        return <i>{yield* x}</i>;
      };
    }}
  </Repeat>
);

const Pending = $component(function* (props: TypedProps<{ id: number }>) {
  const user = yield* $memo(function* () {
    const id = yield* props.id;
    return yield* attempt(() => fetchUser(id));
  });
  return function* () {
    return <b>{(yield* user).name}</b>;
  };
});

// --- a row block: per-row state in a render callback ----------------------------
const List = $component(function* () {
  return function* () {
    return (
      <ul>
        <For each={comments}>
          {function* (c, i) {
            const [open, setOpen] = yield* $signal(c.id > 0);
            const toggle = $event(function* () {
              setOpen(o => !o);
            });
            const n: number = i();
            const id: number = c.id;
            void [n, id];
            return function* () {
              return (
                <li onClick={toggle}>
                  {c.user} {(yield* open) ? "[-]" : "[+]"}
                </li>
              );
            };
          }}
        </For>
      </ul>
    );
  };
});

// --- a named, recursive row block declared in the setup --------------------------------
const Thread = $component(function* () {
  function* comment(c: CommentDefinition) {
    const [open] = yield* $signal(true);
    return function* () {
      return (
        <li>
          {c.user}
          <Show when={yield* open}>
            <ul>
              <For each={c.comments}>{comment}</For>
            </ul>
          </Show>
        </li>
      );
    };
  }
  return function* () {
    return <For each={comments}>{comment}</For>;
  };
});

// --- `$scope` builds the same callback explicitly ----------------------------------------
const row = $scope(function* (c: CommentDefinition) {
  const [open] = yield* $signal(true);
  return function* () {
    return <li>{(yield* open) ? c.user : ""}</li>;
  };
});
const WithScope = $component(function* () {
  return function* () {
    return <For each={comments}>{row}</For>;
  };
});

// --- a row's pending / failures: handled in the row, or a type error ---------------------
const Handled = $component(function* () {
  return function* () {
    return (
      <For each={comments}>
        {function* (c) {
          return function* () {
            return (
              <li>
                {Errored({
                  fallback: <p>error</p>,
                  children: Loading({ children: Pending({ id: c.id }) })
                })}
              </li>
            );
          };
        }}
      </For>
    );
  };
});
const Unhandled = $component(function* () {
  return function* () {
    return (
      <For each={comments}>
        {/* @ts-expect-error the row's view propagates Pending's pending: not renderable */}
        {function* (c) {
          return function* () {
            return <li>{yield* Pending({ id: c.id })}</li>;
          };
        }}
      </For>
    );
  };
});

// --- creations belong to a setup ------------------------------------------------------------
const CreatesInView = $component(function* () {
  return function* () {
    return (
      <For each={comments}>
        {/* @ts-expect-error `$signal` in the row's view (a view only reads) */}
        {function* (c) {
          return function* () {
            const [x] = yield* $signal(c.id);
            return <li>{yield* x}</li>;
          };
        }}
      </For>
    );
  };
});
const ReadsInSetup = $component(function* () {
  const [count] = yield* $signal(0);
  return function* () {
    return (
      <For each={comments}>
        {/* @ts-expect-error a read in the row's setup (setup creates; its view reads) */}
        {function* () {
          const n = yield* count;
          return function* () {
            return <li>{n}</li>;
          };
        }}
      </For>
    );
  };
});

void [
  List,
  Thread,
  KeyedBranch,
  Branch,
  ParameterlessBranch,
  MatchBranch,
  RepeatRows,
  WithScope,
  Handled,
  Unhandled,
  CreatesInView,
  ReadsInSetup
];
