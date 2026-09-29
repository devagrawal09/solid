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
 *
 * v2 notes: the panel is built per mode (`broken` decides which inventory
 * graph exists, and a setup does not read props); the named `summary` effect
 * stays a plain `createEffect` (an effect block takes no `name`, and the
 * diagnostics route by it).
 */
import { $component, $event, For, createEffect, type TypedProps } from "solid-js";
import { nodeName } from "../../diagnostics/channel";
import { createPaintLog } from "../../diagnostics/paint-log";
import { EvidencePanel } from "../../diagnostics/Evidence";
import { perValue } from "../../per-value";
import { createDerivedInventory, createRelayedInventory, type Inventory } from "./inventory";

const panelFor = perValue((broken: boolean) =>
  $component(function* () {
    const inventory: Inventory = broken ? createRelayedInventory() : createDerivedInventory();
    const paint = createPaintLog(6);

    // The summary a person actually reads: query and count, in one sentence.
    createEffect(
      () => `“${inventory.query() || "everything"}” → ${inventory.matches().length} parts`,
      summary => {
        paint.record(summary);
      },
      { name: nodeName("tear", "summary") }
    );

    const search = $event(function* (event: InputEvent & { currentTarget: HTMLInputElement }) {
      inventory.setQuery(event.currentTarget.value);
    });

    return function* () {
      return (
        <div class="scenario-body">
          <label class="field">
            <span>Search parts</span>
            <input
              id="tear-query"
              type="search"
              placeholder="try typing “br”"
              autocomplete="off"
              value={yield* inventory.query}
              onInput={search}
            />
          </label>

          <ul class="parts">
            <For each={yield* inventory.matches}>
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
                <For each={yield* paint.frames}>{frame => <li>{frame}</li>}</For>
              </ol>
              <p class="quiet">
                One keystroke should paint one frame. Two frames means the first one was wrong.
              </p>
            </div>
          </EvidencePanel>
        </div>
      );
    };
  })
);

export const ResultsPanel = $component(function* (props: TypedProps<{ broken: boolean }>) {
  return function* () {
    const Panel = panelFor(yield* props.broken);
    return <Panel />;
  };
});
