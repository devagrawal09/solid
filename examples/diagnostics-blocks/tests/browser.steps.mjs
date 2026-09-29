// Browser script for scripts/example-blocks/browser.mjs.
//
// The demo is a dev-tier app. The default mode runs both apps' `vite` dev
// servers and drives all four cards in both modes, comparing the cards and
// their evidence panels. `--mode static` serves `dist/`: after `pnpm build`
// the page shows the "no diagnostics channel" warning (panels stay empty),
// after `pnpm build:observe` the observe tier with live panels; the same
// script runs against both.
export const mode = "dev";
export const root = "#root";
export const normalize = html =>
  html
    .replace(/\d+(\.\d+)?ms/g, "#ms")
    // Owner paths differ: `<ResultsPanel> › tear:summary` in the original,
    // `effect › … › tear:summary` in the twin (see the README).
    .replace(/<p class="event-owner">in [^<]*<\/p>/g, '<p class="event-owner">in #path</p>');
// The diagnostics the demo exists to show are also logged to the console by
// the runtime (dev tier); they are the subject, not a failure.
export const ignoreConsole =
  /EFFECT_RELAY_TEAR|UNSTABLE_MEMO_OUTPUT|ASYNC_WATERFALL|SILENT_HOLD|HOT_SCOPE|\[why-run\]|\[vite\]|solid-diagnostics/;

const wait = ms => page => page.waitForTimeout(ms);
const click = (sel, ms = 150) => async page => {
  await page.click(sel);
  await page.waitForTimeout(ms);
};
const type = (sel, text) => async page => {
  await page.type(sel, text, { delay: 30 });
  await page.waitForTimeout(150);
};
const focus = value => async page => {
  await page.selectOption("#focus", value);
  await page.waitForTimeout(150);
};

export const steps = [
  [
    "load",
    async (page, { base }) => {
      await page.goto(base + "/");
      await page.waitForSelector("#tear-query");
      // The story chain for story 1 starts at mount (3 × 220 ms): let it land.
      await page.waitForTimeout(1200);
    }
  ],
  ["tear: type b", type("#tear-query", "b")],
  ["overrun: type a note", type("#overrun-note", "thanks")],
  ["overrun: add a part", click("#overrun-add")],
  ["waterfall: story 1", click("#waterfall-load-1", 1200)],
  ["waterfall: story 3", click("#waterfall-load-3", 1200)],
  [
    "action: two quick clicks",
    async page => {
      await page.click("#action-inc");
      await page.click("#action-inc");
      await page.waitForTimeout(2200);
    }
  ],
  ["action: reset", click("#action-reset")],
  ["mode: fixed", click("#mode-fixed", 300)],
  ["tear: type b (fixed)", type("#tear-query", "b")],
  ["waterfall: story 2 (fixed)", click("#waterfall-load-2", 1200)],
  [
    "action: two quick clicks (fixed)",
    async page => {
      await page.click("#action-inc");
      await page.click("#action-inc");
      await page.waitForTimeout(2200);
    }
  ],
  ["focus: waterfall", focus("waterfall")],
  ["focus: all", focus("all")],
  ["mode: broken", click("#mode-broken", 300)],
  ["settle", wait(1200)]
];
