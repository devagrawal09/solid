/**
 * The observer's own UI: it renders what the channels reported, so it is
 * mounted under an excluded root (see `channel.ts`) and never becomes part of
 * the evidence it shows.
 */
import { For, OBSERVE, Show, createRoot, getOwner, onCleanup } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { DiagnosticEvent, HoldEvent, InteractionEvent } from "solid-js";
import { scenarioFeed, type FeedId } from "./channel";

/**
 * Mounts `children()` in a root marked as the observer's own. Disposal stays
 * tied to the calling component through `onCleanup`.
 */
export function Excluded(props: { children: () => JSX.Element }): JSX.Element {
  let dispose!: () => void;
  const view = createRoot(disposeRoot => {
    dispose = disposeRoot;
    if (OBSERVE) OBSERVE.exclude(getOwner()!);
    return props.children();
  });
  onCleanup(() => dispose());
  return view;
}

const round = (ms: number) => `${Math.round(ms)}ms`;

function DiagnosticRow(props: { event: DiagnosticEvent }) {
  return (
    <li class={`event event-${props.event.severity}`}>
      <div class="event-head">
        <span class="badge">{props.event.severity}</span>
        <code>{props.event.code}</code>
      </div>
      <p class="event-message">{props.event.message}</p>
      <Show when={props.event.ownerPath?.length}>
        <p class="event-owner">in {props.event.ownerPath!.join(" › ")}</p>
      </Show>
    </li>
  );
}

function HoldRow(props: { hold: HoldEvent }) {
  const writes = () => props.hold.heldWrites.map(w => `${w.name}: ${w.prev} → ${w.value}`);
  return (
    <li class="fact">
      <div class="fact-head">
        <span class="badge">hold</span>
        <span>
          {round(props.hold.holdMs)} held
          {props.hold.action ? " (opened by an action)" : ""}
        </span>
      </div>
      <dl>
        <dt>interaction</dt>
        <dd>{props.hold.interaction?.target ?? props.hold.interaction?.name ?? "—"}</dd>
        <dt>state updates</dt>
        <dd>{writes().length ? writes().join(", ") : "—"}</dd>
        <dt>waiting on</dt>
        <dd>{props.hold.blockers.join(", ") || "—"}</dd>
        <dt>screen said</dt>
        <dd>
          {props.hold.acknowledgements.length
            ? props.hold.acknowledgements.map(ack => `${ack.kind}:${ack.source}`).join(", ")
            : "nothing"}
        </dd>
      </dl>
    </li>
  );
}

function InteractionRow(props: { interaction: InteractionEvent }) {
  return (
    <li class="fact">
      <div class="fact-head">
        <span class="badge">{props.interaction.name}</span>
        <span>{props.interaction.target ?? "—"}</span>
      </div>
      <dl>
        <dt>handler</dt>
        <dd>{round(props.interaction.handlerMs)}</dd>
        <dt>root writes</dt>
        <dd>{props.interaction.writes}</dd>
        <dt>re-runs caused</dt>
        <dd>{props.interaction.runs}</dd>
        <dt>user waited</dt>
        <dd>
          {props.interaction.settledMs === undefined
            ? "still settling"
            : props.interaction.outcome === "idle"
              ? // A dispatch that wrote nothing has nothing to wait for — the
                // wait, if there was one, belongs to the hold it never joined.
                "nothing to wait for — this click wrote no state"
              : `${round(props.interaction.settledMs)} (${props.interaction.outcome})`}
        </dd>
      </dl>
    </li>
  );
}

/** Diagnostics + attribution records the channels routed to one scenario. */
export function EvidencePanel(props: {
  feed: FeedId;
  /** Extra measurements the scenario itself recorded (run counts, timings). */
  children?: JSX.Element;
  showInteractions?: boolean;
  showHolds?: boolean;
}): JSX.Element {
  return (
    <Excluded>
      {() => {
        const feed = scenarioFeed(props.feed);
        return (
          <div class="evidence">
            {props.children}
            <Show
              when={feed().diagnostics.length}
              fallback={<p class="quiet">No diagnostics on this channel yet.</p>}
            >
              <ul class="events">
                <For each={feed().diagnostics}>{event => <DiagnosticRow event={event} />}</For>
              </ul>
            </Show>
            <Show when={props.showInteractions && feed().interactions.length}>
              <ul class="events">
                <For each={feed().interactions.slice(-2)}>
                  {interaction => <InteractionRow interaction={interaction} />}
                </For>
              </ul>
            </Show>
            <Show when={props.showHolds && feed().holds.length}>
              <ul class="events">
                <For each={feed().holds.slice(-2)}>{hold => <HoldRow hold={hold} />}</For>
              </ul>
            </Show>
          </div>
        );
      }}
    </Excluded>
  );
}
