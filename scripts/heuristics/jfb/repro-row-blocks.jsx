// Repro for jfb-store/README.md "Strict-mode findings" 2: <For> rows that are
// `$` blocks lose keyed identity. The mapped value is the block (a function),
// so insert re-runs every row block on each list change: all <li> nodes are
// re-created on a swap. `window.__check()` reports how many survived.
import { $, createSignal, For } from "solid-js";
import { render } from "@solidjs/web";

const [items, setItems] = createSignal([{ id: 1 }, { id: 2 }, { id: 3 }]);
render(
  () => (
    <ul>
      <For each={items()}>
        {it =>
          $(function* () {
            return <li>{it.id}</li>;
          })
        }
      </For>
    </ul>
  ),
  document.getElementById("main")
);
window.__check = async () => {
  const lis = [...document.querySelectorAll("li")];
  lis.forEach(l => (l.__kept = 1));
  const i = items();
  setItems([i[2], i[1], i[0]]);
  await new Promise(r => setTimeout(r, 0));
  return `${[...document.querySelectorAll("li")].filter(l => l.__kept).length}/3 kept, text=${document.querySelector("ul").textContent}`;
};
