// TodoMVC from `examples/todos`, written with generator blocks v2
// (documentation/plans/generator-blocks-v2.md):
//
// - each component is a `$component`: its setup reads context
//   (`yield* TodosContext`) and creates memos (`yield* $memo(…)`) and event
//   handlers (`$event(…)`); the view it returns only reads — `yield* signal`,
//   `yield* props.todo.title` (one tracked walk of the props, compiled) and
//   `yield* readStore(store, selector)` for structural reads;
// - each DOM handler is an `$event`, where the `action`s from `./todos` run
//   through `yield* attempt(() => …)` (an action returns a promise, so the
//   handler suspends until it settles).
//
// Kept as ordinary code, on purpose:
// - `createTodos()` / the `action` generators in `./todos` — actions are
//   Solid's transaction dialect (`yield` there means "await inside the
//   transaction");
// - the `<Show when={…}>{error => …}</Show>` keyed child and the `<Errored>`
//   fallback: render callbacks, not blocks;
// - `App` itself: a plain component rendering the block components as tags
//   (they are settled — nothing they read can suspend or fail at the type
//   level — so JSX admits them).
import {
  $component,
  $event,
  $memo,
  attempt,
  createContext,
  Errored,
  For,
  Loading,
  readStore,
  Show,
  type SourceAccessor,
  type TypedProps
} from "solid-js";
import { createTodos, type Todo } from "./todos";
import { createHashFilter, type Filter } from "./filter";

const TodosContext = createContext<ReturnType<typeof createTodos>>();

/** The todos store and actions from context (provided by `App`). */
function* useTodos() {
  const value = yield* TodosContext;
  if (!value) throw new Error("TodosContext is not provided");
  return value;
}

const Header = $component(function* () {
  const [, { addTodo }] = yield* useTodos();
  const submit = $event(function* (e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (e.key !== "Enter") return;
    const input = e.currentTarget;
    const title = input.value.trim();
    if (!title) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    input.value = "";
    // The action writes optimistically at once; the handler then waits for it.
    yield* attempt(() => addTodo({ id, title, completed: false }));
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

const TodoItem = $component(function* (props: TypedProps<{ todo: Todo }>) {
  const [, { toggleTodo, removeTodo, retryTodo }] = yield* useTodos();
  const toggle = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    const id = yield* props.todo.id;
    yield* attempt(() => toggleTodo(id, e.currentTarget.checked));
  });
  const remove = $event(function* () {
    const id = yield* props.todo.id;
    yield* attempt(() => removeTodo(id));
  });
  const retry = $event(function* () {
    // `retryTodo` reads the row itself: hand it the row, not a field.
    const todo = yield* props.todo;
    yield* attempt(() => retryTodo(todo));
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
            {error => <button class="retry" title={`Retry ${error().type}`} onClick={retry} />}
          </Show>
          <button class="destroy" onClick={remove} />
        </div>
      </li>
    );
  };
});

const MainSection = $component(function* (props: TypedProps<{ filter: SourceAccessor<Filter> }>) {
  const [todos, { toggleAll }] = yield* useTodos();
  const filtered = yield* $memo(function* () {
    const f = yield* props.filter;
    return yield* readStore(todos, t =>
      f === "active"
        ? t.filter(x => !x.completed)
        : f === "completed"
          ? t.filter(x => x.completed)
          : t
    );
  });
  const allCompleted = yield* $memo(function* () {
    return yield* readStore(todos, t => t.length > 0 && t.every(x => x.completed));
  });
  const toggle = $event(function* () {
    const completed = yield* allCompleted;
    yield* attempt(() => toggleAll(!completed));
  });
  return function* () {
    return (
      <Show when={(yield* readStore(todos, t => t.length)) > 0}>
        <section class="main">
          {/* `input` (delegated) rather than `change`: a non-delegated event
              is bound natively. */}
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
  };
});

const Footer = $component(function* (props: TypedProps<{ filter: SourceAccessor<Filter> }>) {
  const [todos, { clearCompleted }] = yield* useTodos();
  const remaining = yield* $memo(function* () {
    return yield* readStore(todos, t => t.filter(x => !x.completed).length);
  });
  const completed = yield* $memo(function* () {
    return (yield* readStore(todos, t => t.length)) - (yield* remaining);
  });
  const clear = $event(function* () {
    yield* attempt(() => clearCompleted());
  });
  return function* () {
    return (
      <Show when={(yield* readStore(todos, t => t.length)) > 0}>
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
