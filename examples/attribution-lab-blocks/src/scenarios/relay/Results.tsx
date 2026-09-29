/**
 * Scenario 2 — EFFECT_RELAY_TEAR (examples/attribution-lab's Results, written
 * with generator blocks v2).
 *
 * Story: pick Ada, then filter the list to "li". Ada is gone, so the
 * selection has to move to Linus.
 *
 *   broken — `syncSelection` relays the change by writing `selectedId` in the
 *            effect phase. `detailPane` reads both `query` and `selectedId`,
 *            so ONE keystroke runs it twice: first as "li → ada" and then as
 *            "li → linus". The runtime reports EFFECT_RELAY_TEAR.
 *
 *   fixed  — `selectedId` is a memo, so one keystroke is one run and the
 *            inconsistent frame never exists.
 *
 * v2 notes: `detailPane` stays a plain named `createEffect` (an effect block
 * takes no `name`); the card is built per variant (`createSelection(variant)`
 * decides which nodes exist, and a setup does not read props).
 */
import { $component, $event, $memo, $signal, For, createEffect, type TypedProps } from "solid-js";
import { ROWS, createCatalog } from "./catalog";
import { createSelection } from "./selection";
import type { Variant } from "../../lab/engine";
import { perValue } from "../../lab/variants";

/** Scope names whose re-runs this card renders in the report. */
export const RELAY_WATCH = ["detailPane"] as const;

const resultsFor = perValue((variant: Variant) =>
  $component(function* () {
    const catalog = createCatalog();
    const selection = createSelection(variant, catalog);
    const [detail, setDetail] = yield* $signal("", { name: "detail" });
    const [frames, setFrames] = yield* $signal<string[]>([], { name: "frames" });

    // The victim: a named reader of both the source (`query`) and the value
    // the relay writes (`selectedId`).
    createEffect(
      () => ({ query: catalog.query(), id: selection.selectedId() }),
      state => {
        const painted = `${state.query || "∅"} → ${state.id || "none"}`;
        setDetail(painted);
        setFrames(list => [...list, painted]);
      },
      { name: "detailPane" }
    );

    const visibleRows = yield* $memo(function* () {
      const ids = yield* catalog.visibleIds;
      return ROWS.filter(row => ids.includes(row.id));
    });

    const filter = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
      catalog.setQuery(e.currentTarget.value);
    });
    const choose = (id: string) =>
      $event(function* () {
        selection.select(id);
      });

    return function* () {
      return (
        <div class="lab-stage">
          <input
            name="q"
            type="search"
            placeholder="Filter by name — try “li”, then “ken”, then “den”"
            onInput={filter}
          />
          <ul class="lab-rows">
            <For each={yield* visibleRows} fallback={<li class="lab-empty">No matches</li>}>
              {row => (
                <li>
                  {/* A plain render callback: `selection.selectedId()` is a
                      direct accessor call here (a render-callback block would
                      read it with `yield*`). */}
                  <button
                    id={`row-${row.id}`}
                    class={["lab-row", { selected: selection.selectedId() === row.id }]}
                    onClick={choose(row.id)}
                  >
                    {row.name}
                  </button>
                  <span class="lab-role">{row.role}</span>
                </li>
              )}
            </For>
          </ul>
          <p class="lab-readout" id="detail">
            {yield* detail}
          </p>
          <div class="lab-timeline">
            <h4>frames painted by “detailPane”</h4>
            <ul id="detail-frames">
              <For each={yield* frames}>
                {painted => (
                  <li>
                    <code>{painted}</code>
                  </li>
                )}
              </For>
            </ul>
          </div>
          <p class="lab-hint">
            The detail pane renders <code>query → selectedId</code>. Select{" "}
            <strong>Ada Lovelace</strong>, then filter to “li”: the broken variant paints{" "}
            <code>li → ada</code> before it paints <code>li → linus</code>.
          </p>
        </div>
      );
    };
  })
);

export const Results = $component(function* (props: TypedProps<{ variant: Variant }>) {
  return function* () {
    const Card = resultsFor(yield* props.variant);
    return <Card />;
  };
});
