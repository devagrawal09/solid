// One page, three kinds of region, one source of truth: the compiler reads
// the block graph and cuts islands from its live parts.
//
// - `App` is mostly static: its heading and the comment thread (server data
//   in props) are inert HTML. Its `clicks` counter is live, so the counter's
//   two holes and its button become an island (tier 0) rooted at `App` —
//   cut from the component, not along its boundary.
// - Each `Toggle` instance is its own tier-0 island (a slot, three holes).
// - `Todos` is a list island at tier 1 (memos, a keyed `For`, a `Show`): the
//   kernel, 2 KB gz, instead of the full core.
//
// `npm run build` builds the client and the server, prerenders dist/index.html,
// and `npm run check` drives it in Chromium.
import { $component, $event, $memo, $signal, For, Show, type JSX, type TypedProps } from "solid-js";
import type { Reply } from "./data";

const Toggle = $component(function* (props: TypedProps<{ children: JSX.Element }>) {
  const [open, setOpen] = yield* $signal(true);
  const toggle = $event(function* () {
    setOpen(o => !o);
  });
  return function* () {
    return (
      <>
        <div class={["toggle", { open: yield* open }]}>
          <a onClick={toggle}>{(yield* open) ? "[-]" : "[+] collapsed"}</a>
        </div>
        <ul class="replies" style={{ display: (yield* open) ? "block" : "none" }}>
          {props.children}
        </ul>
      </>
    );
  };
});

const ReplyView = $component(function* (props: TypedProps<{ reply: Reply }>) {
  return function* () {
    return (
      <li class="reply">
        <b>{yield* props.reply.user}</b> {yield* props.reply.text}
        <Show when={(yield* props.reply.replies).length}>
          <Toggle>
            <For each={yield* props.reply.replies}>{r => <ReplyView reply={r} />}</For>
          </Toggle>
        </Show>
      </li>
    );
  };
});

interface Todo {
  id: number;
  title: string;
  done: boolean;
}

const TodoRow = $component(function* (
  props: TypedProps<{ todo: Todo; toggle: (id: number) => void }>
) {
  const toggle = $event(function* () {
    props.toggle(yield* props.todo.id);
  });
  return function* () {
    return (
      <li class={{ done: yield* props.todo.done }}>
        <input type="checkbox" checked={yield* props.todo.done} onInput={toggle} />
        <span>{yield* props.todo.title}</span>
      </li>
    );
  };
});

const Todos = $component(function* () {
  const [todos, setTodos] = yield* $signal<Todo[]>([
    { id: 1, title: "Partition the block graph", done: true },
    { id: 2, title: "Pick each island's tier", done: false }
  ]);
  const left = yield* $memo(function* () {
    return (yield* todos).filter(t => !t.done).length;
  });
  let next = 3;
  const toggle = (id: number) =>
    setTodos(list => list.map(t => (t.id === id ? { ...t, done: !t.done } : t)));
  const add = $event(function* (e: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (e.key !== "Enter" || !e.currentTarget.value.trim()) return;
    const title = e.currentTarget.value.trim();
    e.currentTarget.value = "";
    setTodos(list => [...list, { id: next++, title, done: false }]);
  });
  return function* () {
    return (
      <section class="todos">
        <input class="new" placeholder="Add a todo" onKeyDown={add} />
        <ul>
          <For each={yield* todos}>{t => <TodoRow todo={t} toggle={toggle} />}</For>
        </ul>
        <p class="left">
          <strong>{yield* left}</strong> left
        </p>
        <Show when={(yield* left) === 0}>
          <p class="done">All done!</p>
        </Show>
      </section>
    );
  };
});

export const App = $component(function* (props: TypedProps<{ thread: Reply[] }>) {
  const [clicks, setClicks] = yield* $signal(0);
  const click = $event(function* () {
    setClicks(n => n + 1);
  });
  return function* () {
    return (
      <main>
        <h1>Compiled islands</h1>
        <p class="lede">Static HTML, and the smallest islands the block graph needs.</p>
        <p class="counter">
          <button onClick={click}>+1</button> clicked <b>{yield* clicks}</b> time
          {(yield* clicks) === 1 ? "" : "s"}
        </p>
        <Todos />
        <ul class="thread">
          <For each={yield* props.thread}>{r => <ReplyView reply={r} />}</For>
        </ul>
      </main>
    );
  };
});
