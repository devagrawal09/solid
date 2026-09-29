/**
 * Scenario 1. The claim: clamping a signal from an effect that reads it costs
 * a second flush and paints a state the app considers impossible — and the
 * runtime says so, from the cause chain, with no annotation from us.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureArtifact } from "@solidjs/diagnostics";
import type { RerunEvent } from "solid-js/attribution";
import { Pager } from "../src/scenarios/clamp/Pager";
import type { Variant } from "../src/lab/engine";
import { BASE_OPTIONS, click, codesOf, items, mount, recordRuns } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

interface Driven {
  artifact: Awaited<ReturnType<typeof captureArtifact>>["artifact"];
  /** Frames `pageLabel` painted for the page-size change alone. */
  frames: string[];
  /** `pageLabel` runs caused by the page-size change alone. */
  labelRuns: RerunEvent[];
}

async function drive(variant: Variant): Promise<Driven> {
  let frames: string[] = [];
  let labelRuns: RerunEvent[] = [];
  const { artifact } = await captureArtifact(
    () => {
      const runs = recordRuns();
      const mounted = mount(() => <Pager variant={variant} />);

      // Setup: walk to the last page at 10 per page (page 6 of 6).
      for (let i = 0; i < 5; i++) click(mounted, "#next");
      expect(mounted.text("#page-label")).toBe("Page 6 of 6");
      const framesBefore = mounted.container.querySelectorAll("#frames li").length;
      const runsBefore = runs.length;

      // The story: 57 items at 25 per page is 3 pages. Page 6 is gone.
      click(mounted, "#size-25");

      frames = items(mounted, "#frames").slice(framesBefore);
      labelRuns = runs.slice(runsBefore).filter(run => run.nodeName === "pageLabel");
    },
    { scenario: `clamp:${variant}`, attribution: BASE_OPTIONS }
  );
  return { artifact, frames, labelRuns };
}

describe("scenario 1 — EFFECT_WRITES_OWN_SOURCE", () => {
  it("broken: the clamp costs a second flush and paints an impossible page", async () => {
    const { artifact, frames, labelRuns } = await drive("broken");

    expect(artifact).toHaveDiagnostic("EFFECT_WRITES_OWN_SOURCE", { count: 1 });

    const cycle = artifact.diagnostics.find(e => e.code === "EFFECT_WRITES_OWN_SOURCE")!;
    expect(cycle.severity).toBe("warn");
    expect(cycle.kind).toBe("perf");
    expect(cycle.nodeName).toBe("clampPage");
    expect(cycle.message).toContain(
      'effect "clampPage" re-ran because of its own write: it wrote "page" (6 → 3)'
    );
    expect(cycle.data).toMatchObject({
      effects: ["clampPage"],
      // Two flushes to settle one change — the cost, stated as a number.
      flushes: 2,
      writes: [{ effect: "clampPage", kind: "write", name: "page", prev: "6", value: "3" }]
    });

    // The harm, on screen: one user action, two painted frames, the first of
    // which shows a page that does not exist.
    expect(frames).toEqual(["Page 6 of 3", "Page 3 of 3"]);
    expect(labelRuns).toHaveLength(2);

    // The same defect also tears every reader of both `page` and `pageCount`,
    // and the engine reports that separately. Pinning the full set here keeps
    // the card's evidence honest about what it shows.
    expect(codesOf(artifact.diagnostics)).toEqual([
      "EFFECT_RELAY_TEAR",
      "EFFECT_WRITES_OWN_SOURCE"
    ]);
  });

  it("fixed: deriving the page settles in one flush with nothing to report", async () => {
    const { artifact, frames, labelRuns } = await drive("fixed");

    expect(artifact).toHaveNoDiagnostics();
    expect(frames).toEqual(["Page 3 of 3"]);
    expect(labelRuns).toHaveLength(1);

    // No `clampPage` exists to run at all.
    const names = new Set(artifact.attribution!.reruns.map(run => run.nodeName));
    expect(names.has("clampPage")).toBe(false);
  });
});
