/**
 * Scenario 3. The claim: three memos that each need an id the previous
 * response carried are three round trips, the runtime can prove it from the
 * cause chain, and composing them into one scope removes the chain entirely.
 *
 * Real timers throughout — deadline-polled, never slept at (see
 * `helpers.until`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureArtifact } from "@solidjs/diagnostics";
import { attribution } from "solid-js/attribution";
import { OrgPage } from "../src/scenarios/waterfall/OrgPage";
import type { Variant } from "../src/lab/engine";
import { BASE_OPTIONS, click, mount, settle, until } from "./helpers";

const LATENCY_MS = 15;

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

async function drive(variant: Variant) {
  let chains: string[][] = [];
  let lead = "";
  let team = "";
  const { artifact } = await captureArtifact(
    async () => {
      const mounted = mount(() => <OrgPage variant={variant} latency={LATENCY_MS} />);
      click(mounted, "#load-org");
      await until(
        () => mounted.container.querySelector("#lead-name") !== null,
        "the page to reveal"
      );
      // One more settle turn so a late chain would have been recorded before
      // the negative assertions below look for its absence.
      await settle();
      // `waterfalls()` is read INSIDE the capture: `captureArtifact` disables
      // the engine on the way out, and the aggregates reset with it.
      chains = attribution.waterfalls().map(record => record.chain.map(link => link.name));
      lead = mounted.text("#lead-name");
      team = mounted.text("#team-name");
    },
    {
      scenario: `waterfall:${variant}`,
      attribution: { ...BASE_OPTIONS, waterfalls: { minFlightMs: 5 } }
    }
  );
  const found = artifact.diagnostics.filter(event => event.code === "ASYNC_WATERFALL");
  return { artifact, chains, lead, team, found };
}

describe("scenario 3 — ASYNC_WATERFALL", () => {
  it("broken: the chain is proven, named end to end, and escalates at depth 3", async () => {
    const { chains, lead, team, found } = await drive("broken");

    expect(chains).toContainEqual(["org", "team", "lead"]);

    // Depth 2 is advisory (an intrinsic dependency, or an unmarked preload);
    // depth 3 that survived the origin test earns the console.
    expect(found.map(event => event.severity)).toEqual(["info", "warn"]);
    const worst = found.at(-1)!;
    expect(worst.nodeName).toBe("lead");
    expect((worst.data!.chain as { name: string }[]).map(link => link.name)).toEqual([
      "org",
      "team",
      "lead"
    ]);
    expect(worst.data!.sequentialMs as number).toBeGreaterThanOrEqual(LATENCY_MS * 2);
    expect(worst.message).toContain("3 sequential async flights");

    // It still renders the right thing — that is what makes it easy to ship.
    expect(team).toBe("Platform");
    expect(lead).toBe("Ada Lovelace");
  });

  it("fixed: composing the requests leaves no chain to find", async () => {
    const { artifact, chains, lead, team } = await drive("fixed");

    expect(chains).toEqual([]);
    expect(artifact).toHaveNoDiagnostics();
    expect(team).toBe("Platform");
    expect(lead).toBe("Ada Lovelace");
  });
});
