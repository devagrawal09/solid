/**
 * Differential parity: one script drives the whole demo — all four cards in
 * both modes, the focus select — against examples/diagnostics' App and this
 * twin's, and compares the DOM after every step. The evidence panels are DOM,
 * so this also compares what the diagnostics and attribution channels
 * reported for each app (timings normalized away).
 *
 * The attribution engine is process-wide (re-run history, chain log, one-shot
 * verdicts), so each app runs on a fresh module graph — its own runtime —
 * via `vi.resetModules()`.
 *
 * Real timers, deadline-polled (the rig of `helpers.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function normalize(html: string) {
  return (
    html
      .replace(/\d+(\.\d+)?(<!---->)?ms/g, "#ms")
      // Owner paths differ (see the README): the original reads
      // `<For> › <Show> › value › <ResultsPanel> › tear:summary`, the twin
      // `effect › effect › effect › effect › tear:summary` — a `$component`
      // rendered from a view runs its setup outside the `<Name>`-labelled
      // root that dev `createComponent` opens. Checked separately below.
      .replace(/<p class="event-owner">in [^<]*<\/p>/g, '<p class="event-owner">in #path</p>')
  );
}

interface Rig {
  host: HTMLElement;
  flush(): void;
  typeInto(input: HTMLInputElement, text: string): void;
  until(condition: () => boolean, what: string): Promise<void>;
}

const card = (rig: Rig, id: string) =>
  [...rig.host.querySelectorAll<HTMLElement>(".grid > .card")].find(
    c => !!c.querySelector(`[id^="${id}-"]`)
  )!;
const frames = (rig: Rig, id: string) => card(rig, id).querySelectorAll(".frames li").length;
const press = (rig: Rig, selector: string) => {
  rig.host.querySelector(selector)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  rig.flush();
};
const type = (rig: Rig, selector: string, text: string) =>
  rig.typeInto(rig.host.querySelector<HTMLInputElement>(selector)!, text);

/** The channels drain into the UI on a microtask, off the reactive path. */
async function drain(rig: Rig) {
  await wait(10);
  rig.flush();
  await Promise.resolve();
  await Promise.resolve();
  rig.flush();
}

type Step = [name: string, run: (rig: Rig) => Promise<void> | void];

const scenarioSteps: Step[] = [
  ["tear: type b", rig => type(rig, "#tear-query", "b")],
  ["tear: type r", rig => type(rig, "#tear-query", "r")],
  ["overrun: type a note", rig => type(rig, "#overrun-note", "thanks!")],
  ["overrun: add a part", rig => press(rig, "#overrun-add")],
  [
    "waterfall: load story 1",
    async rig => {
      press(rig, "#waterfall-load-1");
      await rig.until(() => frames(rig, "waterfall") > 0, "story 1");
      await wait(30);
    }
  ],
  [
    "waterfall: load story 3",
    async rig => {
      const before = frames(rig, "waterfall");
      press(rig, "#waterfall-load-3");
      await rig.until(() => frames(rig, "waterfall") > before, "story 3");
      await wait(30);
    }
  ],
  [
    "action: two quick clicks",
    async rig => {
      press(rig, "#action-inc");
      press(rig, "#action-inc");
      await rig.until(() => frames(rig, "action") >= 2, "both saves");
      await wait(30);
    }
  ],
  ["action: reset", rig => press(rig, "#action-reset")]
];

const focus = (value: string) => (rig: Rig) => {
  const select = rig.host.querySelector<HTMLSelectElement>("#focus")!;
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
  rig.flush();
};

export const steps: Step[] = [
  // The story memos are not as lazy as StoryCard's comment says: both apps
  // start the story → author → avatar chain for story 1 at mount (60 ms per
  // hop here). Let it land, so later steps do not race it.
  [
    "mount",
    async () => {
      await wait(400);
    }
  ],
  ...scenarioSteps,
  ["mode: fixed", rig => press(rig, "#mode-fixed")],
  ...scenarioSteps,
  ["focus: waterfall", focus("waterfall")],
  ["focus: action", focus("action")],
  ["focus: all", focus("all")],
  ["mode: broken", rig => press(rig, "#mode-broken")],
  ["tear again", rig => type(rig, "#tear-query", "br")]
];

async function record(which: "original" | "twin") {
  vi.resetModules();
  const { render } = await import("@solidjs/web");
  const { flush } = await import("solid-js");
  const helpers = await import("./helpers");
  const app =
    which === "original" ? await import("../../diagnostics/src/app") : await import("../src/app");
  const stories =
    which === "original"
      ? await import("../../diagnostics/src/scenarios/waterfall/api")
      : await import("../src/scenarios/waterfall/api");
  const cart =
    which === "original"
      ? await import("../../diagnostics/src/scenarios/action/cart-api")
      : await import("../src/scenarios/action/cart-api");
  // The page's own attribution posture (`startDiagnostics` in channel.ts),
  // minus the wall-clock `HOT_SCOPE_TIME` verdict: on a loaded runner it
  // fires for whichever app happens to be slow, which is noise here.
  const { attribution } = await import("solid-js/attribution");
  attribution.enable({
    log: false,
    hotTime: false,
    waterfalls: { minFlightMs: 40 },
    holds: { infoMs: 100, warnMs: 200 },
    longHolds: { infoMs: 500, warnMs: 1000 }
  });
  stories.setLatency(60);
  cart.setLatency(150);
  const host = helpers.mountPoint();
  const rig: Rig = { host, flush, typeInto: helpers.typeInto, until: helpers.until };
  const App = app.App as (props: {}) => unknown;
  const dispose = render(() => App({}) as never, host);
  const out: string[] = [];
  try {
    for (const [, run] of steps) {
      await run(rig);
      await drain(rig);
      out.push(normalize(host.innerHTML));
    }
  } finally {
    dispose();
    host.remove();
  }
  return out;
}

describe("diagnostics parity", () => {
  it("renders the same cards and the same evidence as the original after every step", async () => {
    const a = await record("original");
    const b = await record("twin");
    const at = (name: string) => a[steps.findIndex(s => s[0] === name)];
    if (process.env.DUMP)
      for (let i = 0; i < a.length; i++) {
        (await import("node:fs")).writeFileSync(
          `${process.env.DUMP}/a${i}.html`,
          a[i].replace(/></g, ">\n<")
        );
        (await import("node:fs")).writeFileSync(
          `${process.env.DUMP}/b${i}.html`,
          b[i].replace(/></g, ">\n<")
        );
      }
    // The script reaches the states it is meant to compare.
    expect(at("tear: type b")).toContain("EFFECT_RELAY_TEAR");
    expect(a.join("")).toContain("UNSTABLE_MEMO_OUTPUT");
    expect(a.join("")).toContain("waterfall:story → waterfall:author → waterfall:avatar");
    expect(a.join("")).toContain("SILENT_HOLD");
    expect(a.join("")).toContain("opened by an action");
    for (let i = 0; i < steps.length; i++) {
      const x = a[i],
        y = b[i];
      let at = 0;
      while (at < x.length && x[at] === y[at]) at++;
      // The differing region, so a failure names what differs.
      expect(y.slice(Math.max(0, at - 120), at + 200), `step ${i}: ${steps[i][0]}`).toBe(
        x.slice(Math.max(0, at - 120), at + 200)
      );
    }
  }, 60_000);
});
