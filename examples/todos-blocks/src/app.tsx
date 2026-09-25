// TodoMVC from `examples/todos`, with every reactive boundary written as a
// `$` typed block:
//
// - derived computations are `createMemo($(function* () { … }))`,
// - each component's view is a JSX block (reads only: `yield* signal`,
//   `yield* todo.title` — the direct property syntax, one tracked path read
//   of the store proxy — and `yield* readStore(store, selector)` for
//   structural reads such as `filter` / `every`),
// - each DOM handler is an event block (`onKeyDown={submit}`), where the
//   `action`s from `./todos` are invoked through `attempt(...)`.
//
// Kept as ordinary code, on purpose:
// - `createTodos()` / the `action` generators in `./todos` — actions are
//   Solid's transaction dialect (`yield` there means "await inside the
//   transaction"); a `$` block calls them as an untyped fallible step
//   (`attempt`), which is the honest record: the block cannot see their
//   effects.
// - the `<Show when={…}>{error => …}</Show>` keyed child and the `<Errored>`
//   fallback: their `error` argument is typed as a plain `Accessor`, not an
//   iterable `SourceAccessor`, so they stay ordinary render callbacks rather
//   than widening their types.
// - the static markup (`<h1>`, labels, the filter links' text).
import {
  $,
  attempt,
  createContext,
  createMemo,
  Errored,
  For,
  Loading,
  readStore,
  Show,
  useContext,
  type SourceAccessor
} from "solid-js";
import { createTodos, type Todo } from "./todos";
import { createHashFilter, type Filter } from "./filter";

const TodosContext = createContext<ReturnType<typeof createTodos>>();

function Header() {
  const [, { addTodo }] = useContext(TodosContext);
  const submit = $(function* (e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (e.key !== "Enter") return;
    const input = e.currentTarget;
    const title = input.value.trim();
    if (!title) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    yield* attempt(() => addTodo({ id, title, completed: false }));
    input.value = "";
  });
  return (
    <header class="header">
      <h1>todos</h1>
      <input class="new-todo" placeholder="What needs to be done?" autofocus onKeyDown={submit} />
    </header>
  );
}

function TodoItem(props: { todo: Todo }) {
  const [, { toggleTodo, removeTodo, retryTodo }] = useContext(TodosContext);
  // `todo` is a row of the todos store (a static prop, not a reactive read);
  // `yield* todo.field` is one tracked read of that field through the proxy
  // (the compiler lowers it to `perform(readPath(todo, ["field"]))`).
  const todo = props.todo;
  const toggle = $(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    const id = yield* todo.id;
    yield* attempt(() => toggleTodo(id, e.currentTarget.checked));
  });
  const remove = $(function* () {
    const id = yield* todo.id;
    yield* attempt(() => removeTodo(id));
  });
  const retry = $(function* () {
    // `retryTodo` reads the row itself: hand it the proxy, not a value read.
    yield* attempt(() => retryTodo(todo));
  });
  return $(function* () {
    return (
      <li
        class={[
          "todo",
          {
            completed: yield* todo.completed,
            pending: !!(yield* todo.pending),
            errored: !!(yield* todo.error)
          }
        ]}
      >
        <div class="view">
          <input class="toggle" type="checkbox" checked={yield* todo.completed} onInput={toggle} />
          <label>{yield* todo.title}</label>
          <Show when={yield* todo.error}>
            {error => <button class="retry" title={`Retry ${error().type}`} onClick={retry} />}
          </Show>
          <button class="destroy" onClick={remove} />
        </div>
      </li>
    );
  });
}

function MainSection(props: { filter: SourceAccessor<Filter> }) {
  const [todos, { toggleAll }] = useContext(TodosContext);
  const filtered = createMemo(
    $(function* () {
      const f = yield* props.filter;
      return yield* readStore(todos, t =>
        f === "active"
          ? t.filter(x => !x.completed)
          : f === "completed"
            ? t.filter(x => x.completed)
            : t
      );
    })
  );
  const allCompleted = createMemo(
    $(function* () {
      return yield* readStore(todos, t => t.length > 0 && t.every(x => x.completed));
    })
  );
  const toggle = $(function* () {
    const completed = yield* allCompleted;
    yield* attempt(() => toggleAll(!completed));
  });
  return $(function* () {
    return (
      <Show when={(yield* todos.length) > 0}>
        <section class="main">
          {/* `input` (delegated) rather than `change`: a non-delegated event
              is bound natively and would not reach the event-block sink. */}
          <input
            id="toggle-all"
            class="toggle-all"
            type="checkbox"
            checked={yield* allCompleted}
            onInput={toggle}
          />
          <label for="toggle-all">Mark all as complete</label>
          <ul class="todo-list">
            <For each={yield* filtered}>{todo => <TodoItem todo={todo} />}</For>
          </ul>
        </section>
      </Show>
    );
  });
}

function Footer(props: { filter: SourceAccessor<Filter> }) {
  const [todos, { clearCompleted }] = useContext(TodosContext);
  const remaining = createMemo(
    $(function* () {
      return yield* readStore(todos, t => t.filter(x => !x.completed).length);
    })
  );
  const completed = createMemo(
    $(function* () {
      return (yield* todos.length) - (yield* remaining);
    })
  );
  const clear = $(function* () {
    yield* attempt(() => clearCompleted());
  });
  return $(function* () {
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
  });
}

export function App() {
  const filter = createHashFilter();
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
            <MainSection filter={filter} />
            <Footer filter={filter} />
          </Loading>
        </section>
      </TodosContext>
    </Errored>
  );
}
