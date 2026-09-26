// store-strict: store-main.jsx authored in the strict generator style, so the
// compiler lowers the store reads to path readers: `$(function* () {...})`
// blocks (the rows memo and each row), and `yield*` on every reactive read.
// Markup, ops and setters are identical to store-main.jsx.
// Based on: Solid 2 port of frameworks/keyed/solid-store/src/main.jsx (JFB f2df01a8).
// Differences are only the Solid 2 API renames:
//   createSelector(() => state.selected) -> createProjection (04-stores.md migration)
//   setState(path..., value)             -> setState(storePath(path..., value)), the
//                                           documented 1.x path-setter compat helper
//   solid-js/web, solid-js/store         -> @solidjs/web, solid-js
import { $, createMemo, createStore, createProjection, storePath, For } from "solid-js";
import { render } from "@solidjs/web";

const adjectives = ["pretty", "large", "big", "small", "tall", "short", "long", "handsome", "plain", "quaint", "clean", "elegant", "easy", "angry", "crazy", "helpful", "mushy", "odd", "unsightly", "adorable", "important", "inexpensive", "cheap", "expensive", "fancy"]; // prettier-ignore
const colors = ["red", "yellow", "blue", "green", "pink", "brown", "purple", "brown", "white", "black", "orange"]; // prettier-ignore
const nouns = ["table", "chair", "house", "bbq", "desk", "car", "pony", "cookie", "sandwich", "burger", "pizza", "mouse", "keyboard"]; // prettier-ignore

const random = max => Math.round(Math.random() * 1000) % max;

let nextId = 1;

const buildData = count => {
  let data = new Array(count);
  for (let i = 0; i < count; i++) {
    data[i] = {
      id: nextId++,
      label: `${adjectives[random(adjectives.length)]} ${colors[random(colors.length)]} ${nouns[random(nouns.length)]}`
    };
  }
  return data;
};

const Button = ([id, text, fn]) => (
  <div class="col-sm-6 smallpad">
    <button prop:id={id} class="btn btn-primary btn-block" type="button" onClick={fn}>
      {text}
    </button>
  </div>
);

render(() => {
  const [state, setState] = createStore({ data: [], selected: null });
  const run = () => setState(storePath({ data: buildData(1_000) }));
  const runLots = () => setState(storePath({ data: buildData(10_000) }));
  const add = () => setState(storePath("data", d => [...d, ...buildData(1_000)]));
  const update = () => setState(storePath("data", { by: 10 }, "label", l => l + " !!!"));
  const swapRows = () =>
    setState(storePath("data", d => (d.length > 998 ? { 1: d[998], 998: d[1] } : d)));
  const clear = () => setState(storePath({ data: [] }));
  let prev = null;
  const isSelected = createProjection(s => {
    const id = state.selected;
    if (prev != null) delete s[prev];
    if (id != null) s[id] = true;
    prev = id;
  }, {});

  // The rows array, read as a lowered path in a block hosted by a memo. (Putting
  // the whole app in a `$` block fails in production builds: see README,
  // "Strict-mode finding".)
  const rows = createMemo(
    $(function* () {
      return yield* state.data;
    })
  );

  return (
    <div class="container">
      <div class="jumbotron">
        <div class="row">
          <div class="col-md-6">
            <h1>Solid Store</h1>
          </div>
          <div class="col-md-6">
            <div class="row">
              <Button {...["run", "Create 1,000 rows", run]} />
              <Button {...["runlots", "Create 10,000 rows", runLots]} />
              <Button {...["add", "Append 1,000 rows", add]} />
              <Button {...["update", "Update every 10th row", update]} />
              <Button {...["clear", "Clear", clear]} />
              <Button {...["swaprows", "Swap Rows", swapRows]} />
            </div>
          </div>
        </div>
      </div>
      <table class="table table-hover table-striped test-data">
        <tbody>
          <For each={rows()}>
            {row => {
              // The row block is run once, here, and its <tr> handed to <For>.
              // Returning the block itself makes <For>'s result an array of
              // functions, which insert re-runs on every list change: every row
              // is re-created on swap/remove/append (README, "Strict-mode
              // findings" 2).
              return $(function* () {
                const rowId = yield* row.id;
                return (
                <tr class={(yield* isSelected[rowId]) ? "danger" : ""}>
                  <td class="col-md-1" textContent={rowId} />
                  <td class="col-md-4">
                    <a onClick={() => setState(storePath("selected", rowId))} textContent={yield* row.label} />
                  </td>
                  <td class="col-md-1">
                    <a onClick={() => setState(storePath("data", (d) => d.toSpliced(d.findIndex((d) => d.id === rowId), 1)))}>
                      <span class="glyphicon glyphicon-remove" aria-hidden="true" />
                    </a>
                  </td>
                  <td class="col-md-6" />
                </tr>
              ); //prettier-ignore
              })();
            }}
          </For>
        </tbody>
      </table>
      <span class="preloadicon glyphicon glyphicon-remove" aria-hidden="true" />
    </div>
  );
}, document.getElementById("main"));
