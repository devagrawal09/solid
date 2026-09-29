// Browser script for scripts/example-blocks/browser.mjs.
//
// The lab is a dev-tier app: the production build renders only the "no
// observability tier" banner (`staticSteps`, run with `--mode static` on
// `vite build` output). The default mode runs both apps' `vite` dev servers
// and drives every card, comparing the cards and the evidence panel.
export const mode = "dev";
export const root = "#root";
export const normalize = html =>
  html
    .replace(/<span class="ms">[\d.]+ms<\/span>/g, '<span class="ms">#ms</span>')
    .replace(/painted \d+ms after the click/g, "painted #ms after the click")
    .replace(/\d+ms sequential/g, "#ms sequential");
// The diagnostics the lab exists to show are also logged to the console by
// the runtime (dev tier); they are the subject, not a failure.
export const ignoreConsole =
  /EFFECT_WRITES_OWN_SOURCE|EFFECT_RELAY_TEAR|ASYNC_WATERFALL|\[why-run\]|\[vite\]|solid-diagnostics/;

const click = sel => async page => {
  await page.click(sel);
  await page.waitForTimeout(80);
};
const type = text => async page => {
  await page.fill("input[name=q]", text);
  await page.waitForTimeout(80);
};

export const staticSteps = [
  [
    "load (production banner)",
    async (page, { base }) => {
      await page.goto(base + "/");
      await page.waitForSelector(".prod-banner");
    }
  ]
];

export const steps = [
  [
    "load",
    async (page, { base }) => {
      await page.goto(base + "/");
      await page.waitForSelector("#next");
    }
  ],
  [
    "next ×5",
    async page => {
      for (let i = 0; i < 5; i++) await page.click("#next");
      await page.waitForTimeout(80);
    }
  ],
  ["25 per page", click("#size-25")],
  ["variant fixed", click("#variant-fixed")],
  ["clear & re-arm", click("#clear-report")],
  ["tab relay", click("#tab-relay")],
  ["select Grace", click("#row-grace")],
  ["filter li", type("li")],
  ["filter ken", type("ken")],
  ["tab waterfall", click("#tab-waterfall")],
  [
    "load organisation",
    async page => {
      await page.click("#load-org");
      await page.waitForSelector("#landed");
      await page.waitForTimeout(100);
    }
  ],
  ["tab publish", click("#tab-publish")],
  [
    "publish",
    async page => {
      await page.click("#publish");
      await page.waitForFunction(() => document.getElementById("status")?.textContent === "done");
      await page.waitForTimeout(100);
    }
  ],
  ["variant fixed", click("#variant-fixed")],
  [
    "publish (fixed)",
    async page => {
      await page.click("#publish");
      await page.waitForFunction(() => document.getElementById("status")?.textContent === "done");
      await page.waitForTimeout(100);
    }
  ]
];
