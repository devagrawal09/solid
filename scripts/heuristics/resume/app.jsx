// Challenge 2 app: four islands over shared module state.
//
//   table   n rows: id, label, "danger" class when selected; click selects
//   detail  the selected row's id and label
//   header  rename count + a "Rename selected" button
//   footer  m static items (data rendered once, never written on the client)
//
// Handlers (the only client writes — cold scopes):
//   select(id)  writes `selected`                 → read by table, detail
//   rename()    writes labels[selected], renames  → read by table, detail, header
import { createMemo, createSignal } from "solid-js";

// Server data: row labels and footer items (serialized into the page for any
// strategy that re-runs components on the client).
const ADJ = [
  "pretty",
  "large",
  "big",
  "small",
  "tall",
  "short",
  "long",
  "handsome",
  "plain",
  "quaint",
  "clean",
  "elegant",
  "easy",
  "angry",
  "crazy",
  "helpful",
  "mushy",
  "odd",
  "unsightly",
  "adorable",
  "important",
  "inexpensive",
  "cheap",
  "expensive",
  "fancy"
];
const NOUN = [
  "table",
  "chair",
  "house",
  "bbq",
  "desk",
  "car",
  "pony",
  "cookie",
  "sandwich",
  "burger",
  "pizza",
  "mouse",
  "keyboard"
];
export function makeData(n, m) {
  let seed = 1;
  const rnd = k => (seed = (seed * 16807) % 2147483647) % k;
  const labels = [];
  for (let i = 0; i < n; i++) labels.push(ADJ[rnd(ADJ.length)] + " " + NOUN[rnd(NOUN.length)]);
  const footer = [];
  for (let i = 0; i < m; i++)
    footer.push({
      href: "/doc/" + i + "/" + NOUN[rnd(NOUN.length)],
      title: ADJ[rnd(ADJ.length)] + " document " + i
    });
  return { labels, footer };
}

export function makeState(data) {
  const n = data.labels.length;
  const [selected, setSelected] = createSignal(-1);
  const [renames, setRenames] = createSignal(0);
  const labels = data.labels.map(l => createSignal(l));
  const select = id => setSelected(id);
  const rename = () => {
    const s = selected();
    if (s < 0) return;
    labels[s][1](labels[s][0]() + "!");
    setRenames(renames() + 1);
  };
  return { n, selected, renames, labels, select, rename };
}

export function makeRegions(state, data) {
  function Row(props) {
    const id = props.id;
    const label = state.labels[id][0];
    const isSel = createMemo(() => state.selected() === id);
    return (
      <tr class={isSel() ? "danger" : ""} data-row={id}>
        <td class="col-md-1">{id}</td>
        <td class="col-md-4">{label()}</td>
      </tr>
    );
  }
  function Table() {
    const ids = [];
    for (let i = 0; i < state.n; i++) ids.push(i);
    return (
      <table>
        <tbody>
          {ids.map(i => (
            <Row id={i} />
          ))}
        </tbody>
      </table>
    );
  }
  function Detail() {
    const text = createMemo(() => {
      const s = state.selected();
      return s < 0 ? "nothing selected" : `#${s}: ${state.labels[s][0]()}`;
    });
    return <p class="detail">{text()}</p>;
  }
  function Header() {
    return (
      <div class="header">
        <span class="count">{state.renames()}</span>
        <button data-action="rename">Rename selected</button>
      </div>
    );
  }
  function Footer() {
    const items = data.footer;
    return (
      <ul class="footer">
        {items.map(it => (
          <li>
            <a href={it.href}>{it.title}</a>
          </li>
        ))}
      </ul>
    );
  }
  return { table: Table, detail: Detail, header: Header, footer: Footer };
}
