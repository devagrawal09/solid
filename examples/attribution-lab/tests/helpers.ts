/**
 * Shared test rig.
 *
 * Everything here mounts the app's real components into a real (jsdom)
 * document and drives them with real events, so the tests assert the same
 * behaviour the browser shows. Nothing stubs the reactive system, and nothing
 * uses fake timers: the async cards are polled to a deadline (the recipe the
 * signals suite settled on after three CI flakes on fixed sleeps — see
 * `packages/signals/tests/attribution-waterfall-eval.test.ts`).
 */
import { afterEach } from "vitest";
import { flush } from "solid-js";
import { render } from "@solidjs/web";
import { attribution, type RerunEvent } from "solid-js/attribution";
import type { AttributionOptions } from "@solidjs/diagnostics";

/** The posture `src/lab/engine.ts` arms with — every unrelated detector off. */
export const BASE_OPTIONS: AttributionOptions = {
  log: false,
  hotRuns: false,
  hotTime: false,
  wideDeps: false,
  unstableMemos: false,
  wideWrites: false,
  holds: false,
  longHolds: false,
  waterfalls: false
};

export interface Mounted {
  container: HTMLElement;
  dispose(): void;
  /** `#id` / any CSS selector, asserted non-null so a typo fails loudly. */
  find<T extends HTMLElement = HTMLElement>(selector: string): T;
  text(selector: string): string;
}

const live: Mounted[] = [];

// Torn down AFTER the capture that mounted it: disposal inside a capture would
// race the timers an async card still has in the air.
afterEach(() => {
  while (live.length > 0) live.pop()!.dispose();
});

export function mount(component: () => unknown): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const dispose = render(component as never, container);
  flush();
  const find = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const el = container.querySelector<T>(selector);
    if (el === null) throw new Error(`no element matched ${selector}`);
    return el;
  };
  const mounted: Mounted = {
    container,
    find,
    text: selector => find(selector).textContent ?? "",
    dispose: () => {
      dispose();
      flush();
      container.remove();
    }
  };
  live.push(mounted);
  return mounted;
}

/** Text of every `<li>` under `selector`, in document order. */
export function items(mounted: Mounted, selector: string): string[] {
  return [...mounted.container.querySelectorAll(`${selector} li`)].map(li => li.textContent ?? "");
}

/** A real delegated click — this is what stamps the interaction. */
export function click(mounted: Mounted, selector: string): void {
  mounted.find(selector).dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flush();
}

/** A real delegated `input` event, value first. */
export function type(mounted: Mounted, selector: string, value: string): void {
  const input = mounted.find<HTMLInputElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  flush();
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Deadline-poll `condition`, flushing between attempts. Never sleep a fixed
 * interval for an async landing: on a loaded runner that is a coin toss.
 */
export async function until(condition: () => boolean, what: string, timeout = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    flush();
    if (condition()) return;
    if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
    await wait(5);
  }
}

/** One more settle turn after a positive landing, before asserting absence. */
export async function settle(): Promise<void> {
  await wait(10);
  flush();
}

/** Collect every re-run the engine reports for the duration of a capture. */
export function recordRuns(): RerunEvent[] {
  const runs: RerunEvent[] = [];
  attribution.subscribe(event => runs.push(event));
  return runs;
}

/** The root cause of the LAST run of `name`. */
export function lastCause(runs: readonly RerunEvent[], name: string) {
  const run = runs.filter(event => event.nodeName === name).at(-1);
  if (run === undefined) throw new Error(`no recorded run for scope "${name}"`);
  return run.causes[0];
}

/** The root cause of the FIRST run of `name` that had one. */
export function firstCause(runs: readonly RerunEvent[], name: string) {
  const run = runs.filter(event => event.nodeName === name && event.causes.length > 0)[0];
  if (run === undefined) throw new Error(`no caused run for scope "${name}"`);
  return run.causes[0];
}

export const codesOf = (events: readonly { code: string }[]): string[] =>
  [...new Set(events.map(event => event.code))].sort();
