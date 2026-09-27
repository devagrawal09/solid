// An async-free application written with generator blocks v2: every reactive
// read is `yield*`, every write is a `yield* set(…)` in an event, and nothing
// suspends, so the capability linker can prove the whole client graph
// async-free (Track A stage 2).
import { $component, $event, $memo, $signal, $store, For, readStore, Show } from "solid-js";

export type Filter = "all" | "open" | "done";
export interface Item {
  id: number;
  title: string;
  done: boolean;
}

export const Converter = $component(function* () {
  const [celsius, setCelsius] = yield* $signal(20);
  // Typed primitive arithmetic: proven synchronous and non-throwing.
  const fahrenheit = yield* $memo(function* () {
    return ((yield* celsius) * 9) / 5 + 32;
  });
  const label = yield* $memo(function* () {
    return `${yield* celsius}°C = ${yield* fahrenheit}°F`;
  });
  const warmer = $event(function* () {
    yield* setCelsius(c => c + 5);
  });
  return function* () {
    return (
      <p class="converter">
        <span>{yield* label}</span>
        <button class="warmer" onClick={warmer}>
          +5°C
        </button>
      </p>
    );
  };
});

export const App = $component(function* () {
  const [state, setState] = yield* $store<{ items: Item[] }>({ items: [] });
  const [draft, setDraft] = yield* $signal("");
  const [filter, setFilter] = yield* $signal<Filter>("all");
  let nextId = 1;

  const visible = yield* $memo(function* () {
    const f = yield* filter;
    return yield* readStore(state, s =>
      s.items.filter(item => f === "all" || (f === "done") === item.done)
    );
  });
  const remaining = yield* $memo(function* () {
    return yield* readStore(state, s => s.items.filter(item => !item.done).length);
  });
  const summary = yield* $memo(function* () {
    const n = yield* remaining;
    return `${n} ${n === 1 ? "item" : "items"} left`;
  });

  const typing = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    yield* setDraft(e.currentTarget.value);
  });
  const add = $event(function* (e: SubmitEvent) {
    e.preventDefault();
    const title = (yield* draft).trim();
    if (!title) return;
    const id = nextId++;
    yield* setState(s => {
      s.items.push({ id, title, done: false });
    });
    yield* setDraft("");
  });
  const toggle = (id: number) =>
    $event(function* () {
      yield* setState(s => {
        const item = s.items.find(x => x.id === id);
        if (item) item.done = !item.done;
      });
    });
  const show = (next: Filter) =>
    $event(function* () {
      yield* setFilter(next);
    });

  return function* () {
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
  };
});
