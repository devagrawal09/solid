/**
 * Scenario 1, file B — the reader.
 *
 * This component reads BOTH sides: the query the user typed and the matches
 * derived from it. That is what turns the schedule difference in
 * `inventory.ts` into a visible defect, and it is why the bug is cross-file:
 * neither file is wrong on its own.
 *
 * `EFFECT_RELAY_TEAR` is reported by the attribution engine when it can prove
 * this shape from the graph — the reader ran twice for one write of `query`,
 * the second run caused only by an effect-originated write of `matches`.
 */
import { For, createEffect } from "solid-js";
import type { JSX } from "@solidjs/web";
import { nodeName } from "../../diagnostics/channel";
import { createPaintLog } from "../../diagnostics/paint-log";
import { EvidencePanel } from "../../diagnostics/Evidence";
import { createDerivedInventory, createRelayedInventory, type Inventory } from "./inventory";

export function ResultsPanel(props: { broken: boolean }): JSX.Element {
  const inventory: Inventory = props.broken ? createRelayedInventory() : createDerivedInventory();
  const paint = createPaintLog(6);

  // The summary a person actually reads: query and count, in one sentence.
  createEffect(
    () => `“${inventory.query() || "everything"}” → ${inventory.matches().length} parts`,
    summary => {
      paint.record(summary);
    },
    { name: nodeName("tear", "summary") }
  );

  return (
    <div class="scenario-body">
      <label class="field">
        <span>Search parts</span>
        <input
          id="tear-query"
          type="search"
          placeholder="try typing “br”"
          autocomplete="off"
          value={inventory.query()}
          onInput={event => inventory.setQuery(event.currentTarget.value)}
        />
      </label>

      <ul class="parts">
        <For each={inventory.matches()}>
          {part => (
            <li>
              <code>{part.sku}</code>
              <span>{part.name}</span>
              <span class="quiet">bin {part.bin}</span>
            </li>
          )}
        </For>
      </ul>

      <EvidencePanel feed="tear">
        <div class="measure">
          <h4>Frames painted by the summary</h4>
          <ol class="frames">
            <For each={paint.frames()}>{frame => <li>{frame}</li>}</For>
          </ol>
          <p class="quiet">
            One keystroke should paint one frame. Two frames means the first one was wrong.
          </p>
        </div>
      </EvidencePanel>
    </div>
  );
}
