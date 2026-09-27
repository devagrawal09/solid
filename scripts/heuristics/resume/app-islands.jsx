// Stage 3 twin of app.jsx for strategy F-linked: the same four islands, the
// same components and DOM (so the same hydration keys), with the state at
// module scope — the shape the island linker analyzes
// (packages/compiler/islands.js). The handler → islands map F uses is derived
// from this file by summarizeIslands + linkIslands, not written by hand.
//
// The data comes from `globalThis.__islandData` (the page's JSON blob on the
// client, set by the SSR driver on the server) and is read once at import.
import { createMemo, createSignal } from "solid-js";

export const DATA = globalThis.__islandData;
export const [selected, setSelected] = createSignal(-1);
export const [renames, setRenames] = createSignal(0);
export const labels = DATA.labels.map(l => createSignal(l));

export function select(id) {
  setSelected(id);
}
export function rename() {
  const s = selected();
  if (s < 0) return;
  labels[s][1](labels[s][0]() + "!");
  setRenames(renames() + 1);
}

function Row(props) {
  const id = props.id;
  const isSel = createMemo(() => selected() === id);
  return (
    <tr class={isSel() ? "danger" : ""} data-row={id}>
      <td class="col-md-1">{id}</td>
      <td class="col-md-4">{labels[id][0]()}</td>
    </tr>
  );
}
export function Table() {
  const ids = [];
  for (let i = 0; i < DATA.labels.length; i++) ids.push(i);
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
export function Detail() {
  const text = createMemo(() => {
    const s = selected();
    return s < 0 ? "nothing selected" : `#${s}: ${labels[s][0]()}`;
  });
  return <p class="detail">{text()}</p>;
}
export function Header() {
  return (
    <div class="header">
      <span class="count">{renames()}</span>
      <button data-action="rename">Rename selected</button>
    </div>
  );
}
export function Footer() {
  const items = DATA.footer;
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
