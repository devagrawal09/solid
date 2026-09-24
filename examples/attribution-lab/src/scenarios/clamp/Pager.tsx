/**
 * Scenario 1 — EFFECT_WRITES_OWN_SOURCE.
 *
 * Story: you are on page 6 of 6 at 10 per page. Switch to 25 per page and
 * there are only 3 pages, so page 6 no longer exists.
 *
 *   broken — the `clampPage` effect reads `page` and writes `page`. The flush
 *            that shrank `pageCount` cannot also fix `page`: the clamp is a
 *            SECOND write, so it takes a second flush, and the frame in
 *            between paints "Page 6 of 3" — a state the app considers
 *            impossible. The runtime proves the feedback edge from the cause
 *            chain (the write that re-ran the effect was the effect's own) and
 *            reports EFFECT_WRITES_OWN_SOURCE with `flushes: 2`.
 *
 *   fixed  — `page` is a memo of `rawPage` and `pageCount`. One flush, one
 *            reader run, no torn frame, and `clampPage` does not exist.
 *
 * `pageLabel` is the victim: a named reader of both `page` and `pageCount`.
 * It also appends every value it paints to `frames`, so the torn frame is
 * visible on screen instead of only in a devtools timeline. Note that its
 * compute output is a tuple and the values it writes are a string and a new
 * array — deliberately NOT its own compute output, so `pageLabel` is not
 * itself an identity-copy relay and every finding here belongs to
 * `clampPage`.
 */
import { For, createEffect, createMemo, createSignal } from "solid-js";
import { ITEM_COUNT, PAGE_SIZES, createPagination } from "./pagination";
import type { Variant } from "../../lab/engine";

/** Scope names whose re-runs this card renders in the report. */
export const CLAMP_WATCH = ["pageLabel"] as const;

export function Pager(props: { variant: Variant }) {
  const { page, setPage, pageSize, setPageSize, pageCount } = createPagination(props.variant);
  const [label, setLabel] = createSignal("", { name: "label" });
  const [frames, setFrames] = createSignal<string[]>([], { name: "frames" });

  if (props.variant === "broken") {
    // ── the defect ──────────────────────────────────────────────────────
    // Reads `page`, writes `page`: correcting one of its own inputs after
    // the fact instead of making the invalid state unrepresentable.
    createEffect(
      () => ({ page: page(), max: pageCount() }),
      state => {
        if (state.page > state.max) setPage(state.max);
      },
      { name: "clampPage" }
    );
  }

  createEffect(
    () => ({ page: page(), max: pageCount() }),
    state => {
      const painted = `Page ${state.page} of ${state.max}`;
      setLabel(painted);
      setFrames(list => [...list, painted]);
    },
    { name: "pageLabel" }
  );

  // Reads `pageSize` only — never `page` — so it is not a second victim and
  // the card's evidence stays about one reader.
  const perPage = createMemo(() => `${ITEM_COUNT} items · ${pageSize()} per page`);

  return (
    <div class="lab-stage">
      <p class="lab-readout" id="page-label">
        {label()}
      </p>
      <div class="lab-controls">
        <button id="next" onClick={() => setPage(p => p + 1)}>
          Next page
        </button>
        <For each={PAGE_SIZES}>
          {size => (
            <button id={`size-${size}`} onClick={() => setPageSize(size)}>
              {`${size} per page`}
            </button>
          )}
        </For>
      </div>
      <p class="lab-hint">{perPage()}</p>
      <div class="lab-timeline">
        <h4>frames painted by “pageLabel”</h4>
        <ul id="frames">
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
        Press “Next page” five times to reach page 6 of 6, then switch to 25 per page.
      </p>
    </div>
  );
}
