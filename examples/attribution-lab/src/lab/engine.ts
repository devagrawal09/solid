/**
 * The lab's instrumentation seam.
 *
 * Two dev channels feed one panel:
 *
 *   `OBSERVE.diagnostics.subscribe` — the always-open structured channel. It
 *   outlives `attribution.disable()`, so it is subscribed exactly once, at
 *   module scope.
 *
 *   `attribution.subscribe` — the "why did this run" record stream. Every
 *   subscription is dropped by `disable()`, so `arm()` re-subscribes each time.
 *
 * Both listeners are invoked SYNCHRONOUSLY from inside the reactive flush that
 * produced the record — see the contract on `Attribution.subscribe` in
 * `packages/signals/src/core/attribution.ts`: *"delivered synchronously from
 * the engine, so a listener must not write signals"*. A listener that wrote
 * reactive state would mutate the graph mid-flush: the observer changing what
 * it observes, with re-runs of its own attributed to the app's writes.
 *
 * So neither listener here touches reactive state. They append to a plain
 * array and schedule ONE microtask that commits the whole batch after the
 * flush has unwound. The commit runs under a root handed to `OBSERVE.exclude`,
 * which marks the panel as the observer's own — without it the report's own
 * writes and re-runs would appear in the tables it is rendering.
 */
import { OBSERVE, createRoot, createSignal, getOwner, runWithOwner, type Owner } from "solid-js";
import { attribution, type ChangeOrigin, type RerunEvent } from "solid-js/attribution";

export type Variant = "broken" | "fixed";

export interface DiagLine {
  id: number;
  kind: "diag";
  severity: string;
  code: string;
  nodeName: string;
  text: string;
}

export interface RunLine {
  id: number;
  kind: "run";
  nodeName: string;
  /** `attribution.format()` with run counters, timings and write sequence numbers removed. */
  text: string;
  /** Real self-time, kept out of `text` so `text` stays byte-comparable. */
  ms: number;
  /** Provenance of the root write behind this run, pretty-printed. */
  origin: string;
  /**
   * True when that root write carries no imperative frame at all — the
   * `{ kind: "external" }` stamp. In scenario 4 this is the entire finding: a
   * write that escaped its action's transaction after an `await`.
   */
  external: boolean;
}

export type Line = DiagLine | RunLine;

/** `OBSERVE` is `undefined` on the production tier — the whole lab is dev-only. */
export const OBSERVABLE = OBSERVE !== undefined;

/**
 * Strip everything that differs between two otherwise identical runs: the
 * per-node run counter, wall times, and the global write-sequence numbers.
 * What is left is the causal shape — which is what the panel shows and what
 * the tests compare, so the evidence on screen is the evidence under test.
 */
export function stripVolatile(text: string): string {
  return text
    .replace(/\(run \d+, [\d.]+ms/g, "(run n")
    .replace(/ \(#\d+\)/g, "")
    .replace(/\b\d+(?:\.\d+)?ms\b/g, "…ms");
}

/** The root write behind a re-run: unwrap `derived` causes down to the signal. */
function rootOrigin(event: RerunEvent): ChangeOrigin | undefined {
  let cause = event.causes[0];
  while (cause !== undefined && cause.kind === "derived" && cause.causes && cause.causes.length) {
    cause = cause.causes[0];
  }
  return cause === undefined ? undefined : cause.origin;
}

// --- the panel's own state, excluded from what it observes ---------------

let reportOwner: Owner | null = null;
const [lines, setLines] = createRoot(() => {
  const owner = getOwner();
  reportOwner = owner;
  // `exclude` is the documented way for a consumer that renders inside the
  // app it watches to keep its own nodes out of the findings, and its recipe
  // is: mark the root as it is created, then perform writes under that owner
  // with `runWithOwner` so the writer's context is excluded too.
  if (owner !== null && OBSERVE !== undefined) OBSERVE.exclude(owner);
  // …which means the writes below happen with an owner on the stack, and
  // `setSignal`'s dev guard rejects that outright (REACTIVE_WRITE_IN_OWNED_SCOPE)
  // unless the signal opts in. `ownedWrite` is that opt-in, and it is exactly
  // what it is for: this signal is only ever written from the panel's own
  // deferred commit, never from a computation.
  return createSignal<Line[]>([], { name: "reportLines", ownedWrite: true });
});

export { lines };

let nextId = 0;
let pending: Line[] = [];
let scheduled = false;

function commit(): void {
  scheduled = false;
  if (pending.length === 0) return;
  const batch = pending;
  pending = [];
  runWithOwner(reportOwner, () => setLines(prev => [...prev, ...batch]));
}

/**
 * Buffer a line from a synchronous channel listener. Nothing reactive happens
 * here; the commit is deferred so the flush that produced the record is never
 * re-entered.
 */
function push(line: Omit<DiagLine, "id"> | Omit<RunLine, "id">): void {
  pending.push({ ...line, id: nextId++ } as Line);
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(commit);
}

// The structured diagnostics channel survives `attribution.disable()`, so this
// subscription is made exactly once, at module scope.
if (OBSERVE !== undefined) {
  OBSERVE.diagnostics.subscribe(event =>
    push({
      kind: "diag",
      severity: event.severity,
      code: event.code,
      nodeName: event.nodeName ?? "",
      text: stripVolatile(event.message)
    })
  );
}

/**
 * Posture shared by the app and the tests: every detector that is not the
 * subject of a card is switched off, so "no diagnostics" in a Fixed variant is
 * a statement about the defect rather than about the machine's mood.
 */
export const BASE_OPTIONS = {
  log: false,
  hotRuns: false,
  hotTime: false,
  wideDeps: false,
  unstableMemos: false,
  wideWrites: false,
  holds: false,
  longHolds: false,
  waterfalls: false
} as const;

export interface ArmOptions {
  /** Re-run lines are rendered only for these scope names — the card's readers. */
  watch?: readonly string[];
  /** Scenario 3 turns the waterfall detector back on with its own gate. */
  waterfalls?: { minFlightMs: number } | false;
}

/**
 * Re-arm the engine for a card.
 *
 * `disable()` first, always: it is what clears the once-per-key verdict
 * ledgers (`reportedCycles`, `relays`) so flipping Broken → Fixed → Broken
 * re-reports instead of going quiet on the second visit, and it is what drops
 * the previous card's `attribution.subscribe` listener.
 */
export function arm(options: ArmOptions = {}): void {
  if (OBSERVE === undefined) return;
  attribution.disable();
  pending = [];
  runWithOwner(reportOwner, () => setLines([]));
  attribution.enable({ ...BASE_OPTIONS, waterfalls: options.waterfalls ?? false });
  const watch = new Set(options.watch ?? []);
  attribution.subscribe((event: RerunEvent) => {
    if (!watch.has(event.nodeName)) return;
    const origin = rootOrigin(event);
    push({
      kind: "run",
      nodeName: event.nodeName,
      text: stripVolatile(attribution.format(event)),
      ms: event.selfMs,
      origin: origin === undefined ? "no tracked cause" : attribution.formatOrigin(origin),
      external: origin === undefined || origin.kind === "external"
    });
  });
}

/** Tear the engine down — used when the lab unmounts. */
export function disarm(): void {
  if (OBSERVE === undefined) return;
  attribution.disable();
  pending = [];
  runWithOwner(reportOwner, () => setLines([]));
}
