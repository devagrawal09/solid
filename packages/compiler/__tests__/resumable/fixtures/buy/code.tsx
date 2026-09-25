import { $ } from "solid-js";
import { track } from "./actions";

const STEP = 5;

// Fixture 1: event-only handlers whose captures are a props-derived const, a
// module literal constant and a link-verified server action; a prelude
// (preventDefault + guard) and a snapshot of the event fields the body reads.
export function Buy(props: { sku: string }) {
  const sku = props.sku;
  return (
    <a
      href="/buy"
      class="link"
      onClick={$((e: MouseEvent) => {
        e.preventDefault();
        if (e.button !== 0) return;
        track(sku, STEP, e.clientX, e.currentTarget.id);
      })}
      onInput={$((e: InputEvent) => track(sku, STEP, e.currentTarget.value, null))}
    >
      Buy {sku}
    </a>
  );
}
