// todos-local: examples/todos-blocks' UI and markup over a synchronous local
// store, for the island runtime tiers (documentation/plans/
// island-runtime-tiers.md). todos-blocks itself is tier 2 (optimistic store,
// async actions, a Loading boundary); this is the same app once async is
// gone, so the tier rules have something to choose below tier 2:
// - state is one signal holding an immutable array (no store, no async),
//   persisted to localStorage synchronously;
// - every handler writes that signal; the views read it through memos;
// - `createHashFilter` keeps its load-time `hashchange` listener (a hot
//   island, as in todos-blocks).
// Written as plain components (the analyzer reads both forms).
import {
  createContext,
  createMemo,
  createSignal,
  For,
  onSettled,
  Show,
  useContext
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

function createHashFilter() {
  const [filter, setFilter] = createSignal<Filter>(parseHash(location.hash));
  onSettled(() => {
    const onChange = () => setFilter(parseHash(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  });
  return filter;
}

function createTodos() {
  const [todos, setTodos] = createSignal<Todo[]>(JSON.parse(localStorage.getItem("TODOS") || "[]"));
  const save = (next: Todo[]) => {
    localStorage.setItem("TODOS", JSON.stringify(next));
    return next;
  };
  const actions = {
    addTodo: (title: string) =>
      setTodos(t =>
        save([
          ...t,
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, completed: false }
        ])
      ),
    removeTodo: (id: string) => setTodos(t => save(t.filter(x => x.id !== id))),
    toggleTodo: (id: string, completed: boolean) =>
      setTodos(t => save(t.map(x => (x.id === id ? { ...x, completed } : x)))),
    toggleAll: (completed: boolean) =>
      setTodos(t => save(t.map(x => (x.completed === completed ? x : { ...x, completed })))),
    clearCompleted: () => setTodos(t => save(t.filter(x => !x.completed)))
  };
  return [todos, actions] as const;
}

const TodosContext = createContext<ReturnType<typeof createTodos>>();
const useTodos = () => useContext(TodosContext)!;

function Header() {
  const [, { addTodo }] = useTodos();
  const submit = (e: KeyboardEvent & { currentTarget: HTMLInputElement }) => {
    if (e.key !== "Enter") return;
    const title = e.currentTarget.value.trim();
    if (!title) return;
    e.currentTarget.value = "";
    addTodo(title);
  };
  return (
    <header class="header">
      <h1>todos</h1>
      <input class="new-todo" placeholder="What needs to be done?" autofocus onKeyDown={submit} />
    </header>
  );
}

function TodoItem(props: { todo: Todo }) {
  const [, { toggleTodo, removeTodo }] = useTodos();
  return (
    <li class={["todo", { completed: props.todo.completed }]}>
      <div class="view">
        <input
          class="toggle"
          type="checkbox"
          checked={props.todo.completed}
          onInput={e => toggleTodo(props.todo.id, e.currentTarget.checked)}
        />
        <label>{props.todo.title}</label>
        <button class="destroy" onClick={() => removeTodo(props.todo.id)} />
      </div>
    </li>
  );
}

function MainSection(props: { filter: () => Filter }) {
  const [todos, { toggleAll }] = useTodos();
  const filtered = createMemo(() => {
    const f = props.filter();
    return f === "active"
      ? todos().filter(x => !x.completed)
      : f === "completed"
        ? todos().filter(x => x.completed)
        : todos();
  });
  const allCompleted = createMemo(() => todos().length > 0 && todos().every(x => x.completed));
  return (
    <Show when={todos().length > 0}>
      <section class="main">
        <input
          id="toggle-all"
          class="toggle-all"
          type="checkbox"
          checked={allCompleted()}
          onInput={() => toggleAll(!allCompleted())}
        />
        <label for="toggle-all">Mark all as complete</label>
        <ul class="todo-list">
          <For each={filtered()}>{todo => <TodoItem todo={todo} />}</For>
        </ul>
      </section>
    </Show>
  );
}

function Footer(props: { filter: () => Filter }) {
  const [todos, { clearCompleted }] = useTodos();
  const remaining = createMemo(() => todos().filter(x => !x.completed).length);
  const completed = createMemo(() => todos().length - remaining());
  return (
    <Show when={todos().length > 0}>
      <footer class="footer">
        <span class="todo-count">
          <strong>{remaining()}</strong> {remaining() === 1 ? "item" : "items"} left
        </span>
        <ul class="filters">
          <li>
            <a href="#/" class={{ selected: props.filter() === "all" }}>
              All
            </a>
          </li>
          <li>
            <a href="#/active" class={{ selected: props.filter() === "active" }}>
              Active
            </a>
          </li>
          <li>
            <a href="#/completed" class={{ selected: props.filter() === "completed" }}>
              Completed
            </a>
          </li>
        </ul>
        <Show when={completed() > 0}>
          <button class="clear-completed" onClick={() => clearCompleted()}>
            Clear completed
          </button>
        </Show>
      </footer>
    </Show>
  );
}

export function App() {
  const filter = createHashFilter();
  return (
    <TodosContext value={createTodos()}>
      <section class="todoapp">
        <Header />
        <MainSection filter={filter} />
        <Footer filter={filter} />
      </section>
    </TodosContext>
  );
}
