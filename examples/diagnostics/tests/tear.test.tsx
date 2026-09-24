/**
 * Scenario 1 — the relayed-state tear.
 *
 * The defect is a schedule, not a value, so the assertions are about the
 * runtime's verdict (`EFFECT_RELAY_TEAR`) and about how many times the reader
 * ran for one keystroke — both facts only the runtime can supply.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/web";
import { captureArtifact, expectDiagnostic, expectNoDiagnostics } from "@solidjs/diagnostics";
import { ResultsPanel } from "../src/scenarios/tear/ResultsPanel";
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
  dispose = render(() => <ResultsPanel broken={broken} />, host);
  return host;
}

const summaryRuns = (artifact: { attribution: { reruns: { nodeName: string }[] } | null }) =>
  artifact.attribution!.reruns.filter(rerun => rerun.nodeName === "tear:summary");

describe("relayed derived state", () => {
  it("reports EFFECT_RELAY_TEAR and paints two frames for one keystroke", async () => {
    const host = mount(true);
    const frames = () => [...host.querySelectorAll(".frames li")].map(li => li.textContent);

    const { artifact } = await captureArtifact(
      () => {
        typeInto($<HTMLInputElement>(host, "#tear-query"), "b");
      },
      { scenario: "tear/broken", attribution: attributionOptions }
    );

    expectDiagnostic(artifact, "EFFECT_RELAY_TEAR");
    const tear = artifact.diagnostics.find(event => event.code === "EFFECT_RELAY_TEAR")!;
    expect(tear.data).toMatchObject({
      victim: "tear:summary",
      root: "tear:query",
      relay: "tear:syncMatches",
      wrote: "tear:matches"
    });

    // The tear itself: one keystroke, two runs of the reader, and the first
    // of them paired the new query with the previous matches.
    expect(summaryRuns(artifact)).toHaveLength(2);
    expect(frames().slice(-2)).toEqual(["“b” → 8 parts", "“b” → 4 parts"]);
  });

  it("stays quiet — and runs once — when the value is derived", async () => {
    const host = mount(false);
    const frames = () => [...host.querySelectorAll(".frames li")].map(li => li.textContent);

    const { artifact } = await captureArtifact(
      () => {
        typeInto($<HTMLInputElement>(host, "#tear-query"), "b");
      },
      { scenario: "tear/fixed", attribution: attributionOptions }
    );

    expectNoDiagnostics(artifact);
    expect(summaryRuns(artifact)).toHaveLength(1);
    expect(frames().slice(-1)).toEqual(["“b” → 4 parts"]);
  });
});
