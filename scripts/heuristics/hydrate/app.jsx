import { createMemo, createSignal } from "solid-js";

export function makeApp(n) {
  const [selected, setSelected] = createSignal(-1);
  const setters = [];
  function Row(props) {
    const id = props.id;
    const [label, setLabel] = createSignal("row " + id);
    setters[id] = setLabel;
    const isSel = createMemo(() => selected() === id);
    return (
      <tr class={isSel() ? "danger" : ""}>
        <td class="col-md-1">{id}</td>
        <td class="col-md-4">{label()}</td>
      </tr>
    );
  }
  function App() {
    const ids = [];
    for (let i = 0; i < n; i++) ids.push(i);
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
  return { App, setSelected, setters };
}
