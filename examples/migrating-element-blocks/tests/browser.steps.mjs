// Browser script for scripts/example-blocks/browser.mjs (CSR build). Besides
// the DOM, each step records canvas identity (a counter tagged onto each
// canvas the first time it is seen) and whether the canvas has been painted
// on (a sampled pixel), so node migration and re-creation are compared too.
export const mode = "static";
export const root = "body";
// The probe's own `getImageData` readbacks.
export const ignoreConsole = /willReadFrequently/;

async function tagCanvases(page) {
  await page.evaluate(() => {
    const w = window;
    w.__seen ??= 0;
    const lines = [];
    for (const c of document.querySelectorAll("canvas")) {
      if (!c.__id) c.__id = ++w.__seen;
      // A splat at (100, 100) in canvas space is bright; the background is #f4f7fb.
      const px = c.getContext("2d").getImageData(100, 100, 1, 1).data;
      lines.push(`canvas#${c.__id} splat=${px[0] < 200}`);
    }
    let out = document.getElementById("__probe");
    if (!out) {
      out = document.createElement("pre");
      out.id = "__probe";
      document.documentElement.appendChild(out);
    }
    out.textContent = lines.join("\n");
  });
}

// The probe lives outside <body>; append it to the compared HTML.
export const normalize = html => html;

const click = label => async page => {
  await page.getByRole("button", { name: label, exact: true }).click();
  await page.waitForTimeout(100);
  await tagCanvases(page);
};

async function splat(page, panel) {
  const box = await page.locator(`${panel} canvas`).boundingBox();
  // (100, 100) in canvas space (800 x 450).
  await page.mouse.click(box.x + (100 / 800) * box.width, box.y + (100 / 450) * box.height);
  await page.waitForTimeout(50);
  await tagCanvases(page);
}

export const steps = [
  [
    "load",
    async (page, { base }) => {
      await page.goto(base + "/");
      await page.waitForSelector("canvas");
      await page.waitForTimeout(200);
      await tagCanvases(page);
    }
  ],
  ["splat the left canvas", page => splat(page, ".panel-good")],
  ["splat the right canvas", page => splat(page, ".panel-bad")],
  ["move to PIP", click("PIP (corner)")],
  ["move to Dock", click("Dock")],
  ["back to Hero", click("Hero")]
];

export const snapshot = async page =>
  (await page.evaluate(() => document.body.innerHTML)) +
  "\n" +
  (await page.evaluate(() => document.getElementById("__probe")?.textContent ?? ""));
