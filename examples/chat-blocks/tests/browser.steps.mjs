// Browser script for scripts/example-blocks/browser.mjs: both production
// servers (`node server.js` over `vite build` output). SSR streams the
// welcome reply in the document, the client hydrates and adopts it, and
// later replies stream over server-function calls. Each step waits for the
// stream it started to finish, so the compared DOM is settled; the measured
// generation time (tok/s, seconds) and frames' ids are normalized away.
export const mode = "server";
export const root = "main.chat";
export const normalize = html =>
  html
    .replace(/\d+ tok\/s · [\d.]+s/g, "# tok/s · #s")
    .replace(/\s(data-fid|data-sc|data-occ)="[^"]*"/g, "")
    .replace(/\s_bnd="[^"]*"/g, ' _bnd=""');

const doneCount = n => async page => {
  await page.waitForFunction(
    count => document.querySelectorAll(".status .done").length >= count,
    n,
    { timeout: 30000 }
  );
  await page.waitForTimeout(150);
};

const ask = (text, n) => async page => {
  await page.fill(".composer input", text);
  await page.click(".composer button");
  await doneCount(n)(page);
};

export const steps = [
  [
    "load: SSR welcome streams, hydrates, finishes",
    async (page, { base }) => {
      await page.goto(base + "/");
      await doneCount(1)(page);
    }
  ],
  [
    "type whitespace (send stays disabled)",
    async page => {
      await page.fill(".composer input", "  ");
      await page.waitForTimeout(50);
    }
  ],
  ["ask about signals", ask("how do signals work?", 2)],
  ["ask about server components", ask("what is a server component?", 3)],
  [
    "copy a code block",
    async page => {
      await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
      await page.locator(".copy-code").last().click();
      await page.waitForTimeout(100);
    }
  ],
  [
    "copy label resets",
    async page => {
      await page.waitForTimeout(1400);
    }
  ],
  ["ask something else (fallback answer)", ask("hello there", 4)]
];
