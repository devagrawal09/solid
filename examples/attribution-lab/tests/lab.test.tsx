/**
 * The lab itself.
 *
 * The scenario tests assert what the runtime reports; this one asserts that
 * the app RENDERS that report faithfully and without disturbing it. Two
 * properties are load-bearing and easy to break:
 *
 *   1. The channel listeners never write reactive state. They are invoked
 *      synchronously inside the flush, so a write there would change the very
 *      numbers the panel is reporting. The guard here is arithmetic: driving
 *      the story with the whole app mounted must produce exactly the same
 *      `pageLabel` run count (2 broken, 1 fixed) as driving the bare
 *      component does in `clamp.test.tsx`.
 *
 *   2. Re-arming re-reports. Cycle and tear verdicts fire once per key, so a
 *      second visit to a Broken card is silent unless `arm()` disables the
 *      engine first and the card is remounted on a fresh key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { App } from "../src/app";
import { arm, disarm } from "../src/lab/engine";
import { CLAMP_WATCH } from "../src/scenarios/clamp/Pager";
import { click, mount, type Mounted } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  disarm();
  vi.restoreAllMocks();
});

/** The panel commits its buffered lines on a microtask, by design. */
async function settleReport(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  flush();
}

const texts = (app: Mounted, selector: string) =>
  [...app.container.querySelectorAll(selector)].map(el => el.textContent ?? "");

/**
 * Walk to page 6 of 6, then shrink the page count to 3. Returns the run lines
 * the panel added for that last step alone — the panel itself keeps the whole
 * session, which is what you want when reading it by hand.
 */
async function drivePagerStory(app: Mounted): Promise<string[]> {
  for (let i = 0; i < 5; i++) click(app, "#next");
  await settleReport();
  const before = texts(app, ".report-lines .run pre").length;
  click(app, "#size-25");
  await settleReport();
  const after = texts(app, ".report-lines .run pre");
  // Newest first, so the lines for this step are the first `after - before`.
  return after.slice(0, after.length - before);
}

describe("the lab shell", () => {
  it("renders the diagnostic and the why-chain, verbatim and volatile-free", async () => {
    arm({ watch: CLAMP_WATCH });
    const app = mount(() => <App />);

    const runLines = await drivePagerStory(app);

    expect(texts(app, ".report-lines .diag .code")).toContain("EFFECT_WRITES_OWN_SOURCE");

    // Two runs of the one watched reader for one page-size change — the tear,
    // on screen. Same number the bare component produces in `clamp.test.tsx`:
    // rendering the report does not change what the report reports.
    expect(runLines).toHaveLength(2);
    // Newest first: the second run is the one the clamp's own write caused.
    expect(runLines[0]).toContain('[why-run] effect "pageLabel" ran (run n)');
    expect(runLines[0]).toContain('← signal "page" write 6 → 3 — effect "clampPage"');
    // Nothing volatile survives into the rendered evidence.
    for (const line of texts(app, ".report-lines .run pre")) {
      expect(line).not.toMatch(/\(run \d+/);
      expect(line).not.toMatch(/\(#\d+\)/);
    }
  });

  it("clears and re-arms on every switch, and the Fixed card has nothing to say", async () => {
    arm({ watch: CLAMP_WATCH });
    const app = mount(() => <App />);

    await drivePagerStory(app);
    expect(texts(app, ".report-lines .diag").length).toBeGreaterThan(0);

    // Switching variant re-arms: the panel empties before the new card runs.
    click(app, "#variant-fixed");
    await settleReport();
    expect(texts(app, ".report-lines .run pre")).toEqual([]);

    const fixedRuns = await drivePagerStory(app);
    expect(texts(app, ".report-lines .diag")).toEqual([]);
    expect(fixedRuns).toHaveLength(1);

    // Back to Broken: because `arm()` disables the engine (clearing the
    // once-per-key verdict ledgers) and the card remounts on a fresh key, the
    // finding is reported again rather than going quiet.
    click(app, "#variant-broken");
    await settleReport();
    const againRuns = await drivePagerStory(app);

    expect(texts(app, ".report-lines .diag .code")).toContain("EFFECT_WRITES_OWN_SOURCE");
    expect(againRuns).toHaveLength(2);
  });

  it("switching scenario re-arms the watch list and rebuilds the card", async () => {
    arm({ watch: CLAMP_WATCH });
    const app = mount(() => <App />);

    click(app, "#tab-publish");
    await settleReport();

    expect(texts(app, ".report-watch .code")).toEqual([
      "statusBadge",
      "progressBar",
      "publishedList",
      "skippedNote"
    ]);
    expect(app.container.querySelector("#publish")).not.toBeNull();
    expect(app.container.querySelector("#next")).toBeNull();
    expect(texts(app, ".report-lines .diag")).toEqual([]);
  });
});
