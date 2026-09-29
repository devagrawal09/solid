/**
 * Shell smoke test: the whole demo mounts, the live channel plumbing routes a
 * real diagnostic to the card that caused it, both modes rebuild their graphs,
 * and the observer's own UI stays out of the evidence it renders (the
 * "everything else" feed stays empty).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/web";
import { flush } from "solid-js";
import { App } from "../src/app";
import { setLatency } from "../src/scenarios/waterfall/api";
import { $, click, mountPoint, typeInto, until } from "./helpers";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  setLatency(220);
  vi.restoreAllMocks();
});

/** The channel drains into the UI on a microtask, off the reactive path. */
async function drain() {
  await Promise.resolve();
  await Promise.resolve();
  flush();
}

/** The diagnostic codes rendered in one card's evidence list. */
const cardCodes = (host: ParentNode, index: number) =>
  [...host.querySelectorAll(".grid > .card")[index].querySelectorAll(".event code")].map(
    code => code.textContent
  );

describe("the demo shell", () => {
  it("routes live diagnostics to the right card and switches modes", async () => {
    setLatency(40);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const host = mountPoint();
    dispose = render(() => <App />, host);

    expect(host.querySelectorAll(".grid > .card")).toHaveLength(4);
    expect($(host, "#tear-query")).toBeTruthy();
    expect($(host, "#overrun-note")).toBeTruthy();
    expect($(host, "#waterfall-load-1")).toBeTruthy();
    expect($(host, "#action-inc")).toBeTruthy();

    // Broken mode: one keystroke, two painted frames, one real diagnostic —
    // rendered in the card whose graph produced it.
    typeInto($<HTMLInputElement>(host, "#tear-query"), "b");
    await drain();
    expect(host.querySelectorAll(".frames li").length).toBeGreaterThanOrEqual(2);
    expect(cardCodes(host, 0)).toContain("EFFECT_RELAY_TEAR");

    // The demo's own UI is not part of the evidence.
    const other = [...host.querySelectorAll(".card")].at(-1)!;
    expect(other.textContent).toContain("No diagnostics on this channel yet.");

    // The waterfall card requests nothing until a story is picked, and the
    // chain it then shows is the one that click caused.
    const waterfallCard = () => host.querySelectorAll(".grid > .card")[2].textContent ?? "";
    expect(waterfallCard()).toContain("No sequential chains recorded.");
    click($(host, "#waterfall-load-1"));
    await until(() => waterfallCard().includes("waterfall:story →"), "the chain evidence");

    // Switching rebuilds every scenario graph from scratch and clears feeds.
    click($(host, "#mode-fixed"));
    await drain();
    expect(host.querySelectorAll(".grid > .card")).toHaveLength(4);
    expect(cardCodes(host, 0)).toEqual([]);
    // Measurements from the broken graph do not follow the mode switch.
    expect(waterfallCard()).toContain("No sequential chains recorded.");

    typeInto($<HTMLInputElement>(host, "#tear-query"), "b");
    await drain();
    expect([...host.querySelectorAll(".frames li")].map(li => li.textContent)).toContain(
      "“b” → 4 parts"
    );
    expect(cardCodes(host, 0)).toEqual([]);
  });
});
