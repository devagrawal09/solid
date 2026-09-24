/**
 * Scenario 4. The claim: `await` without a following `yield` silently ends an
 * action's transaction. Both variants finish in the same state and neither
 * emits a diagnostic — the only thing that separates them is provenance, and
 * the attribution record carries it all the way back to the real click.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureArtifact } from "@solidjs/diagnostics";
import { attribution, type InteractionEvent, type RerunEvent } from "solid-js/attribution";
import { Publisher, PUBLISH_WATCH } from "../src/scenarios/publish/Publisher";
import type { Variant } from "../src/lab/engine";
import {
  BASE_OPTIONS,
  click,
  firstCause,
  lastCause,
  mount,
  recordRuns,
  settle,
  until
} from "./helpers";

const LATENCY_MS = 10;
const CLICK_TARGET = 'button#publish "Publish 3 drafts"';

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function drive(variant: Variant) {
  let runs: RerunEvent[] = [];
  let interactions: InteractionEvent[] = [];
  let dom = { status: "", progress: "", published: "", skipped: "" };
  const { artifact } = await captureArtifact(
    async () => {
      runs = recordRuns();
      const mounted = mount(() => <Publisher variant={variant} latency={LATENCY_MS} />);

      // A real delegated click on a text-only button: this is what the web
      // runtime wraps in `withInteraction`.
      click(mounted, "#publish");
      await until(() => mounted.text("#status") === "done", "the action to finish");
      await settle();

      interactions = [...attribution.interactions()];
      dom = {
        status: mounted.text("#status"),
        progress: mounted.text("#progress"),
        published: mounted.text("#published"),
        skipped: mounted.text("#skipped")
      };
    },
    { scenario: `publish:${variant}`, attribution: BASE_OPTIONS }
  );
  return { artifact, runs, interactions, dom };
}

const END_STATE = {
  status: "done",
  progress: "3/3",
  published: "Draft A, Draft C",
  skipped: "Draft B"
};

const UNDER_THE_CLICK = {
  kind: "action",
  name: "publish",
  interaction: { kind: "interaction", name: "click", target: CLICK_TARGET }
};

describe("scenario 4 — provenance from a real click", () => {
  it("fixed: every reader's last run still traces to the click that started it", async () => {
    const { artifact, runs, interactions, dom } = await drive("fixed");

    expect(dom).toEqual(END_STATE);
    expect(artifact).toHaveNoDiagnostics();

    for (const name of PUBLISH_WATCH) {
      expect(lastCause(runs, name).origin, `last run of "${name}"`).toMatchObject(UNDER_THE_CLICK);
    }

    expect(interactions).toHaveLength(1);
    expect(interactions[0].name).toBe("click");
    expect(interactions[0].target).toBe(CLICK_TARGET);
    expect(interactions[0].writes).toBeGreaterThan(0);
    expect(interactions[0].runs).toBeGreaterThan(0);
  });

  it("broken: the same end state, but the click is lost after the first await", async () => {
    const { artifact, runs, interactions, dom } = await drive("broken");

    // Identical result — nothing here is "wrong" in the value sense.
    expect(dom).toEqual(END_STATE);
    expect(artifact).toHaveNoDiagnostics();

    // The synchronous first slice is still the action's, under the click.
    expect(firstCause(runs, "statusBadge").origin).toMatchObject(UNDER_THE_CLICK);

    // Everything after the first `await` resumed on a bare microtask with no
    // reactive frame on the stack: the writes escaped the transaction and the
    // trail from the click is gone.
    for (const name of PUBLISH_WATCH) {
      expect(lastCause(runs, name).origin, `last run of "${name}"`).toEqual({ kind: "external" });
    }
    // `progress` is only ever written after an await, so it never carries the
    // click at all.
    expect(firstCause(runs, "progressBar").origin).toEqual({ kind: "external" });

    // The click is still recorded — it just stops explaining anything.
    expect(interactions).toHaveLength(1);
    expect(interactions[0].target).toBe(CLICK_TARGET);
  });
});
