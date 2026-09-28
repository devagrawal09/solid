// todos-local (apps/todos-local/app.tsx) written with generator blocks v2,
// for the compiled-islands emission (documentation/plans/
// ssr-hydration-redesign.md, "Compiler emission"). Same markup and
// behavior: one signal holding an immutable array persisted to
// localStorage, a hash filter synced by a settled `hashchange` listener,
// context for the store and actions, memos, `Show` and a keyed `For`.
//
// The compiler joins App, Header, MainSection, TodoItem and Footer into one
// island group (every handler writes `todos`, which the views read) at tier
// 1 (memos, dynamic structure, shared state, a settled body), and inlines
// every member's view into one activation module.
import {
  $cleanup,
  $component,
  $event,
  $memo,
  $settled,
  $signal,
  createContext,
  For,
  Show,
  type SourceAccessor,
  type TypedProps
} from "solid-js";

export interface Todo {
  id: string;
  title: string;
  completed: boolean;
}
export type Filter = "all" | "active" | "completed";

export function parseHash(hash: string): Filter {
  if (hash === "#/active") return "active";
  if (hash === "#/completed") return "completed";
  return "all";
}

interface Actions {
  addTodo(title: string): void;
  removeTodo(id: string): void;
  toggleTodo(id: string, completed: boolean): void;
  toggleAll(completed: boolean): void;
  clearCompleted(): void;
}

const TodosContext = createContext<[SourceAccessor<Todo[]>, Actions]>();

const Header = $component(function* () {
  const [, { addTodo }] = yield* TodosContext;
  const submit = $event(function* (e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (e.key !== "Enter") return;
    const title = e.currentTarget.value.trim();
    if (!title) return;
    e.currentTarget.value = "";
    addTodo(title);
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
  const [, { toggleTodo, removeTodo }] = yield* TodosContext;
  const toggle = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    toggleTodo(yield* props.todo.id, e.currentTarget.checked);
  });
  const remove = $event(function* () {
    removeTodo(yield* props.todo.id);
  });
  return function* () {
    return (
      <li class={["todo", { completed: yield* props.todo.completed }]}>
        <div class="view">
          <input
            class="toggle"
            type="checkbox"
            checked={yield* props.todo.completed}
            onInput={toggle}
          />
          <label>{yield* props.todo.title}</label>
          <button class="destroy" onClick={remove} />
        </div>
      </li>
    );
  };
});

const MainSection = $component(function* (props: TypedProps<{ filter: SourceAccessor<Filter> }>) {
  const [todos, { toggleAll }] = yield* TodosContext;
  const filtered = yield* $memo(function* () {
    const f = yield* props.filter;
    const t = yield* todos;
    return f === "active"
      ? t.filter(x => !x.completed)
      : f === "completed"
        ? t.filter(x => x.completed)
        : t;
  });
  const allCompleted = yield* $memo(function* () {
    const t = yield* todos;
    return t.length > 0 && t.every(x => x.completed);
  });
  const toggle = $event(function* () {
    toggleAll(!(yield* allCompleted));
  });
  return function* () {
    return (
      <Show when={(yield* todos).length > 0}>
        <section class="main">
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
  const [todos, { clearCompleted }] = yield* TodosContext;
  const remaining = yield* $memo(function* () {
    return (yield* todos).filter(x => !x.completed).length;
  });
  const completed = yield* $memo(function* () {
    return (yield* todos).length - (yield* remaining);
  });
  const clear = $event(function* () {
    clearCompleted();
  });
  return function* () {
    return (
      <Show when={(yield* todos).length > 0}>
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

export const App = $component(function* () {
  const [todos, setTodos] = yield* $signal<Todo[]>(
    JSON.parse(localStorage.getItem("TODOS") || "[]")
  );
  const [filter, setFilter] = yield* $signal<Filter>(parseHash(location.hash));
  yield* $settled(function* () {
    const sync = $event(function* () {
      setFilter(parseHash(location.hash));
    });
    window.addEventListener("hashchange", sync);
    yield* $cleanup(() => window.removeEventListener("hashchange", sync));
  });
  const save = (next: Todo[]) => (localStorage.setItem("TODOS", JSON.stringify(next)), next);
  const actions: Actions = {
    addTodo: title =>
      setTodos(t =>
        save([
          ...t,
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, completed: false }
        ])
      ),
    removeTodo: id => setTodos(t => save(t.filter(x => x.id !== id))),
    toggleTodo: (id, completed) =>
      setTodos(t => save(t.map(x => (x.id === id ? { ...x, completed } : x)))),
    toggleAll: completed =>
      setTodos(t => save(t.map(x => (x.completed === completed ? x : { ...x, completed })))),
    clearCompleted: () => setTodos(t => save(t.filter(x => !x.completed)))
  };
  return function* () {
    return (
      <TodosContext value={[todos, actions]}>
        <section class="todoapp">
          <Header />
          <MainSection filter={filter} />
          <Footer filter={filter} />
        </section>
      </TodosContext>
    );
  };
});
