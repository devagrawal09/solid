// js-framework-benchmark shape: a keyed <For> over rows, each rendered by a
// Row component that receives a per-row `isSelected` memo through props.
import { createMemo, createRoot, createSignal, flush, For } from "solid-js";
import { render } from "@solidjs/web";

function Row(props) {
  return (
    <tr class={props.selected ? "danger" : ""}>
      <td class="col-md-1">{props.row.id}</td>
      <td class="col-md-4">{props.row.label()}</td>
    </tr>
  );
}

export function make(n, tbody) {
  let nextId = 1;
  const build = count =>
    Array.from({ length: count }, () => {
      const [label, setLabel] = createSignal("row " + nextId);
      return { id: nextId++, label, setLabel };
    });
  const [rows, setRows] = createSignal([]);
  const [selected, setSelected] = createSignal(-1);
  let dispose,
    sel = 0,
    round = 0;
  return {
    mount() {
      dispose = render(
        () => (
          <For each={rows()}>
            {row => {
              const isSel = createMemo(() => selected() === row.id);
              return <Row row={row} selected={isSel()} />;
            }}
          </For>
        ),
        tbody
      );
      flush();
    },
    // Non-create ops run on a populated list.
    prepare() {
      setRows(build(n));
      flush();
    },
    unmount() {
      dispose();
      tbody.textContent = "";
      nextId = 1;
    },
    ops: {
      create() {
        setRows(build(n));
        flush();
        setRows([]);
        flush();
      },
      replace() {
        setRows(build(n));
        flush();
      },
      update10th() {
        const r = rows();
        // A fresh bounded label per round (appending would grow without
        // bound, and variants run different iteration counts).
        round++;
        for (let i = 0; i < r.length; i += 10) r[i].setLabel("row " + r[i].id + " !" + round);
        flush();
      },
      select() {
        const r = rows();
        sel = (sel * 7 + 3) % r.length;
        setSelected(r[sel].id);
        flush();
      },
      swap() {
        const r = rows().slice();
        const t = r[1];
        r[1] = r[r.length - 2];
        r[r.length - 2] = t;
        setRows(r);
        flush();
      },
      removeAdd() {
        const r = rows().slice();
        const [x] = r.splice(4, 1);
        setRows(r);
        flush();
        r.splice(4, 0, x);
        setRows(r.slice());
        flush();
      }
    }
  };
}
