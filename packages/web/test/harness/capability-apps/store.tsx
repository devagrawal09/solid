/**
 * @jsxImportSource @solidjs/web
 *
 * One fixture graph of the capability-selected hydration matrix (see
 * ../capability-apps.ts). Each graph is its own module so the delegated
 * event types a client registers are exactly that graph's.
 */
import { createStore, createProjection, For } from "solid-js";
import { sleep } from "./shared.jsx";

export default function StoreApp() {
  const [todos, setTodos] = createStore([
    { id: 1, title: "one", done: false },
    { id: 2, title: "two", done: true }
  ]);
  const summary = createProjection<{ open: number }>(
    draft => {
      draft.open = todos.filter(t => !t.done).length;
    },
    { open: 0 }
  );
  const [remote] = createStore(
    async () => {
      await sleep(5);
      return [{ id: 10, label: "remote" }];
    },
    [] as { id: number; label: string }[]
  );
  return (
    <main>
      <button
        id="inc"
        onClick={() =>
          setTodos(t => {
            t.push({ id: t.length + 1, title: "new", done: false });
          })
        }
      >
        add
      </button>
      <p>open {summary.open}</p>
      <ul>
        <For each={todos}>{todo => <li>{todo.title}</li>}</For>
      </ul>
      <ol>
        <For each={remote}>{row => <li>{row.label}</li>}</For>
      </ol>
    </main>
  );
}
