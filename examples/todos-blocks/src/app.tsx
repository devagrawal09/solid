// TodoMVC from examples/todos with @solidjs/blocks (JSX flavor). The data
// layer (`todos.ts`: an optimistic store over a projection, actions, the
// error side-channel) and `api.ts` / `filter.ts` are the original's: they are
// Solid primitives, used from the components' setups.
//
// What the library's rules change here:
// - components are `$component`s: setups read the context (`yield* TodosContext`)
//   and create handlers (`$event`); views read in JSX holes;
// - the todos store is Solid's (optimistic, fetched): blocks read it through
//   `paths<Todo[], true>` (stated pending — the first fetch is async) and
//   structural reads through `readStore`;
// - a view that reads a pending store is pending, so the loading boundary
//   receives the two sections as views: `<Loading>{MainSection(…)}{Footer(…)}</Loading>`.
import {
  $,
  $component,
  $event,
  createContext,
  Errored,
  For,
  Loading,
  paths,
  read,
  readStore,
  Show,
  type TypedProps
} from "@solidjs/blocks";
import { createTodos, type Todo } from "./todos";
import { createHashFilter, type Filter } from "./filter";

const TodosContext = createContext<ReturnType<typeof createTodos>>();

/** The todos store (pending until the first fetch lands) and the actions. */
function* useTodos() {
  const [store, actions] = yield* TodosContext;
  return [paths<Todo[], true>(store), actions] as const;
}

type Input = InputEvent & { currentTarget: HTMLInputElement };
type Key = KeyboardEvent & { currentTarget: HTMLInputElement };

const Header = $component(function* Header() {
  const [, { addTodo }] = yield* useTodos();
  const submit = $event(function* (e: Key) {
    if (e.key !== "Enter") return;
    const title = e.currentTarget.value.trim();
    if (!title) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    addTodo({ id, title, completed: false });
    e.currentTarget.value = "";
  });
  return function* () {
    return (
      <header class="header">
        <h1>todos</h1>
        <input class="new-todo" placeholder="What needs to be done?" autofocus onKeyDown={submit} />
      </header>
    );
  };
});

const TodoItem = $component(function* TodoItem(props: TypedProps<{ todo: Todo }, "TodoItem">) {
  const [, { toggleTodo, removeTodo, retryTodo }] = yield* useTodos();
  const toggle = $event(function* (e: Input) {
    toggleTodo(yield* props.todo.id, e.currentTarget.checked);
  });
  const retry = $event(function* () {
    retryTodo(yield* props.todo);
  });
  const remove = $event(function* () {
    removeTodo(yield* props.todo.id);
  });
  return function* () {
    return (
      <li
        class={[
          "todo",
          {
            completed: yield* props.todo.completed,
            pending: !!(yield* props.todo.pending),
            errored: !!(yield* props.todo.error)
          }
        ]}
      >
        <div class="view">
          <input
            class="toggle"
            type="checkbox"
            checked={yield* props.todo.completed}
            onInput={toggle}
          />
          <label>{yield* props.todo.title}</label>
          <Show when={yield* props.todo.error}>
            {function* (error) {
              return function* () {
                return (
                  <button class="retry" title={`Retry ${yield* error.type}`} onClick={retry} />
                );
              };
            }}
          </Show>
          <button class="destroy" onClick={remove} />
        </div>
      </li>
    );
  };
});

const MainSection = $component(function* MainSection(
  props: TypedProps<{ filter: Filter }, "MainSection">
) {
  const [todos, { toggleAll }] = yield* useTodos();
  const filtered = $(function* () {
    const f = yield* props.filter;
    return yield* readStore(todos, t =>
      f === "active"
        ? t.filter(x => !x.completed)
        : f === "completed"
          ? t.filter(x => x.completed)
          : t
    );
  });
  const allCompleted = $(function* () {
    return yield* readStore(todos, t => t.length > 0 && t.every(x => x.completed));
  });
  const toggle = $event(function* () {
    toggleAll(!(yield* allCompleted));
  });
  return function* () {
    return (
      <Show when={(yield* todos.length) > 0}>
        <section class="main">
          <input
            id="toggle-all"
            class="toggle-all"
            type="checkbox"
            checked={yield* allCompleted}
            onChange={toggle}
          />
          <label for="toggle-all">Mark all as complete</label>
          <ul class="todo-list">
            <For each={yield* filtered}>{todo => <TodoItem todo={todo} />}</For>
          </ul>
        </section>
      </Show>
    );
  };
});

const Footer = $component(function* Footer(props: TypedProps<{ filter: Filter }, "Footer">) {
  const [todos, { clearCompleted }] = yield* useTodos();
  const remaining = $(function* () {
    return yield* readStore(todos, t => t.filter(x => !x.completed).length);
  });
  const completed = $(function* () {
    return (yield* todos.length) - (yield* remaining);
  });
  const clear = $event(function* () {
    clearCompleted();
  });
  return function* () {
    return (
      <Show when={(yield* todos.length) > 0}>
        <footer class="footer">
          <span class="todo-count">
            <strong>{yield* remaining}</strong> {(yield* remaining) === 1 ? "item" : "items"} left
          </span>
          <ul class="filters">
            <li>
              <a href="#/" class={{ selected: (yield* props.filter) === "all" }}>
                All
              </a>
            </li>
            <li>
              <a href="#/active" class={{ selected: (yield* props.filter) === "active" }}>
                Active
              </a>
            </li>
            <li>
              <a href="#/completed" class={{ selected: (yield* props.filter) === "completed" }}>
                Completed
              </a>
            </li>
          </ul>
          <Show when={(yield* completed) > 0}>
            <button class="clear-completed" onClick={clear}>
              Clear completed
            </button>
          </Show>
        </footer>
      </Show>
    );
  };
});

export const App = $component(function* App() {
  const filter = read(createHashFilter());
  return function* () {
    return (
      <Errored
        fallback={(err, reset) => (
          <div class="app-error">
            <p>Something went wrong: {String(err())}</p>
            <button onClick={reset}>Reset</button>
          </div>
        )}
      >
        <TodosContext value={createTodos()}>
          <section class="todoapp">
            <Header />
            <Loading fallback={<p class="loading">Loading…</p>}>
              {MainSection({ filter })}
              {Footer({ filter })}
            </Loading>
          </section>
        </TodosContext>
      </Errored>
    );
  };
});
