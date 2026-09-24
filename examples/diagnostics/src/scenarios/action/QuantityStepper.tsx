/**
 * Scenario 4, file B — the interaction.
 *
 * BROKEN: the action reads the quantity *before* it awaits, then writes the
 * number it computed back afterwards. One click is fine. Two clicks inside
 * the round trip both read 0, both write 1, and the buyer who clicked twice
 * gets one item — while the screen showed nothing at all for the whole wait,
 * because the write was held behind the pending save and nothing on screen
 * acknowledged it.
 *
 * The runtime says both halves out loud:
 *
 * - `SILENT_HOLD` — the write was held and the screen never answered.
 * - `attribution.interactions()` / `holds()` — the UI event (`click on
 *   button#action-inc`), that it opened an action, every root write staged
 *   behind it with its before/after values, and how long the person waited.
 *
 * FIXED: an optimistic write shows the expected result immediately (which is
 * also what acknowledges the hold), and the server applies a delta, so two
 * overlapping clicks compose instead of clobbering.
 */
import { For, action, createOptimistic, createSignal, isPending } from "solid-js";
import type { JSX } from "@solidjs/web";
import { nodeName } from "../../diagnostics/channel";
import { createPaintLog } from "../../diagnostics/paint-log";
import { EvidencePanel } from "../../diagnostics/Evidence";
import { addQuantity, latency, putQuantity, reset, serverQuantity } from "./cart-api";

interface Stepper {
  quantity: () => number;
  bump: (delta: number) => Promise<unknown>;
  reset: () => void;
  pending?: () => boolean;
}

function createBrokenStepper(): Stepper {
  // The fake server outlives the component; a rebuilt graph starts from zero.
  reset();
  const [quantity, setQuantity] = createSignal(0, { name: nodeName("action", "quantity") });

  const bump = action(function* (delta: number) {
    // Read now, write later: the value this action will store was decided
    // before anything was saved, and nothing re-checks it afterwards.
    const next = quantity() + delta;
    yield putQuantity(next);
    setQuantity(next);
  });

  return {
    quantity,
    bump,
    reset: () => {
      reset();
      setQuantity(0);
    }
  };
}

function createFixedStepper(): Stepper {
  reset();
  const [confirmed, setConfirmed] = createSignal(0, {
    name: nodeName("action", "confirmed")
  });
  // Optimistic overlay over the confirmed value: writes show immediately and
  // revert if the action fails.
  const [quantity, setQuantity] = createOptimistic<number>(() => confirmed(), {
    name: nodeName("action", "quantity")
  });

  const bump = action(function* (delta: number) {
    // Functional write: composes with a second click that is already in
    // flight instead of overwriting whatever it decided.
    setQuantity(current => current + delta);
    const stored: number = yield addQuantity(delta);
    setConfirmed(stored);
  });

  return {
    quantity,
    bump,
    reset: () => {
      reset();
      setConfirmed(0);
    },
    pending: () => isPending(quantity)
  };
}

export function QuantityStepper(props: { broken: boolean }): JSX.Element {
  const stepper = props.broken ? createBrokenStepper() : createFixedStepper();
  const paint = createPaintLog(4);

  const click = () => {
    const startedAt = performance.now();
    void stepper.bump(1).then(() => {
      paint.record(
        `+1 settled in ${Math.round(performance.now() - startedAt)}ms · server says ${serverQuantity()}`
      );
    });
  };

  return (
    <div class="scenario-body">
      <div class="stepper">
        <button id="action-inc" type="button" class="primary" onClick={click}>
          Add one
        </button>
        <output class={["quantity", { pending: !!stepper.pending?.() }]}>
          {stepper.quantity()}
        </output>
        <span class="quiet">in cart · server takes {latency()}ms</span>
        <button
          id="action-reset"
          type="button"
          class="ghost"
          onClick={() => {
            stepper.reset();
            paint.clear();
          }}
        >
          Reset
        </button>
      </div>

      <p class="quiet">
        Click <strong>Add one</strong> twice, quickly. Watch the number — and what the channel says
        about the wait.
      </p>

      <EvidencePanel feed="action" showInteractions showHolds>
        <div class="measure">
          <h4>Saves</h4>
          <ol class="frames">
            <For each={paint.frames()}>{frame => <li>{frame}</li>}</For>
          </ol>
        </div>
      </EvidencePanel>
    </div>
  );
}
