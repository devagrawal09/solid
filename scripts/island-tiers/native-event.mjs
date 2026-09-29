#!/usr/bin/env node
// Cross-runtime flush in a real browser (documentation/plans/
// island-runtime-tiers.md, "Cross-runtime flush"): one click reaches a
// kernel island (inner button, its effect reads the outer island's DOM) and
// a tier-0 island (outer div). Compiled islands attach a listener per
// element; a trusted (user) event runs a microtask checkpoint after each
// listener, a script-dispatched one (`el.click()`, the loader's replay) does
// not. Delegation (one listener per event type, as Solid's `delegateEvents`)
// is one listener either way.
//
//   node scripts/island-tiers/native-event.mjs
import { build } from "esbuild";
import { join } from "node:path";
import { launchChromium, ROOT } from "../ssr-redesign/lib.mjs";

// KERNEL_DIR: run other copies of t0.ts / index.ts (e.g. the pre-page-flush ones).
const K = process.env.KERNEL_DIR || join(ROOT, "packages/signals/src/kernel");
const entry = `
import * as t0 from ${JSON.stringify(join(K, "t0.ts"))};
import * as k from ${JSON.stringify(join(K, "index.ts"))};
const log = (window.log = []);
const outer = document.querySelector(".outer"), p = outer.firstElementChild, button = outer.lastElementChild;
// the outer island: tier 0, or on the kernel too (#one: a single runtime)
let incA;
if (location.hash.includes("one"))
  k.createRoot(() => {
    const [a, sa] = k.createSignal(1);
    k.createRenderEffect(a, v => { if (v !== 1) p.textContent = v; });
    incA = () => sa(x => x + 1);
  });
else {
  const a = t0.cell(1);
  t0.hole([a], () => t0.get(a), v => { p.textContent = v; }, 1);
  incA = () => t0.set(a, x => x + 1);
}
// tier 1: the inner island; its user effect reads the outer island's DOM
let setB;
k.createRoot(() => {
  const [b, sb] = k.createSignal(10);
  setB = sb;
  k.createRenderEffect(b, v => { button.textContent = v; });
  k.createEffect(b, v => { if (v !== 10) log.push("effect sees outer " + p.textContent); });
});
k.flush();
const incB = () => setB(x => x + 10);
if (location.hash.includes("delegated")) {
  // one listener: the inner handler, then the outer one (Solid's delegation order)
  document.addEventListener("click", e => {
    if (button.contains(e.target)) incB();
    if (outer.contains(e.target)) incA();
  });
} else {
  button.addEventListener("click", incB);
  outer.addEventListener("click", incA);
}
`;
const js = (
  await build({
    stdin: { contents: entry, resolveDir: ROOT, loader: "js" },
    bundle: true,
    write: false,
    format: "iife"
  })
).outputFiles[0].text;
const html = `<div class="outer"><p>1</p><button>10</button></div><script>${js}</script>`;

const browser = await launchChromium();
try {
  for (const runtimes of ["t0 + kernel", "one kernel"])
    for (const listeners of ["per-element", "delegated"])
      for (const how of ["trusted (page.click)", "script (el.click())"]) {
        const page = await browser.newPage();
        page.on("pageerror", e => console.log("pageerror", e.message));
        await page.route("http://islands.test/", r =>
          r.fulfill({ contentType: "text/html", body: html })
        );
        await page.goto(
          "http://islands.test/#" +
            (listeners === "delegated" ? "delegated" : "") +
            (runtimes === "one kernel" ? "-one" : "")
        );
        if (how.startsWith("trusted")) await page.click("button");
        else await page.evaluate(() => document.querySelector("button").click());
        await page.waitForTimeout(20);
        const log = await page.evaluate(() => window.log);
        console.log(
          `${runtimes.padEnd(12)} ${listeners.padEnd(12)} ${how.padEnd(22)} ${JSON.stringify(log)}`
        );
        await page.close();
      }
} finally {
  await browser.close();
}
