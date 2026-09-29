/**
 * The observer's own UI: it renders what the channels reported, so it is
 * mounted under an excluded root (see `channel.ts`) and never becomes part of
 * the evidence it shows.
 */
import {
  $component,
  For,
  OBSERVE,
  Show,
  createRoot,
  getOwner,
  onCleanup,
  renderBlock,
  type TypedProps
} from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DiagnosticEvent, HoldEvent, InteractionEvent } from "solid-js";
import { scenarioFeed, type FeedId } from "./channel";

/**
 * Kept plain: it is a root boundary, not a view. It calls `props.children()`
 * inside `createRoot`, which a v2 component cannot do (a setup does not read
 * props; a view only reads, and what it returns is rendered in the view's
 * owner, not in a root of its own).
 *
 * Mounts `children()` in a root marked as the observer's own. Disposal stays
 * tied to the calling component through `onCleanup`.
 */
export function Excluded(props: { children: () => JSX.Element }): JSX.Element {
  let dispose!: () => void;
  const view = createRoot(disposeRoot => {
    dispose = disposeRoot;
    if (OBSERVE) OBSERVE.exclude(getOwner()!);
    // Twin: the content is a `$component` (`EvidenceBody`), and a component
    // call returns a view that renders where it is INSERTED — outside this
    // root, so nothing in it would be excluded. Render it here, in the root.
    // (Called from inside a view, the call is deferred: the value is a view
    // thunk, not a block — `renderBlock` takes both.)
    const content = props.children();
    return typeof content === "function" ? (renderBlock(content as never) as JSX.Element) : content;
  });
  onCleanup(() => dispose());
  return view;
}

const round = (ms: number) => `${Math.round(ms)}ms`;

const DiagnosticRow = $component(function* (props: TypedProps<{ event: DiagnosticEvent }>) {
  return function* () {
    const event = yield* props.event;
    return (
      <li class={`event event-${event.severity}`}>
        <div class="event-head">
          <span class="badge">{event.severity}</span>
          <code>{event.code}</code>
        </div>
        <p class="event-message">{event.message}</p>
        <Show when={event.ownerPath?.length}>
          <p class="event-owner">in {event.ownerPath!.join(" › ")}</p>
        </Show>
      </li>
    );
  };
});

const HoldRow = $component(function* (props: TypedProps<{ hold: HoldEvent }>) {
  return function* () {
    const hold = yield* props.hold;
    const writes = hold.heldWrites.map(w => `${w.name}: ${w.prev} → ${w.value}`);
    return (
      <li class="fact">
        <div class="fact-head">
          <span class="badge">hold</span>
          <span>
            {round(hold.holdMs)} held
            {hold.action ? " (opened by an action)" : ""}
          </span>
        </div>
        <dl>
          <dt>interaction</dt>
          <dd>{hold.interaction?.target ?? hold.interaction?.name ?? "—"}</dd>
          <dt>state updates</dt>
          <dd>{writes.length ? writes.join(", ") : "—"}</dd>
          <dt>waiting on</dt>
          <dd>{hold.blockers.join(", ") || "—"}</dd>
          <dt>screen said</dt>
          <dd>
            {hold.acknowledgements.length
              ? hold.acknowledgements.map(ack => `${ack.kind}:${ack.source}`).join(", ")
              : "nothing"}
          </dd>
        </dl>
      </li>
    );
  };
});

const InteractionRow = $component(function* (props: TypedProps<{ interaction: InteractionEvent }>) {
  return function* () {
    const interaction = yield* props.interaction;
    return (
      <li class="fact">
        <div class="fact-head">
          <span class="badge">{interaction.name}</span>
          <span>{interaction.target ?? "—"}</span>
        </div>
        <dl>
          <dt>handler</dt>
          <dd>{round(interaction.handlerMs)}</dd>
          <dt>root writes</dt>
          <dd>{interaction.writes}</dd>
          <dt>re-runs caused</dt>
          <dd>{interaction.runs}</dd>
          <dt>user waited</dt>
          <dd>
            {interaction.settledMs === undefined
              ? "still settling"
              : interaction.outcome === "idle"
                ? // A dispatch that wrote nothing has nothing to wait for — the
                  // wait, if there was one, belongs to the hold it never joined.
                  "nothing to wait for — this click wrote no state"
                : `${round(interaction.settledMs)} (${interaction.outcome})`}
          </dd>
        </dl>
      </li>
    );
  };
});

interface EvidenceProps {
  feed: FeedId;
  /** Extra measurements the scenario itself recorded (run counts, timings). */
  children?: JSX.Element;
  showInteractions?: boolean;
  showHolds?: boolean;
}

/** The panel's body, mounted inside the excluded root by `EvidencePanel`. */
const EvidenceBody = $component(function* (props: TypedProps<EvidenceProps>) {
  return function* () {
    const feed = scenarioFeed(yield* props.feed);
    return (
      <div class="evidence">
        {props.children}
        <Show
          when={(yield* feed).diagnostics.length}
          fallback={<p class="quiet">No diagnostics on this channel yet.</p>}
        >
          <ul class="events">
            <For each={(yield* feed).diagnostics}>{event => <DiagnosticRow event={event} />}</For>
          </ul>
        </Show>
        <Show when={(yield* props.showInteractions) && (yield* feed).interactions.length}>
          <ul class="events">
            <For each={(yield* feed).interactions.slice(-2)}>
              {interaction => <InteractionRow interaction={interaction} />}
            </For>
          </ul>
        </Show>
        <Show when={(yield* props.showHolds) && (yield* feed).holds.length}>
          <ul class="events">
            <For each={(yield* feed).holds.slice(-2)}>{hold => <HoldRow hold={hold} />}</For>
          </ul>
        </Show>
      </div>
    );
  };
});

/**
 * Diagnostics + attribution records the channels routed to one scenario.
 *
 * v2: `Excluded` takes a render function — a plain callback, which cannot
 * `yield*` — so this view reads the props and hands them to `EvidenceBody`,
 * whose own view reads the feed inside the excluded root.
 */
export const EvidencePanel = $component(function* (props: TypedProps<EvidenceProps>) {
  return function* () {
    const feed = yield* props.feed;
    const showInteractions = yield* props.showInteractions;
    const showHolds = yield* props.showHolds;
    return (
      <Excluded>
        {() => (
          <EvidenceBody feed={feed} showInteractions={showInteractions} showHolds={showHolds}>
            {/* Forwarded unread (a path read the renderer resolves), so the
                scenario's measurements are created inside the excluded root,
                as the original's lazy `props.children` read is. Reading it
                here with `yield*` created them in this view's owner, and the
                attribution engine counted their re-runs as the app's. */}
            {props.children}
          </EvidenceBody>
        )}
      </Excluded>
    );
  };
});
