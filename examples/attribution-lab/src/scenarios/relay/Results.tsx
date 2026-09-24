/**
 * Scenario 2 — EFFECT_RELAY_TEAR.
 *
 * Story: pick Ada, then filter the list to "li". Ada is gone, so the
 * selection has to move to Linus.
 *
 *   broken — `syncSelection` relays the change by writing `selectedId` in the
 *            effect phase. `detailPane` reads both `query` and `selectedId`,
 *            so ONE keystroke runs it twice: first as "li → ada" (a detail
 *            pane showing a row that is no longer in the list) and then as
 *            "li → linus". The runtime proves this from the cause chain — the
 *            second run's only root write came from an effect, and that
 *            effect's run shares a root write with the victim's previous run —
 *            and reports EFFECT_RELAY_TEAR. The verdict is `info` on first
 *            sight (a DOM-measurement effect may tear legitimately) and
 *            escalates to `warn` on the third tear of the same relay.
 *
 *   fixed  — `selectedId` is a memo, so one keystroke is one run and the
 *            inconsistent frame never exists.
 *
 * `detailPane`'s compute output is a tuple and what it writes is a formatted
 * string — deliberately not its own compute output, so the victim is not
 * itself a copy relay and every finding on this card belongs to
 * `syncSelection`.
 */
import { For, createEffect, createMemo, createSignal } from "solid-js";
import { ROWS, createCatalog } from "./catalog";
import { createSelection } from "./selection";
import type { Variant } from "../../lab/engine";

/** Scope names whose re-runs this card renders in the report. */
export const RELAY_WATCH = ["detailPane"] as const;

export function Results(props: { variant: Variant }) {
  const catalog = createCatalog();
  const selection = createSelection(props.variant, catalog);
  const [detail, setDetail] = createSignal("", { name: "detail" });
  const [frames, setFrames] = createSignal<string[]>([], { name: "frames" });

  // The victim: a named reader of both the source (`query`) and the value the
  // relay writes (`selectedId`). It also records every frame it paints, so
  // the torn one is on screen rather than only in a devtools timeline.
  createEffect(
    () => ({ query: catalog.query(), id: selection.selectedId() }),
    state => {
      const painted = `${state.query || "∅"} → ${state.id || "none"}`;
      setDetail(painted);
      setFrames(list => [...list, painted]);
    },
    { name: "detailPane" }
  );

  const visibleRows = createMemo(() => {
    const ids = catalog.visibleIds();
    return ROWS.filter(row => ids.includes(row.id));
  });

  return (
    <div class="lab-stage">
      <input
        name="q"
        type="search"
        placeholder="Filter by name — try “li”, then “ken”, then “den”"
        onInput={e => catalog.setQuery(e.currentTarget.value)}
      />
      <ul class="lab-rows">
        <For each={visibleRows()} fallback={<li class="lab-empty">No matches</li>}>
          {row => (
            <li>
              <button
                id={`row-${row.id}`}
                class={["lab-row", { selected: selection.selectedId() === row.id }]}
                onClick={() => selection.select(row.id)}
              >
                {row.name}
              </button>
              <span class="lab-role">{row.role}</span>
            </li>
          )}
        </For>
      </ul>
      <p class="lab-readout" id="detail">
        {detail()}
      </p>
      <div class="lab-timeline">
        <h4>frames painted by “detailPane”</h4>
        <ul id="detail-frames">
          <For each={frames()}>
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
}
