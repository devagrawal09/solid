/**
 * Scenario 4 — provenance: a real delegated click → an async generator action
 * → four named readers (examples/attribution-lab's Publisher, written with
 * generator blocks v2).
 *
 * Neither variant emits a diagnostic. The finding is the attribution record
 * itself: in the fixed variant every reader's run traces back to
 * `action "publish" (under click on button#publish "Publish 3 drafts")`; in
 * the broken one only the first slice does, and every post-`await` write
 * reports as `external`.
 *
 * v2 notes: the four named readers stay plain `createEffect(…, { name })`
 * calls (an effect block takes no `name`); `createPublisher(variant, latency)`
 * needs both values in the setup, so the card is built per (variant,
 * latency). The click handler is an `$event` — the web runtime still wraps its
 * dispatch in `withInteraction`, so the recorded interaction is unchanged.
 */
import { $component, $event, $signal, createEffect, type TypedProps } from "solid-js";
import { DRAFTS, PUBLISH_LATENCY_MS, createPublisher } from "./drafts";
import type { Variant } from "../../lab/engine";
import { perValue } from "../../lab/variants";

/** Scope names whose re-runs this card renders in the report. */
export const PUBLISH_WATCH = [
  "statusBadge",
  "progressBar",
  "publishedList",
  "skippedNote"
] as const;

const publisherFor = perValue((key: string) => {
  const [variant, latency] = key.split(":") as [Variant, string];
  return $component(function* () {
    const publisher = createPublisher(variant, Number(latency));
    const [statusText, setStatusText] = yield* $signal("", { name: "statusText" });
    const [progressText, setProgressText] = yield* $signal("", { name: "progressText" });
    const [publishedText, setPublishedText] = yield* $signal("", { name: "publishedText" });
    const [skippedText, setSkippedText] = yield* $signal("", { name: "skippedText" });

    // Four named readers, one per piece of state. Each writes a value that is
    // NOT its own compute output (see the original for why).
    createEffect(
      () => ({ status: publisher.status() }),
      state => {
        setStatusText(state.status);
      },
      { name: "statusBadge" }
    );
    createEffect(
      publisher.progress,
      value => {
        setProgressText(`${value}/${DRAFTS.length}`);
      },
      { name: "progressBar" }
    );
    createEffect(
      publisher.published,
      list => {
        setPublishedText(list.length > 0 ? list.join(", ") : "none yet");
      },
      { name: "publishedList" }
    );
    createEffect(
      publisher.skipped,
      list => {
        setSkippedText(list.length > 0 ? list.join(", ") : "none");
      },
      { name: "skippedNote" }
    );

    const publish = $event(function* () {
      publisher.publish(DRAFTS).catch(() => {});
    });

    return function* () {
      return (
        <div class="lab-stage">
          <div class="lab-controls">
            {/* Text-only: the engine describes `e.target`, so a nested element
                here would change the recorded interaction target. */}
            <button id="publish" onClick={publish}>
              Publish 3 drafts
            </button>
          </div>
          <dl class="lab-facts">
            <div>
              <dt>Status</dt>
              <dd id="status">{yield* statusText}</dd>
            </div>
            <div>
              <dt>Progress</dt>
              <dd id="progress">{yield* progressText}</dd>
            </div>
            <div>
              <dt>Published</dt>
              <dd id="published">{yield* publishedText}</dd>
            </div>
            <div>
              <dt>Skipped</dt>
              <dd id="skipped">{yield* skippedText}</dd>
            </div>
          </dl>
          <p class="lab-hint">
            Both variants finish identically — <code>done · 3/3 · Draft B skipped</code>. Only the
            report tells them apart: the broken variant loses the click after the first{" "}
            <code>await</code>.
          </p>
        </div>
      );
    };
  });
});

export const Publisher = $component(function* (
  props: TypedProps<{ variant: Variant; latency?: number }>
) {
  return function* () {
    const Card = publisherFor(
      `${yield* props.variant}:${(yield* props.latency) ?? PUBLISH_LATENCY_MS}`
    );
    return <Card />;
  };
});
