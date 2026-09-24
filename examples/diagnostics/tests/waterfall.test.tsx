/**
 * Scenario 3 — the accidental async waterfall.
 *
 * Nothing loads until a story is picked, so the capture below brackets the
 * *click* that started the chain — the verdict the demo shows a presenter is
 * the one their interaction caused, not a leftover from mounting the page.
 *
 * The chain is graph-provable, so the assertion is exact: three named flights
 * in order, at `warn` severity. Timing assertions stay loose enough for a
 * loaded machine while still separating serial from parallel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@solidjs/web";
import { captureArtifact, expectNoDiagnostics } from "@solidjs/diagnostics";
import { StoryCard } from "../src/scenarios/waterfall/StoryCard";
import { latency, requestCount, setLatency } from "../src/scenarios/waterfall/api";
import { $, attributionOptions, click, mountPoint, until } from "./helpers";

let dispose: (() => void) | undefined;

beforeEach(() => {
  setLatency(60);
});

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.innerHTML = "";
  setLatency(220);
  vi.restoreAllMocks();
});

function mount(broken: boolean) {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  const host = mountPoint();
  dispose = render(() => <StoryCard broken={broken} />, host);
  return host;
}

const frames = (host: ParentNode) =>
  [...host.querySelectorAll(".frames li")].map(li => li.textContent ?? "");
const elapsedMs = (host: ParentNode) =>
  Number(
    frames(host)
      .at(-1)!
      .match(/^(\d+)ms/)![1]
  );
const requests = (host: ParentNode) =>
  Number(
    frames(host)
      .at(-1)!
      .match(/· (\d+) requests/)![1]
  );

describe("dependent fetches", () => {
  it("chains three flights on the click that loads a story", async () => {
    const host = mount(true);
    // Nothing has been requested yet: the memos are lazy and unread.
    expect(requestCount()).toBe(0);
    expect(frames(host)).toEqual([]);

    const { artifact } = await captureArtifact(
      async () => {
        click($(host, "#waterfall-load-2"));
        await until(() => frames(host).length > 0, "story 2 to complete");
      },
      { scenario: "waterfall/broken", attribution: attributionOptions }
    );

    const chains = artifact.diagnostics.filter(event => event.code === "ASYNC_WATERFALL");
    expect(chains.length).toBeGreaterThan(0);
    const worst = chains.at(-1)!;
    expect((worst.data!.chain as { name: string }[]).map(link => link.name)).toEqual([
      "waterfall:story",
      "waterfall:author",
      "waterfall:avatar"
    ]);
    expect(worst.severity).toBe("warn");
    expect(worst.data!.sequentialMs as number).toBeGreaterThanOrEqual(2 * latency());

    // Three requests, and the page needed more than one round trip of waiting.
    expect(requests(host)).toBe(3);
    expect(elapsedMs(host)).toBeGreaterThanOrEqual(2 * latency());
  });

  it("issues the same three requests in parallel once they are keyed by the story id", async () => {
    const host = mount(false);

    const { artifact } = await captureArtifact(
      async () => {
        click($(host, "#waterfall-load-2"));
        await until(() => frames(host).length > 0, "story 2 to complete");
      },
      { scenario: "waterfall/fixed", attribution: attributionOptions }
    );

    // No chain — and nothing else either: the wait is acknowledged on screen,
    // so the held write never reads as a dead interaction.
    expectNoDiagnostics(artifact);
    expect(artifact.attribution!.reruns.length).toBeGreaterThan(0);
    expect(requests(host)).toBe(3);
    // Same data, same request count, one round trip of waiting.
    expect(elapsedMs(host)).toBeLessThan(2 * latency());
  });

  it("acknowledges the wait while a second story loads", async () => {
    const host = mount(false);
    click($(host, "#waterfall-load-1"));
    await until(() => frames(host).length > 0, "story 1 to complete");

    const { artifact } = await captureArtifact(
      async () => {
        click($(host, "#waterfall-load-3"));
        // The `isPending` reader paints while the new page is in flight.
        await until(() => !!host.querySelector("#waterfall-pending"), "the pending affordance");
        await until(() => frames(host).length > 1, "story 3 to complete");
      },
      { scenario: "waterfall/fixed-second-load", attribution: attributionOptions }
    );

    expectNoDiagnostics(artifact);
    const holds = artifact.attribution!.holds;
    expect(holds.length).toBeGreaterThan(0);
    for (const hold of holds) {
      expect(hold.acknowledgements.map(ack => ack.kind)).toContain("isPending");
    }
  });
});
