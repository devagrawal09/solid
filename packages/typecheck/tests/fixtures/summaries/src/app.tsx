import { $, attempt, createSignal, createStore, write } from "solid-js";
import { PrimaryButton, Toolbar } from "./components";
import { formatTitle, LIMIT } from "./util";

interface Todo {
  title: string;
  done: boolean;
}

export function App(props: { initial: string }) {
  const [title, setTitle] = createSignal(props.initial);
  const [todos, setTodos] = createStore<{ list: Todo[] }>({ list: [] });
  const add = $(function* (e: MouseEvent) {
    e.preventDefault();
    const value = yield* title;
    const count = yield* todos.list.length;
    if (count >= LIMIT) return;
    const formatted = yield* attempt(() => formatTitle(value));
    yield* write(setTodos, draft => {
      draft.list.push({ title: formatted, done: false });
    });
  });
  const reset = $(function* (_e: MouseEvent) {
    yield* write(setTitle, props.initial);
  });
  return (
    <main>
      <PrimaryButton onPress={add} label="Add" />
      <Toolbar onSave={reset} />
    </main>
  );
}
