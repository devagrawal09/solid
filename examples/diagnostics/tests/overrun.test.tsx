/**
 * Scenario 2 — the effect that runs too many times.
 *
 * "Too many" is not a matter of taste here: the state being typed into cannot
 * change the summary, so the correct number of runs for five keystrokes is
 * zero. The runtime supplies both the verdict (`UNSTABLE_MEMO_OUTPUT`) and the
 * per-run causality that names the input responsible.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/web";
import {
  captureArtifact,
  expectDiagnostic,
  expectNoDiagnostics,
  expectRerunBudget
} from "@solidjs/diagnostics";
import { CheckoutSummary } from "../src/scenarios/overrun/CheckoutSummary";
import { $, attributionOptions, mountPoint, typeInto } from "./helpers";

let dispose: (() => void) | undefined;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function mount(broken: boolean) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const host = mountPoint();
  dispose = render(() => <CheckoutSummary broken={broken} />, host);
  return host;
}

describe("a summary memo that reads more than it needs", () => {
  it("re-runs the shipping effect on every keystroke and is reported for it", async () => {
    const host = mount(true);

    const { artifact } = await captureArtifact(
      () => {
        typeInto($<HTMLInputElement>(host, "#overrun-note"), "happy birthday");
      },
      { scenario: "overrun/broken", attribution: attributionOptions }
    );

    expectDiagnostic(artifact, "UNSTABLE_MEMO_OUTPUT");
    const unstable = artifact.diagnostics.find(e => e.code === "UNSTABLE_MEMO_OUTPUT")!;
    expect(unstable.nodeName).toBe("overrun:summary");

    const shippingRuns = artifact.attribution!.reruns.filter(
      rerun => rerun.nodeName === "overrun:shipping"
    );
    // One run per keystroke, none of which could change a count or a total.
    expect(shippingRuns.length).toBe("happy birthday".length);
    // …and the engine names what caused each one.
    expect(
      shippingRuns
        .at(-1)!
        .causes.map(cause => cause.name)
        .join()
    ).toContain("overrun:summary");
  });

  it("does not run at all when the memo depends on the lines alone", async () => {
    const host = mount(false);

    const { artifact } = await captureArtifact(
      () => {
        typeInto($<HTMLInputElement>(host, "#overrun-note"), "happy birthday");
      },
      { scenario: "overrun/fixed", attribution: attributionOptions }
    );

    expectNoDiagnostics(artifact);
    expectRerunBudget(artifact, 0, { scope: "overrun:shipping" });
    expectRerunBudget(artifact, 0, { scope: "overrun:summary" });
  });

  it("still runs the effect when the cart really changes", async () => {
    const host = mount(false);

    const { artifact } = await captureArtifact(
      () => {
        $<HTMLButtonElement>(host, "#overrun-add").click();
      },
      { scenario: "overrun/fixed-add", attribution: attributionOptions }
    );

    expectNoDiagnostics(artifact);
    expectRerunBudget(artifact, 1, { scope: "overrun:shipping" });
    expect(
      artifact.attribution!.reruns.filter(rerun => rerun.nodeName === "overrun:shipping")
    ).toHaveLength(1);
  });
});
