// Minimal repro (see the README, "Bugs"): a `$component` view returned from a
// `<For>` row is re-rendered when the list changes — its DOM and the
// components under it are rebuilt, so their state is lost. `it.fails` marks
// the current behavior; the other cases are the workarounds this twin uses.
import { expect, it } from "vitest";
import { render } from "@solidjs/web";
import {
  $component,
  $event,
  $signal,
  For,
  createSignal,
  flush,
  renderBlock,
  type TypedProps
} from "solid-js";
import type { JSX } from "@solidjs/web";

const Counter = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const bump = $event(function* () {
    yield* setN(v => v + 1);
  });
  return function* () {
    return (
      <button class="counter" onClick={bump}>
        {yield* n}
      </button>
    );
  };
});

const Row = $component(function* (props: TypedProps<{ label: string }>) {
  return function* () {
    return (
      <li>
        {yield* props.label} <Counter />
      </li>
    );
  };
});

function run(row: (label: string) => JSX.Element) {
  const [items, setItems] = createSignal(["a", "b"]);
  const host = document.createElement("ul");
  document.body.append(host);
  const dispose = render(() => <For each={items()}>{row}</For>, host);
  const counters = () => [...host.querySelectorAll<HTMLButtonElement>(".counter")];
  counters()[1].click();
  flush();
  setItems(["b"]);
  flush();
  const text = counters()[0].textContent;
  dispose();
  host.remove();
  return text;
}

it.fails("a $component row keeps its children's state when a sibling is removed", () => {
  expect(run(label => <Row label={label} />)).toBe("1");
});

it("workaround: render the row's view in the row callback", () => {
  expect(run(label => renderBlock(Row({ label }) as never) as JSX.Element)).toBe("1");
});

it("workaround: an element around the row", () => {
  expect(
    run(label => (
      <div>
        <Row label={label} />
      </div>
    ))
  ).toBe("1");
});
