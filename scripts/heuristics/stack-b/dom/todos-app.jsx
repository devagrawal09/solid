// examples/todos (src/app.tsx + src/todos.ts + src/filter.ts) ported to the
// harness shape `make(n, root)` → { mount, unmount, ops }.
//
// Kept verbatim from app.tsx: the component tree (Errored > TodosContext >
// section > Header, Loading > MainSection + Footer), every JSX binding, the
// plain-function derivations (`filtered`, `allCompleted`, `remaining`,
// `completed` — the example has no createMemo), <Show>/<For>, and the
// per-item error <Show> with its keyed callback.
//
// Changed, because a benchmark must be synchronous and deterministic:
//   - createTodos: the async `createOptimisticStore(async () => api.getTodos())`
//     plus `action` generators become a synchronous `createStore` seeded with
//     n todos, and each action applies only its optimistic write (the part
//     that touches the rendered graph). No API, no Math.random, no
//     `pending` flag (it is cleared by the refresh once the API settles).
//   - createHashFilter: the hash listener is replaced by an exposed setter
//     (the harness plays the `hashchange`).
//   - Header's onKeyDown id uses a counter instead of Date.now/Math.random.
import {
  createContext,
  createSignal,
  createStore,
  Errored,
  flush,
  For,
  Loading,
  Show,
  useContext
} from "solid-js";
import { render } from "@solidjs/web";

const TodosContext = createContext();

let nextId = 0;
const newId = () => `t${String(nextId++).padStart(6, "0")}`;

function createTodos(seed) {
  const [todos, setTodos] = createStore(seed);
  const actions = {
    addTodo(todo) {
      setTodos(t => {
        const old = t.find(x => x.id === todo.id);
        if (!old) t.push({ ...todo });
      });
    },
    removeTodo(id) {
      setTodos(t => t.filter(todo => todo.id !== id));
    },
    toggleTodo(id, completed) {
      setTodos(t => {
        const todo = t.find(x => x.id === id);
        if (todo) todo.completed = completed;
      });
    },
    toggleAll(completed) {
      setTodos(t => {
        t.forEach(todo => {
          if (todo.completed !== completed) todo.completed = completed;
        });
      });
    },
    clearCompleted() {
      setTodos(t => t.filter(todo => !todo.completed));
    },
    retryTodo() {}
  };
  return [todos, actions, setTodos];
}

function Header() {
  const [, { addTodo }] = useContext(TodosContext);
  return (
    <header class="header">
      <h1>todos</h1>
      <input
        class="new-todo"
        placeholder="What needs to be done?"
        autofocus
        onKeyDown={e => {
          if (e.key !== "Enter") return;
          const title = e.currentTarget.value.trim();
          if (!title) return;
          addTodo({ id: newId(), title, completed: false });
          e.currentTarget.value = "";
        }}
      />
    </header>
  );
}

function TodoItem(props) {
  const [, { toggleTodo, removeTodo, retryTodo }] = useContext(TodosContext);
  return (
    <li
      class={[
        "todo",
        {
          completed: props.todo.completed,
          pending: !!props.todo.pending,
          errored: !!props.todo.error
        }
      ]}
    >
      <div class="view">
        <input
          class="toggle"
          type="checkbox"
          checked={props.todo.completed}
          onInput={e => toggleTodo(props.todo.id, e.currentTarget.checked)}
        />
        <label>{props.todo.title}</label>
        <Show when={props.todo.error}>
          {error => (
            <button
              class="retry"
              title={`Retry ${error().type}`}
              onClick={() => retryTodo(props.todo)}
            />
          )}
        </Show>
        <button class="destroy" onClick={() => removeTodo(props.todo.id)} />
      </div>
    </li>
  );
}

function MainSection(props) {
  const [todos, { toggleAll }] = useContext(TodosContext);
  const filtered = () => {
    const f = props.filter;
    if (f === "active") return todos.filter(x => !x.completed);
    if (f === "completed") return todos.filter(x => x.completed);
    return todos;
  };
  const allCompleted = () => todos.length > 0 && todos.every(x => x.completed);
  return (
    <Show when={todos.length > 0}>
      <section class="main">
        <input
          id="toggle-all"
          class="toggle-all"
          type="checkbox"
          checked={allCompleted()}
          onChange={() => toggleAll(!allCompleted())}
        />
        <label for="toggle-all">Mark all as complete</label>
        <ul class="todo-list">
          <For each={filtered()}>{todo => <TodoItem todo={todo} />}</For>
        </ul>
      </section>
    </Show>
  );
}

function Footer(props) {
  const [todos, { clearCompleted }] = useContext(TodosContext);
  const remaining = () => todos.filter(x => !x.completed).length;
  const completed = () => todos.length - remaining();
  return (
    <Show when={todos.length > 0}>
      <footer class="footer">
        <span class="todo-count">
          <strong>{remaining()}</strong> {remaining() === 1 ? "item" : "items"} left
        </span>
        <ul class="filters">
          <li>
            <a href="#/" class={{ selected: props.filter === "all" }}>
              All
            </a>
          </li>
          <li>
            <a href="#/active" class={{ selected: props.filter === "active" }}>
              Active
            </a>
          </li>
          <li>
            <a href="#/completed" class={{ selected: props.filter === "completed" }}>
              Completed
            </a>
          </li>
        </ul>
        <Show when={completed() > 0}>
          <button class="clear-completed" onClick={clearCompleted}>
            Clear completed
          </button>
        </Show>
      </footer>
    </Show>
  );
}

function App(props) {
  const [filter, setFilter] = createSignal("all");
  props.bind.setFilter = setFilter;
  const store = createTodos(props.seed);
  props.bind.store = store;
  return (
    <Errored
      fallback={(err, reset) => (
        <div class="app-error">
          <p>Something went wrong: {String(err())}</p>
          <button onClick={reset}>Reset</button>
        </div>
      )}
    >
      <TodosContext value={store}>
        <section class="todoapp">
          <Header />
          <Loading fallback={<p class="loading">Loading…</p>}>
            <MainSection filter={filter()} />
            <Footer filter={filter()} />
          </Loading>
        </section>
      </TodosContext>
    </Errored>
  );
}

// Harness. Seed: n todos, every third completed (so filters and
// clear-completed change the list).
export function make(n, root) {
  const seed = () => {
    nextId = 0;
    return Array.from({ length: n }, (_, i) => ({
      id: newId(),
      title: "todo " + i,
      completed: i % 3 === 0
    }));
  };
  const bind = {};
  let dispose,
    round = 0;
  const actions = () => bind.store[1];
  const todos = () => bind.store[0];
  return {
    mount() {
      dispose = render(() => <App seed={seed()} bind={bind} />, root);
      flush();
    },
    unmount() {
      dispose();
      root.textContent = "";
    },
    // Each op: an optional untimed `setup`, the timed `run`, an optional
    // untimed `restore` that returns the app to the pre-op state (bounded).
    ops: {
      add: {
        run() {
          actions().addTodo({ id: newId(), title: "new " + (round++ % 10), completed: false });
          flush();
        },
        restore() {
          const t = todos();
          actions().removeTodo(t[t.length - 1].id);
          flush();
        }
      },
      toggle: {
        run() {
          const t = todos();
          const item = t[(round = (round * 7 + 3) % t.length)];
          actions().toggleTodo(item.id, !item.completed);
          flush();
        }
      },
      filter: {
        run() {
          bind.setFilter(["active", "completed", "all"][round++ % 3]);
          flush();
        }
      },
      clearCompleted: {
        setup() {
          this.saved = todos().map(t => ({ id: t.id, title: t.title, completed: t.completed }));
        },
        run() {
          actions().clearCompleted();
          flush();
        },
        restore() {
          const saved = this.saved;
          bind.store[2](() => saved);
          flush();
        }
      }
    }
  };
}
