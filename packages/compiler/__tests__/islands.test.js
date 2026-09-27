// Stage 3 (F): island summaries (summarizeIslands) and the island linker
// (islands.js). The graph mirrors the challenge-2 app
// (scripts/heuristics/resume): four islands over shared module state, and
// the hand-derived map the resumability study used —
//   select → table, detail;   rename → table, detail, header.
const { summarizeIslands } = require("..");
const { linkIslands } = require("../islands.js");

const STATE = `
import { createSignal } from "solid-js";
export const DATA = globalThis.__data;
export const [selected, setSelected] = createSignal(-1);
export const [renames, setRenames] = createSignal(0);
export const labels = DATA.labels.map(l => createSignal(l));
export function select(id) { setSelected(id); }
export function rename() {
  const s = selected();
  if (s < 0) return;
  labels[s][1](labels[s][0]() + "!");
  setRenames(renames() + 1);
}
`;
const ISLANDS = `
import { createMemo } from "solid-js";
import { DATA, labels, rename, renames, select, selected } from "./state";
function Row(props) {
  const id = props.id;
  const isSel = createMemo(() => selected() === id);
  return (
    <tr class={isSel() ? "danger" : ""} onClick={() => select(id)}>
      <td>{id}</td>
      <td>{labels[id][0]()}</td>
    </tr>
  );
}
export function Table() {
  return <table><tbody>{DATA.labels.map((_, i) => <Row id={i} />)}</tbody></table>;
}
export function Detail() {
  const text = createMemo(() => {
    const s = selected();
    return s < 0 ? "nothing selected" : "#" + s + ": " + labels[s][0]();
  });
  return <p>{text()}</p>;
}
export function Header() {
  return <div><span>{renames()}</span><button onClick={rename}>Rename</button></div>;
}
export function Footer() {
  return <ul>{DATA.footer.map(it => <li><a href={it.href}>{it.title}</a></li>)}</ul>;
}
`;

function link(files, islands, external = []) {
  const modules = {};
  for (const [id, code] of Object.entries(files))
    modules[id] = summarizeIslands(code, { filename: id });
  const resolve = (from, source) => {
    if (external.includes(source)) return null;
    const id = source.replace(/^\.\//, "") + (source.endsWith(".jsx") ? "" : ".js");
    return modules[id]
      ? id
      : modules[source.replace(/^\.\//, "") + ".jsx"]
        ? source.replace(/^\.\//, "") + ".jsx"
        : null;
  };
  return linkIslands({ modules, resolve, islands });
}

const APP_ISLANDS = {
  table: { module: "islands.jsx", export: "Table" },
  detail: { module: "islands.jsx", export: "Detail" },
  header: { module: "islands.jsx", export: "Header" },
  footer: { module: "islands.jsx", export: "Footer" }
};

describe("island linker", () => {
  test("derives the challenge-2 handler → islands map", () => {
    const out = link({ "state.js": STATE, "islands.jsx": ISLANDS }, APP_ISLANDS);
    expect(out.exports["state.js#select"]).toEqual({
      writes: ["state.js#selected"],
      islands: ["table", "detail"]
    });
    expect(out.exports["state.js#rename"].islands).toEqual(["table", "detail", "header"]);
    expect(out.exports["state.js#rename"].writes).toEqual(["state.js#labels", "state.js#renames"]);
    expect(out.islands.footer).toEqual([]);
    expect(out.islands.header).toEqual(["state.js#renames"]);
    expect(out.onEvent).toEqual({
      table: ["table", "detail"],
      detail: ["detail"],
      header: ["table", "detail", "header"],
      footer: ["footer"]
    });
    expect(out.handlers.map(h => [h.event, h.islands])).toEqual([
      ["onClick", ["table", "detail"]],
      ["onClick", ["table", "detail", "header"]]
    ]);
    expect(out.escaped).toEqual([]);
  });

  test("an escaped setter reaches every handler that calls unknown code", () => {
    const files = {
      "state.js": STATE,
      "islands.jsx":
        ISLANDS +
        `
import { track } from "analytics";
function Save(props) { return <button onClick={() => props.onSave(1)}>save</button>; }
export function Toolbar() { return <Save onSave={setRenames} />; }
export function Logger() { return <button onClick={() => track("x")}>log</button>; }
import { setRenames } from "./state";
`
    };
    const out = link(
      files,
      { ...APP_ISLANDS, toolbar: { module: "islands.jsx", export: "Toolbar" } },
      ["analytics"]
    );
    expect(out.escaped).toEqual(["state.js#renames"]);
    // props.onSave(1) and track() are unknown calls: both may write `renames`.
    // (`onSave={setRenames}` on a component is an on* prop: also a handler.)
    const writers = out.handlers.filter(
      h => h.writes.includes("state.js#renames") && h.islands.includes("header")
    );
    expect(writers.map(h => h.event)).toEqual(["onClick", "onClick", "onSave", "onClick"]); // rename, Save, Toolbar, Logger
    expect(out.onEvent.toolbar).toEqual(["header", "toolbar"]);
  });

  test("state the summary cannot name reaches every island and handler with unknown calls", () => {
    const files = {
      "store.js": `
import { createSignal } from "solid-js";
export const box = {};
box.sig = createSignal(0);
export const [count, setCount] = createSignal(0);
export const shared = {};
export function bump() { box.sig[1](v => v + 1); }
export function inc() { setCount(count() + 1); }
`,
      "ui.jsx": `
import { box, count, shared } from "./store";
export function Opaque() { return <p>{box.sig[0]()}</p>; }
export function Publisher() { shared.get = count; return <p>publisher</p>; }
export function Subscriber() { return <p>{shared.get()}</p>; }
export function Static() { return <p>static</p>; }
`
    };
    const islands = Object.fromEntries(
      ["Opaque", "Publisher", "Subscriber", "Static"].map(n => [n, { module: "ui.jsx", export: n }])
    );
    const out = link(files, islands);
    expect(out.cells.some(c => c.startsWith("store.js#<opaque@"))).toBe(true);
    // bump writes through a member call (unknown): every opaque cell; the
    // islands that call unknown code may read one.
    expect(out.exports["store.js#bump"].islands).toEqual(["Opaque", "Subscriber"]);
    // count's accessor escaped through `shared.get = count`: Subscriber's
    // unknown call may read it.
    expect(out.escapedRead).toContain("store.js#count");
    expect(out.exports["store.js#inc"].islands).toEqual(["Opaque", "Publisher", "Subscriber"]);
  });

  test("an unresolvable island root is an error, not a guess", () => {
    expect(() =>
      link({ "state.js": STATE }, { x: { module: "state.js", export: "Nope" } })
    ).toThrow(/not a function/);
  });
});
