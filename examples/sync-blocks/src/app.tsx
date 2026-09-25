// An async-free application written in `$` typed generator blocks: every
// reactive read is `yield*`, every write is an explicit `write` in an event
// block, and nothing waits, so the capability linker can prove the whole
// client graph async-free (Track A stage 2).
import { $, createMemo, createSignal, createStore, For, readStore, Show, write } from "solid-js";

export type Filter = "all" | "open" | "done";
export interface Item {
  id: number;
  title: string;
  done: boolean;
}

export function Converter() {
  const [celsius, setCelsius] = createSignal(20);
  // Typed primitive arithmetic: proven synchronous and non-throwing.
  const fahrenheit = createMemo(
    $(function* () {
      return ((yield* celsius) * 9) / 5 + 32;
    })
  );
  const label = createMemo(
    $(function* () {
      return `${yield* celsius}°C = ${yield* fahrenheit}°F`;
    })
  );
  const warmer = $(function* () {
    yield* write(setCelsius, c => c + 5);
  });
  return $(function* () {
    return (
      <p class="converter">
        <span>{yield* label}</span>
        <button class="warmer" onClick={warmer}>
          +5°C
        </button>
      </p>
    );
  });
}

export function App() {
  const [state, setState] = createStore<{ items: Item[] }>({ items: [] });
  const [draft, setDraft] = createSignal("");
  const [filter, setFilter] = createSignal<Filter>("all");
  let nextId = 1;

  const visible = createMemo(
    $(function* () {
      const f = yield* filter;
      return yield* readStore(state, s =>
        s.items.filter(item => f === "all" || (f === "done") === item.done)
      );
    })
  );
  const remaining = createMemo(
    $(function* () {
      return yield* readStore(state, s => s.items.filter(item => !item.done).length);
    })
  );
  const summary = createMemo(
    $(function* () {
      const n = yield* remaining;
      return `${n} ${n === 1 ? "item" : "items"} left`;
    })
  );

  const typing = $(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    yield* write(setDraft, e.currentTarget.value);
  });
  const add = $(function* (e: SubmitEvent) {
    e.preventDefault();
    const title = (yield* draft).trim();
    if (!title) return;
    const id = nextId++;
    yield* write(setState, s => {
      s.items.push({ id, title, done: false });
    });
    yield* write(setDraft, "");
  });
  const toggle = (id: number) =>
    $(function* () {
      yield* write(setState, s => {
        const item = s.items.find(x => x.id === id);
        if (item) item.done = !item.done;
      });
    });
  const show = (next: Filter) =>
    $(function* () {
      yield* write(setFilter, next);
    });

  return $(function* () {
    return (
      <section class="app">
        <form class="add" onSubmit={add}>
          <input class="draft" value={yield* draft} onInput={typing} />
        </form>
        <ul class="items">
          <For each={yield* visible}>
            {item => (
              <li class={item.done ? "done" : ""}>
                <label onClick={toggle(item.id)}>{item.title}</label>
              </li>
            )}
          </For>
        </ul>
        <Show when={(yield* remaining) > 0}>
          <footer>
            <span class="count">{yield* summary}</span>
            <button class="show-all" onClick={show("all")}>
              all
            </button>
            <button class="show-open" onClick={show("open")}>
              open
            </button>
            <button class="show-done" onClick={show("done")}>
              done
            </button>
          </footer>
        </Show>
        <Converter />
      </section>
    );
  });
}
