/**
 * Scenario 2. The claim: keeping derived state in sync with an effect makes
 * one keystroke run every reader of both values twice, and the first of those
 * frames is inconsistent. The verdict starts advisory and escalates once the
 * same relay has torn three times.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureArtifact } from "@solidjs/diagnostics";
import { Results } from "../src/scenarios/relay/Results";
import type { Variant } from "../src/lab/engine";
import { BASE_OPTIONS, click, items, mount, type as typeInto } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** Each query hides the row selected before it, so each one earns a tear. */
const QUERIES = ["li", "ken", "den"];

async function drive(variant: Variant) {
  /** Frames the detail pane painted, grouped by keystroke. */
  const framesPerQuery: string[][] = [];
  const { artifact } = await captureArtifact(
    () => {
      const mounted = mount(() => <Results variant={variant} />);

      // A real click, and a real (non-effect) writer of `selectedId` — which
      // is what makes `soleWriter: false` in the verdict below a fact about
      // this app rather than an artefact of the fixture.
      click(mounted, "#row-grace");
      expect(mounted.text("#detail")).toBe("∅ → grace");

      let seen = items(mounted, "#detail-frames").length;
      for (const query of QUERIES) {
        typeInto(mounted, "input[name=q]", query);
        const all = items(mounted, "#detail-frames");
        framesPerQuery.push(all.slice(seen));
        seen = all.length;
      }
    },
    { scenario: `relay:${variant}`, attribution: BASE_OPTIONS }
  );
  const tears = artifact.diagnostics.filter(event => event.code === "EFFECT_RELAY_TEAR");
  return { artifact, framesPerQuery, tears };
}

describe("scenario 2 — EFFECT_RELAY_TEAR", () => {
  it("broken: one keystroke paints a detail pane for a row that is no longer listed", async () => {
    const { artifact, framesPerQuery, tears } = await drive("broken");

    // The harm: two frames per keystroke, the first against stale state.
    expect(framesPerQuery).toEqual([
      ["li → grace", "li → linus"],
      ["ken → linus", "ken → ken"],
      ["den → ken", "den → dennis"]
    ]);

    expect(artifact).toHaveDiagnostic("EFFECT_RELAY_TEAR");
    // Advisory on first sight — a DOM-measurement effect may tear for good
    // reason — then `warn` once the same relay has torn three times.
    expect(tears.map(event => event.severity)).toEqual(["info", "warn"]);
    expect(tears[0].nodeName).toBe("detailPane");
    expect(tears[0].message).toContain('effect "detailPane" ran twice for one write of "query"');
    expect(tears[0].message).toContain('effect "syncSelection" relayed it by writing "selectedId"');
    expect(tears[0].data).toEqual({
      victim: "detailPane",
      root: "query",
      relay: "syncSelection",
      wrote: "selectedId",
      // Not an identity copy and not the only writer: the engine earns this
      // verdict from the cause chain, not from a shape heuristic.
      copy: false,
      passthrough: null,
      soleWriter: false,
      occurrences: 1
    });
    expect(tears[1].message).toContain("(3 times so far)");

    expect(artifact.diagnostics.every(event => event.code === "EFFECT_RELAY_TEAR")).toBe(true);
  });

  it("fixed: a memo gives every reader the new selection in the same flush", async () => {
    const { artifact, framesPerQuery } = await drive("fixed");

    expect(framesPerQuery).toEqual([["li → linus"], ["ken → ken"], ["den → dennis"]]);
    expect(artifact).toHaveNoDiagnostics();

    // One `detailPane` run per keystroke, and no relay to run at all.
    const names = artifact.attribution!.reruns.map(run => run.nodeName);
    expect(names.includes("syncSelection")).toBe(false);
  });
});
