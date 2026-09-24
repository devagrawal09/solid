/**
 * Test-side plumbing shared by the four scenario suites.
 *
 * The suites drive the real components through real DOM events in jsdom, so
 * the same channels the browser demo reads are the ones under assertion —
 * including the web runtime's interaction stamping, which only happens on
 * delegated events.
 */
import { flush } from "solid-js";
import type { AttributionOptions } from "@solidjs/diagnostics";

/** Capture posture for every scenario: short gates to match the fake latency. */
export const attributionOptions: AttributionOptions = {
  log: false,
  hotRuns: false,
  hotTime: false,
  waterfalls: { minFlightMs: 20 },
  holds: { infoMs: 50, warnMs: 100 },
  longHolds: { infoMs: 400, warnMs: 900 }
};

export function mountPoint(): HTMLDivElement {
  const host = document.createElement("div");
  document.body.append(host);
  return host;
}

export function typeInto(input: HTMLInputElement, text: string): void {
  for (const character of text) {
    input.value += character;
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    flush();
  }
}

export function click(target: Element): void {
  target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  flush();
}

export function $<T extends Element>(host: ParentNode, selector: string): T {
  const found = host.querySelector<T>(selector);
  if (!found) throw new Error(`no element matched ${selector}`);
  return found;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Deadline-poll instead of sleeping a fixed interval: the fake services use
 * real timers, and a fixed wait races them on a loaded machine.
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
