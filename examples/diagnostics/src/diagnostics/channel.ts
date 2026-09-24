/**
 * The demo's window onto the two dev-mode channels Solid already ships:
 *
 * - `OBSERVE.diagnostics.subscribe()` — the structured diagnostic channel
 *   (stable codes, severity, owner path). Same events the console prints.
 * - `attribution.subscribe("hold" | "interaction" | "rerun", …)` — the
 *   attribution engine's records: what the user did, what it wrote, and what
 *   the screen was doing while it waited.
 *
 * Nothing here fabricates a finding. Every code, message and number rendered
 * by the demo arrives on one of those two channels.
 *
 * Two rules the engine imposes and this file obeys:
 *
 * 1. Channel listeners run synchronously from inside a recompute, so they may
 *    not write signals. Records are buffered and drained in a microtask.
 * 2. A consumer that renders inside the app it watches would otherwise report
 *    on itself. `OBSERVE.exclude(owner)` marks this store's root as the
 *    observer's own, and every write to it goes through `runWithOwner` so the
 *    writer's context is excluded too.
 */
import { OBSERVE, createRoot, createSignal, flush, getOwner, runWithOwner } from "solid-js";
import type { Accessor, DiagnosticEvent, HoldEvent, InteractionEvent } from "solid-js";
import { attribution } from "solid-js/attribution";

export type ScenarioId = "tear" | "overrun" | "waterfall" | "action";
export type FeedId = ScenarioId | "other";

export const SCENARIO_IDS: ScenarioId[] = ["tear", "overrun", "waterfall", "action"];
const FEED_IDS: FeedId[] = [...SCENARIO_IDS, "other"];

/**
 * Every reactive node a scenario creates is named `<id>:<what>` and every
 * control it renders carries `id="<id>-<what>"`, so a record can be routed to
 * the card that produced it by the names the engine already reports.
 */
export function nodeName(scenario: ScenarioId, what: string): string {
  return `${scenario}:${what}`;
}

export interface ScenarioFeed {
  diagnostics: DiagnosticEvent[];
  holds: HoldEvent[];
  interactions: InteractionEvent[];
}

const EMPTY: ScenarioFeed = { diagnostics: [], holds: [], interactions: [] };
const LIMIT = 12;

function route(text: string): FeedId {
  for (const id of SCENARIO_IDS) if (text.includes(`${id}:`) || text.includes(`${id}-`)) return id;
  return "other";
}

function describeHold(hold: HoldEvent): string {
  return [
    ...hold.heldWrites.map(write => write.name),
    ...hold.blockers,
    hold.interaction?.target ?? "",
    hold.origin?.name ?? ""
  ].join(" ");
}

const feeds = createRoot(() => {
  // The observer's own subtree: neither channel reports on what follows.
  if (OBSERVE) OBSERVE.exclude(getOwner()!);
  const owner = getOwner()!;
  // Plain records are the source of truth; the signals are their published
  // view. Several records can arrive in one batch, and a signal read between
  // two writes of the same batch still answers with the committed value — so
  // folding batch entries through the signal would drop all but the last.
  const state = {} as Record<FeedId, ScenarioFeed>;
  const signals = {} as Record<FeedId, [Accessor<ScenarioFeed>, (next: ScenarioFeed) => void]>;
  for (const id of FEED_IDS) {
    state[id] = EMPTY;
    // `ownedWrite`: observer-internal state, written from wherever a record
    // happens to arrive — the guard that keeps app state out of owned scopes
    // has nothing to protect here.
    const [feed, setFeed] = createSignal<ScenarioFeed>(EMPTY, {
      name: `observer:${id}`,
      ownedWrite: true
    });
    signals[id] = [feed, setFeed];
  }
  return {
    read: (id: FeedId) => signals[id][0],
    /** Writes run under the excluded owner, so the writer's context is excluded too. */
    update(id: FeedId, patch: (feed: ScenarioFeed) => ScenarioFeed) {
      state[id] = patch(state[id]);
      runWithOwner(owner, () => signals[id][1](state[id]));
    },
    clear(id: FeedId) {
      state[id] = EMPTY;
      runWithOwner(owner, () => signals[id][1](EMPTY));
    }
  };
});

const tail = <T>(list: T[], next: T): T[] => [...list, next].slice(-LIMIT);

let queued: (() => void)[] = [];
function enqueue(work: () => void) {
  queued.push(work);
  if (queued.length > 1) return;
  // Listeners fire from inside a recompute; land the write in a later task.
  queueMicrotask(() => {
    const batch = queued;
    queued = [];
    for (const item of batch) item();
    // The drain runs outside the graph, so committing here keeps the panels
    // one microtask behind the channel instead of one scheduler turn.
    flush();
  });
}

let started = false;

/**
 * Open both channels for the page. Returns `false` on a production build,
 * where `OBSERVE` is undefined and there is nothing to listen to.
 */
export function startDiagnostics(): boolean {
  if (started) return true;
  if (!OBSERVE) return false;
  started = true;

  attribution.enable({
    // The artifact/UI is the output, not the console. Flip to `true` to see
    // the engine's own `[why-run]` groups while presenting.
    log: false,
    // The demo's fake latency is deliberately short; keep the waterfall gate
    // below it so a real chain is still judged.
    waterfalls: { minFlightMs: 40 },
    holds: { infoMs: 100, warnMs: 200 },
    longHolds: { infoMs: 500, warnMs: 1000 }
  });

  OBSERVE.diagnostics.subscribe(event => {
    const id = route(
      `${event.nodeName ?? ""} ${event.ownerName ?? ""} ${(event.ownerPath ?? []).join(" ")} ${event.message}`
    );
    enqueue(() =>
      feeds.update(id, feed => ({ ...feed, diagnostics: tail(feed.diagnostics, event) }))
    );
  });

  attribution.subscribe("hold", hold => {
    const id = route(describeHold(hold));
    enqueue(() => feeds.update(id, feed => ({ ...feed, holds: tail(feed.holds, hold) })));
  });

  attribution.subscribe("interaction", interaction => {
    const id = route(interaction.target ?? "");
    enqueue(() =>
      feeds.update(id, feed => ({ ...feed, interactions: tail(feed.interactions, interaction) }))
    );
  });

  return true;
}

export function scenarioFeed(id: FeedId): Accessor<ScenarioFeed> {
  return feeds.read(id);
}

export function clearFeed(id: FeedId): void {
  feeds.clear(id);
}

/**
 * A mark in the engine's chain log. A scenario takes one when it mounts and
 * passes it back to `scenarioWaterfalls`, so a rebuilt graph never shows the
 * previous mode's chains as its own.
 */
export function waterfallCursor(): number {
  return attribution.waterfalls().length;
}

/** Graph-provable sequential flight chains, filtered to one scenario. */
export function scenarioWaterfalls(id: ScenarioId, since = 0) {
  const chains = attribution.waterfalls();
  return chains
    .slice(Math.min(since, chains.length))
    .filter(chain => chain.chain.some(link => route(link.name) === id));
}

/** Re-run history for one named scope — `attribution.history()`, filtered. */
export function scenarioReruns(name: string) {
  return attribution.history().filter(event => event.nodeName === name);
}
