/**
 * Scenario 1 — EFFECT_WRITES_OWN_SOURCE (examples/attribution-lab's Pager,
 * written with generator blocks v2).
 *
 * Story: you are on page 6 of 6 at 10 per page. Switch to 25 per page and
 * there are only 3 pages, so page 6 no longer exists.
 *
 *   broken — the `clampPage` effect reads `page` and writes `page`. The flush
 *            that shrank `pageCount` cannot also fix `page`: the clamp is a
 *            SECOND write, so it takes a second flush, and the frame in
 *            between paints "Page 6 of 3" — a state the app considers
 *            impossible.
 *
 *   fixed  — `page` is a memo of `rawPage` and `pageCount`. One flush, one
 *            reader run, no torn frame, and `clampPage` does not exist.
 *
 * v2 notes: the named effects (`clampPage`, `pageLabel`) stay plain
 * `createEffect(compute, effect, { name })` calls in the setup — an effect
 * block takes no options, and the whole card is about what the attribution
 * engine reports under those names. The variant decides which nodes exist,
 * which a setup cannot read from props, so the card is built per variant.
 */
import { $component, $event, $memo, $signal, For, createEffect, type TypedProps } from "solid-js";
import { ITEM_COUNT, PAGE_SIZES, createPagination } from "./pagination";
import type { Variant } from "../../lab/engine";
import { perValue } from "../../lab/variants";

/** Scope names whose re-runs this card renders in the report. */
export const CLAMP_WATCH = ["pageLabel"] as const;

const pagerFor = perValue((variant: Variant) =>
  $component(function* () {
    const { page, setPage, pageSize, setPageSize, pageCount } = createPagination(variant);
    const [label, setLabel] = yield* $signal("", { name: "label" });
    const [frames, setFrames] = yield* $signal<string[]>([], { name: "frames" });

    if (variant === "broken") {
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
    const perPage = yield* $memo(function* () {
      return `${ITEM_COUNT} items · ${yield* pageSize} per page`;
    });

    const next = $event(function* () {
      setPage(p => p + 1);
    });
    // One handler per size: the original's `onClick={() => setPageSize(size)}`
    // inside the `For` callback.
    const sizeTo = (size: number) =>
      $event(function* () {
        setPageSize(size);
      });

    return function* () {
      return (
        <div class="lab-stage">
          <p class="lab-readout" id="page-label">
            {yield* label}
          </p>
          <div class="lab-controls">
            <button id="next" onClick={next}>
              Next page
            </button>
            <For each={PAGE_SIZES}>
              {size => (
                <button id={`size-${size}`} onClick={sizeTo(size)}>
                  {`${size} per page`}
                </button>
              )}
            </For>
          </div>
          <p class="lab-hint">{yield* perPage}</p>
          <div class="lab-timeline">
            <h4>frames painted by “pageLabel”</h4>
            <ul id="frames">
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
            Press “Next page” five times to reach page 6 of 6, then switch to 25 per page.
          </p>
        </div>
      );
    };
  })
);

export const Pager = $component(function* (props: TypedProps<{ variant: Variant }>) {
  return function* () {
    const Card = pagerFor(yield* props.variant);
    return <Card />;
  };
});
