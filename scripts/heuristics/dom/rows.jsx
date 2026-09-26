// DOM rows baseline (js-framework-benchmark shape). Compiled by the real
// compiler (dom-compile.mjs); the oracle variants in dom-variants.mjs are
// hand edits of that output.
import { createMemo, createRoot, createSignal, flush } from "solid-js";

export function make(n, tbody) {
  const [selected, setSelected] = createSignal(-1);
  let rows,
    dispose,
    round = 0;
  function Row(id) {
    const [label, setLabel] = createSignal("row " + id);
    const isSel = createMemo(() => selected() === id);
    const tr = (
      <tr class={isSel() ? "danger" : ""}>
        <td class="col-md-1">{id}</td>
        <td class="col-md-4">{label()}</td>
      </tr>
    );
    tbody.appendChild(tr);
    return setLabel;
  }
  return {
    mount() {
      dispose = createRoot(d => {
        rows = [];
        for (let i = 0; i < n; i++) rows.push(Row(i));
        return d;
      });
      flush();
    },
    unmount() {
      dispose();
      tbody.textContent = "";
    },
    ops: {
      update10th() {
        round++;
        for (let i = 0; i < n; i += 10) rows[i]("row " + i + " !" + round);
        flush();
      },
      select() {
        setSelected(++round % n);
        flush();
      }
    }
  };
}
