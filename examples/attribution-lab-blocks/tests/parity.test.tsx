/**
 * @vitest-environment jsdom
 */
// Differential parity: one script drives the whole lab — every card, both
// variants, "Clear & re-arm" — against examples/attribution-lab's App and
// this twin's, and compares the DOM after every step. The evidence panel is
// DOM, so this compares what the diagnostics and attribution channels
// reported for each app too (volatile timings normalized away).
//
// Real timers, deadline-polled (the rig of `helpers.ts`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import * as original from "../../attribution-lab/src/app";
import * as originalEngine from "../../attribution-lab/src/lab/engine";
import * as twin from "../src/app";
import * as twinEngine from "../src/lab/engine";
import { CLAMP_WATCH } from "../src/scenarios/clamp/Pager";
import { click, mount, type as typeInto, until, type Mounted } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** The panel commits on a microtask; timers of async cards settle on 0 ms. */
async function settleReport() {
  await wait(20);
  flush();
  await Promise.resolve();
  await Promise.resolve();
  flush();
}

function normalize(html: string) {
  return html
    .replace(/<span class="ms">[\d.]+ms<\/span>/g, '<span class="ms">#ms</span>')
    .replace(/painted \d+ms after the click/g, "painted #ms after the click")
    .replace(/\d+ms sequential/g, "#ms sequential");
}

type Step = [name: string, run: (app: Mounted) => Promise<void> | void];

const pagerStory: Step[] = [
  [
    "next ×5",
    app => {
      for (let i = 0; i < 5; i++) click(app, "#next");
    }
  ],
  ["25 per page", app => click(app, "#size-25")]
];
const relayStory: Step[] = [
  ["select Grace", app => click(app, "#row-grace")],
  ["filter li", app => typeInto(app, "input[name=q]", "li")],
  ["filter ken", app => typeInto(app, "input[name=q]", "ken")],
  ["filter den", app => typeInto(app, "input[name=q]", "den")],
  ["select Dennis", app => click(app, "#row-dennis")],
  ["clear the filter", app => typeInto(app, "input[name=q]", "")]
];
const waterfallStory: Step[] = [
  ["load organisation", app => click(app, "#load-org")],
  [
    "the page reveals, chains are read",
    async app => {
      await until(() => app.container.querySelector("#landed") !== null, "the page to land");
      await wait(30);
    }
  ],
  ["load again", app => click(app, "#load-org")],
  [
    "lands again",
    async app => {
      await until(() => app.container.querySelector("#landed") !== null, "the page to land");
      await wait(30);
    }
  ]
];
const publishStory: Step[] = [
  ["publish", app => click(app, "#publish")],
  [
    "publishing finishes",
    async app => {
      await until(() => app.text("#status") === "done", "the action to finish");
      await wait(20);
    }
  ]
];

export const steps: Step[] = [
  ["mount", () => {}],
  ...pagerStory,
  ["variant fixed", app => click(app, "#variant-fixed")],
  ...pagerStory,
  ["clear & re-arm", app => click(app, "#clear-report")],
  ["tab relay", app => click(app, "#tab-relay")],
  ...relayStory,
  ["variant fixed", app => click(app, "#variant-fixed")],
  ...relayStory,
  ["tab waterfall", app => click(app, "#tab-waterfall")],
  ...waterfallStory,
  ["variant fixed", app => click(app, "#variant-fixed")],
  ...waterfallStory,
  ["tab publish", app => click(app, "#tab-publish")],
  ...publishStory,
  ["variant fixed", app => click(app, "#variant-fixed")],
  ...publishStory,
  ["back to broken", app => click(app, "#variant-broken")],
  ["back to the first tab", app => click(app, "#tab-clamp")]
];

async function record(App: (props: {}) => unknown, engine: typeof twinEngine) {
  engine.arm({ watch: CLAMP_WATCH });
  const app = mount(() => App({}));
  const out: string[] = [];
  try {
    for (const [, run] of steps) {
      await run(app);
      await settleReport();
      out.push(normalize(app.container.innerHTML));
    }
  } finally {
    app.dispose();
    engine.disarm();
  }
  return out;
}

describe("attribution-lab parity", () => {
  it("renders the same cards and the same evidence as the original after every step", async () => {
    const a = await record(original.App, originalEngine as typeof twinEngine);
    const b = await record(twin.App, twinEngine);
    const at = (name: string) => a[steps.findIndex(s => s[0] === name)];
    // The script reaches the states it is meant to compare.
    expect(at("25 per page")).toContain("EFFECT_WRITES_OWN_SOURCE");
    expect(at("filter li")).toContain("EFFECT_RELAY_TEAR");
    expect(a.join("")).toContain("ASYNC_WATERFALL");
    expect(a.join("")).toContain("org → team → lead");
    expect(at("publishing finishes")).toContain("No imperative frame");
    for (let i = 0; i < steps.length; i++) {
      expect(b[i], `step ${i}: ${steps[i][0]}`).toBe(a[i]);
    }
  }, 30_000);
});
