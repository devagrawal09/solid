// Repro for jfb-store/README.md "Strict-mode findings" 1: a <For> over a store
// array inside a `$` block body. Development build: renders. Production build:
// the list's first computation runs with the block guard still raised (the
// guard reset in recompute is __DEV__-only), so mapArray's own proxy reads
// become path tokens and throw [DIRECT_READ_IN_BLOCK].
import { $, createStore, For } from "solid-js";
import { render } from "@solidjs/web";

const [s] = createStore({ items: [{ id: 1 }, { id: 2 }] });
render(
  () =>
    $(function* () {
      return (
        <ul>
          <For each={s.items}>{it => <li>{it.id}</li>}</For>
        </ul>
      );
    }),
  document.getElementById("main")
);
