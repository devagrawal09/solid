/**
 * Scenario 2, file B — the subscriber that pays for the memo's habits.
 *
 * This effect is the "recalculate shipping" kind of work an app does once per
 * real change. With the wide summary it runs on every keystroke in the gift
 * note, because the memo it reads mints a new — but equivalent — object each
 * time, so the equality cutoff that would normally absorb the run never fires.
 *
 * The runtime reports that as `UNSTABLE_MEMO_OUTPUT` after four consecutive
 * equivalent runs, and `attribution.history("rerun")` names the cause of each run.
 *
 * v2 notes: built per mode (see `ResultsPanel`); the named `shipping` effect
 * stays a plain `createEffect`.
 */
import {
  $component,
  $event,
  For,
  Show,
  createEffect,
  type TypedProps,
  type TypedStore
} from "solid-js";
import { nodeName, scenarioReruns } from "../../diagnostics/channel";
import { createPaintLog } from "../../diagnostics/paint-log";
import { EvidencePanel } from "../../diagnostics/Evidence";
import { perValue } from "../../per-value";
import { createNarrowSummaryCart, createWideSummaryCart, type Cart, type CartModel } from "./cart";

const money = (amount: number) => `$${amount.toFixed(2)}`;

const summaryFor = perValue((broken: boolean) =>
  $component(function* () {
    const model: CartModel = broken ? createWideSummaryCart() : createNarrowSummaryCart();
    const paint = createPaintLog(5);
    // A plain `createStore` store reads with `yield*` at runtime (its proxy
    // answers inside a block with path reads), but only `$store` is typed that
    // way — and a model factory outside a component cannot call `$store`.
    const cart = model.cart as unknown as TypedStore<Cart>;
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

    const note = $event(function* (event: InputEvent & { currentTarget: HTMLInputElement }) {
      model.setNote(event.currentTarget.value);
    });
    const add = $event(function* () {
      model.addLine();
    });

    return function* () {
      return (
        <div class="scenario-body">
          <ul class="parts">
            <For each={yield* cart.lines}>
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
                value={yield* cart.note}
                onInput={note}
              />
            </label>
            <button id="overrun-add" type="button" class="ghost" onClick={add}>
              Add a part
            </button>
          </div>

          <p class="totals">
            {(yield* model.summary).count} items ·{" "}
            <strong>{money((yield* model.summary).total)}</strong>
            <Show when={yield* model.gift}>
              {" "}
              <span class="badge">gift note attached</span>
            </Show>
          </p>

          <EvidencePanel feed="overrun">
            <div class="measure">
              <h4>Shipping effect</h4>
              <ol class="frames">
                <For each={yield* paint.frames}>{frame => <li>{frame}</li>}</For>
              </ol>
              {/* The original's `rerunsOfEffect()` reads the paint log so the
                  panel refreshes when the effect runs; here the read is the
                  `yield*` in the `when` expression. */}
              <Show
                when={(yield* paint.frames, scenarioReruns(nodeName("overrun", "shipping")).at(-1))}
                keyed
              >
                {last => (
                  <p class="quiet">
                    last run caused by{" "}
                    <code>{last.causes.map(cause => cause.name).join(", ") || "creation"}</code>,
                    value {last.changed ? "changed" : "unchanged"}
                  </p>
                )}
              </Show>
              <p class="quiet">Typing in the gift note cannot change a count or a total.</p>
            </div>
          </EvidencePanel>
        </div>
      );
    };
  })
);

export const CheckoutSummary = $component(function* (props: TypedProps<{ broken: boolean }>) {
  return function* () {
    const Summary = summaryFor(yield* props.broken);
    return <Summary />;
  };
});
