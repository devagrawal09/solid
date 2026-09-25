import { $ } from "solid-js";
import { track } from "./actions";

const STEP = 5;

// Fixture 1: an event-only strict handler with exact serializable captures —
// a props-derived `const` (per instance), a module literal constant, and a
// registered server action. Nothing here creates reactive state; the
// component never needs to run on the client.
export function Buy(props: { sku: string; disabled?: boolean }) {
  const sku = props.sku;
  return (
    <div class="buy">
      <a
        href="/buy"
        class="link"
        onClick={$((e: MouseEvent) => {
          e.preventDefault();
          if (e.button !== 0) return;
          track(sku, STEP, { kind: "click", x: e.clientX, trusted: e.isTrusted });
        })}
      >
        Buy {sku}
      </a>
      <input
        class="qty"
        type="text"
        onInput={$((e: InputEvent) => {
          track(sku, STEP, { kind: "input", value: e.currentTarget.value });
        })}
      />
      <button
        type="button"
        class="fail"
        onClick={$(() => {
          throw new Error("sync boom " + sku);
        })}
      >
        Fail
      </button>
      <button
        type="button"
        class="reject"
        onClick={$(async () => {
          await track(sku, STEP, { kind: "before-reject" });
          throw new Error("async boom " + sku);
        })}
      >
        Reject
      </button>
      <button
        type="button"
        class="stop"
        onClick={$((e: MouseEvent) => {
          e.stopPropagation();
          track(sku, STEP, { kind: "stop" });
        })}
      >
        Stop
      </button>
    </div>
  );
}
