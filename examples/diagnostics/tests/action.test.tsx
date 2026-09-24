/**
 * Scenario 4 — the interaction that goes wrong asynchronously.
 *
 * Two clicks inside one round trip leave the cart holding one item. The value
 * assertion proves the bug; the attribution assertions prove the runtime can
 * tell you *who* did it without a breakpoint: the UI event that started it,
 * that an action opened the wait, and every root write staged behind it with
 * its before/after values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/web";
import { captureArtifact, expectDiagnostic } from "@solidjs/diagnostics";
import { QuantityStepper } from "../src/scenarios/action/QuantityStepper";
import { reset, serverQuantity, setLatency } from "../src/scenarios/action/cart-api";
import { $, attributionOptions, click, mountPoint, until } from "./helpers";

let dispose: (() => void) | undefined;

beforeEach(() => {
  reset();
  setLatency(150);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  setLatency(700);
  vi.restoreAllMocks();
});

function mount(broken: boolean) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const host = mountPoint();
  dispose = render(() => <QuantityStepper broken={broken} />, host);
  return host;
}

const onScreen = (host: ParentNode) => $(host, ".quantity").textContent;
const saves = (host: ParentNode) => host.querySelectorAll(".frames li").length;

describe("two clicks inside one round trip", () => {
  it("loses an update, and the channel names the event, the action and the writes", async () => {
    const host = mount(true);

    const { artifact } = await captureArtifact(
      async () => {
        click($(host, "#action-inc"));
        click($(host, "#action-inc"));
        await until(() => saves(host) >= 2, "both saves to settle");
      },
      { scenario: "action/broken", attribution: attributionOptions }
    );

    // The weird state: two clicks, one item — on screen and on the server.
    expect(onScreen(host)).toBe("1");
    expect(serverQuantity()).toBe(1);

    // …and the screen said nothing at all while it happened.
    expectDiagnostic(artifact, "SILENT_HOLD");

    const holds = artifact.attribution!.holds;
    expect(holds).toHaveLength(1);
    const [hold] = holds;
    // The UI event that started it…
    expect(hold.interaction?.name).toBe("click");
    expect(hold.interaction?.target).toContain("button#action-inc");
    // …that an action opened the wait…
    expect(hold.action).toBe(true);
    // …and every root write staged behind it, with before/after values. Two
    // clicks, one staged write of `1`: the lost update, visible as a record.
    expect(hold.heldWrites.map(write => ({ ...write, origin: undefined }))).toEqual([
      { name: "action:quantity", prev: "0", value: "1", origin: undefined }
    ]);
    expect(hold.heldWrites[0].origin?.kind).toBe("action");
    // Nothing on screen answered for the whole wait.
    expect(hold.acknowledgements).toEqual([]);
    expect(hold.paintedDuringHold).toBe(0);

    // The same frames fold into the ranked feedback table: what the person
    // did, and how much of the wait was silent.
    const [ranked] = artifact.attribution!.feedback.interactions;
    expect(ranked.interaction).toContain("click on button#action-inc");
    expect(ranked.holds).toBe(1);
    expect(ranked.silentMs).toBeGreaterThan(0);
    // Dispatches fold by dispatch time, so two clicks in the same instant can
    // read as one frame; the lost update above is the load-bearing assertion.
    expect(ranked.dispatches).toBeGreaterThanOrEqual(1);
  });

  it("composes both clicks and acknowledges the wait once the action is written correctly", async () => {
    const host = mount(false);

    const { artifact } = await captureArtifact(
      async () => {
        click($(host, "#action-inc"));
        click($(host, "#action-inc"));
        await until(() => saves(host) >= 2, "both saves to settle");
      },
      { scenario: "action/fixed", attribution: attributionOptions }
    );

    expect(onScreen(host)).toBe("2");
    expect(serverQuantity()).toBe(2);

    expect(artifact.diagnostics).toEqual([]);
    const holds = artifact.attribution!.holds;
    expect(holds.length).toBeGreaterThan(0);
    for (const hold of holds) {
      // The screen answered: the optimistic value showed the expected result
      // while the save was in flight, and `isPending` marked it as such.
      expect(hold.acknowledgements.map(ack => ack.kind)).toContain("optimistic");
      expect(hold.paintedDuringHold).toBeGreaterThan(0);
    }
    const [ranked] = artifact.attribution!.feedback.interactions;
    expect(ranked.dispatches).toBeGreaterThanOrEqual(1);
    expect(ranked.silentMs).toBe(0);
  });
});
