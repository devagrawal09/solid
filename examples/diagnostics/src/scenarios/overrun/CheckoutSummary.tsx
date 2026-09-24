/**
 * Scenario 2, file B — the subscriber that pays for the memo's habits.
 *
 * This effect is the "recalculate shipping" kind of work an app does once per
 * real change. With the wide summary it runs on every keystroke in the gift
 * note, because the memo it reads mints a new — but equivalent — object each
 * time, so the equality cutoff that would normally absorb the run never fires.
 *
 * The runtime reports that as `UNSTABLE_MEMO_OUTPUT` after four consecutive
 * equivalent runs, and `attribution.history()` names the cause of each run.
 */
import { For, Show, createEffect } from "solid-js";
import type { JSX } from "@solidjs/web";
import { nodeName, scenarioReruns } from "../../diagnostics/channel";
import { createPaintLog } from "../../diagnostics/paint-log";
import { EvidencePanel } from "../../diagnostics/Evidence";
import { createNarrowSummaryCart, createWideSummaryCart, type CartModel } from "./cart";

const money = (amount: number) => `$${amount.toFixed(2)}`;

export function CheckoutSummary(props: { broken: boolean }): JSX.Element {
  const model: CartModel = props.broken ? createWideSummaryCart() : createNarrowSummaryCart();
  const paint = createPaintLog(5);
  let runs = 0;

  createEffect(
    () => model.summary(),
    summary => {
      runs += 1;
      // Stand-in for the real work this shape of effect usually does:
      // re-pricing shipping, re-validating a coupon, posting analytics.
      paint.record(`run ${runs}: ${summary.count} items · ${money(summary.total)}`);
    },
    { name: nodeName("overrun", "shipping") }
  );

  const rerunsOfEffect = () => {
    // Read through the paint log so the panel refreshes when the effect runs.
    paint.frames();
    return scenarioReruns(nodeName("overrun", "shipping"));
  };

  return (
    <div class="scenario-body">
      <ul class="parts">
        <For each={model.cart.lines}>
          {line => (
            <li>
              <code>{line.sku}</code>
              <span>{line.label}</span>
              <span class="quiet">
                ×{line.qty} · {money(line.price)}
              </span>
            </li>
          )}
        </For>
      </ul>

      <div class="row">
        <label class="field grow">
          <span>Gift note</span>
          <input
            id="overrun-note"
            type="text"
            placeholder="type a few words…"
            autocomplete="off"
            value={model.cart.note}
            onInput={event => model.setNote(event.currentTarget.value)}
          />
        </label>
        <button id="overrun-add" type="button" class="ghost" onClick={() => model.addLine()}>
          Add a part
        </button>
      </div>

      <p class="totals">
        {model.summary().count} items · <strong>{money(model.summary().total)}</strong>
        <Show when={model.gift()}>
          {" "}
          <span class="badge">gift note attached</span>
        </Show>
      </p>

      <EvidencePanel feed="overrun">
        <div class="measure">
          <h4>Shipping effect</h4>
          <ol class="frames">
            <For each={paint.frames()}>{frame => <li>{frame}</li>}</For>
          </ol>
          <Show when={rerunsOfEffect().at(-1)} keyed>
            {last => (
              <p class="quiet">
                last run caused by{" "}
                <code>{last.causes.map(cause => cause.name).join(", ") || "creation"}</code>, value{" "}
                {last.changed ? "changed" : "unchanged"}
              </p>
            )}
          </Show>
          <p class="quiet">Typing in the gift note cannot change a count or a total.</p>
        </div>
      </EvidencePanel>
    </div>
  );
}
