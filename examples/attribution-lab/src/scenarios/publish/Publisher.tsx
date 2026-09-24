/**
 * Scenario 4 — provenance: a real delegated click → an async generator action
 * → four named readers.
 *
 * `onClick` on a delegated event goes through the web runtime's dispatch,
 * which wraps the handler in `OBSERVE.attribution.withInteraction`
 * (`packages/web/src/client.ts`). Every root write the handler causes is then
 * stamped with the event and with a description of what was hit — which is
 * why `#publish` is a text-only button: the engine describes `e.target`, so a
 * `<span>` inside the button would make the target the span.
 *
 * Neither variant emits a diagnostic. The finding is the attribution record
 * itself: in the fixed variant every reader's run traces back to
 * `action "publish" (under click on button#publish "Publish 3 drafts")`; in
 * the broken one only the first slice does, and every post-`await` write
 * reports as `external` — highlighted in the report panel.
 */
import { createEffect, createSignal } from "solid-js";
import { DRAFTS, PUBLISH_LATENCY_MS, createPublisher } from "./drafts";
import type { Variant } from "../../lab/engine";

/** Scope names whose re-runs this card renders in the report. */
export const PUBLISH_WATCH = [
  "statusBadge",
  "progressBar",
  "publishedList",
  "skippedNote"
] as const;

export function Publisher(props: { variant: Variant; latency?: number }) {
  const publisher = createPublisher(props.variant, props.latency ?? PUBLISH_LATENCY_MS);
  const [statusText, setStatusText] = createSignal("", { name: "statusText" });
  const [progressText, setProgressText] = createSignal("", { name: "progressText" });
  const [publishedText, setPublishedText] = createSignal("", { name: "publishedText" });
  const [skippedText, setSkippedText] = createSignal("", { name: "skippedText" });

  // Four named readers, one per piece of state. Each writes a value that is
  // NOT its own compute output — otherwise the reader would itself be an
  // identity-copy relay, which the engine warns about on its own after two
  // runs, and this card would be reporting its own scaffolding. That is why
  // `statusBadge` computes a wrapper: the other three already transform
  // (number → string, array → string).
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

  return (
    <div class="lab-stage">
      <div class="lab-controls">
        {/* Text-only: the engine describes `e.target`, so a nested element
            here would change the recorded interaction target. */}
        <button
          id="publish"
          onClick={() => {
            publisher.publish(DRAFTS).catch(() => {});
          }}
        >
          Publish 3 drafts
        </button>
      </div>
      <dl class="lab-facts">
        <div>
          <dt>Status</dt>
          <dd id="status">{statusText()}</dd>
        </div>
        <div>
          <dt>Progress</dt>
          <dd id="progress">{progressText()}</dd>
        </div>
        <div>
          <dt>Published</dt>
          <dd id="published">{publishedText()}</dd>
        </div>
        <div>
          <dt>Skipped</dt>
          <dd id="skipped">{skippedText()}</dd>
        </div>
      </dl>
      <p class="lab-hint">
        Both variants finish identically — <code>done · 3/3 · Draft B skipped</code>. Only the
        report tells them apart: the broken variant loses the click after the first{" "}
        <code>await</code>.
      </p>
    </div>
  );
}
