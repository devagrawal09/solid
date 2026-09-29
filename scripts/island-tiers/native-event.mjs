#!/usr/bin/env node
// Cross-runtime flush in a real browser (documentation/plans/
// island-runtime-tiers.md, "Cross-runtime flush"): one click reaches an
// inner island (a kernel island on the button, whose effect reads the outer
// island's DOM) and an outer island (tier 0 on the div, or on the kernel too
// with `one kernel`: a single runtime). A trusted (user) event runs a
// microtask checkpoint after each listener callback; a script-dispatched
// one (`el.click()`, the loader's replay) does not. The islands are the
// compiler's output (`compileIslands`), activated by the islands entry
// (`islandsEntry`): all at load (`eager`), or the outer one through the
// loader on its first event (`lazy`: the first click activates and replays
// it, the second is the real test). Island handlers are delegated (one
// capture listener per event type on the document, shared with the
// loader's), so every mode must read the fresh value: before, chunks
// attached one listener per element and the trusted rows read "1".
//
//   node scripts/island-tiers/native-event.mjs
import { build } from "esbuild";
import { createRequire } from "node:module";
import { join } from "node:path";
import { launchChromium, ROOT } from "../ssr-redesign/lib.mjs";

const require = createRequire(import.meta.url);
const { compileIslands } = require(join(ROOT, "packages/compiler/index.js"));
const { islandsEntry } = require(join(ROOT, "packages/compiler/islands-build.js"));

// KERNEL_DIR: run other copies of t0.ts / index.ts.
const K = process.env.KERNEL_DIR || join(ROOT, "packages/signals/src/kernel");
const RUNTIMES = {
  "@solidjs/signals/t0": join(K, "t0.ts"),
  "@solidjs/signals/kernel": join(K, "index.ts")
};

const OUTER = `
import { $component, $event, $signal } from "solid-js";
export const Outer = $component(function* (props) {
  const [a, setA] = yield* $signal(1);
  const inc = $event(function* () { setA(x => x + 1); });
  return function* () {
    return <div class="outer" onClick={inc}><p>{yield* a}</p>{props.children}</div>;
  };
});
`;
const INNER = `
import { $component, $effect, $event, $signal } from "solid-js";
export const Inner = $component(function* () {
  const [b, setB] = yield* $signal(10);
  const inc = $event(function* () { setB(x => x + 10); });
  yield* $effect(function* () {
    const v = yield* b;
    if (v !== 10) window.log.push("effect sees outer " + document.querySelector(".outer p").textContent);
  });
  return function* () { return <button onClick={inc}>{yield* b}</button>; };
});
`;

async function page(oneKernel, mode) {
  const outer = compileIslands(OUTER, {
    filename: "/outer.tsx",
    idPrefix: "o",
    minTier: oneKernel ? 1 : 0
  });
  const inner = compileIslands(INNER, { filename: "/inner.tsx", idPrefix: "n" });
  const chunks = new Map(
    [...outer.chunks, ...inner.chunks].map(c => ["chunk:" + c.id, c.code])
  );
  const islands = [...outer.manifest.islands, ...inner.manifest.islands];
  const entry =
    islandsEntry({ islands, mode, chunk: id => "chunk:" + id, prefetch: "interaction" }) +
    "\nwindow.log = [];\nstart();\n";
  const js = (
    await build({
      stdin: { contents: entry, resolveDir: ROOT, loader: "js" },
      bundle: true,
      write: false,
      format: "esm",
      splitting: false,
      plugins: [
        {
          name: "islands",
          setup(b) {
            b.onResolve({ filter: /^chunk:/ }, a => ({ path: a.path, namespace: "chunk" }));
            b.onLoad({ filter: /.*/, namespace: "chunk" }, a => ({
              contents: chunks.get(a.path),
              loader: "js",
              resolveDir: ROOT
            }));
            b.onResolve({ filter: /^@solidjs\/signals\/(t0|kernel)$/ }, a => ({
              path: RUNTIMES[a.path]
            }));
          }
        }
      ]
    })
  ).outputFiles[0].text;
  const [o] = outer.manifest.islands;
  const [n] = inner.manifest.islands;
  return `<div class="outer" data-i="${o.id}"><p>1</p><button data-i="${n.id}">10</button></div><script type="module">${js}</script>`;
}

const browser = await launchChromium();
try {
  for (const runtimes of ["t0 + kernel", "one kernel"])
    for (const mode of ["eager", "lazy"]) {
      const html = await page(runtimes === "one kernel", mode === "eager" ? "eager" : "auto");
      for (const how of ["trusted (page.click)", "script (el.click())"]) {
        const tab = await browser.newPage();
        tab.on("pageerror", e => console.log("pageerror", e.message));
        await tab.route("http://islands.test/", r =>
          r.fulfill({ contentType: "text/html", body: html })
        );
        await tab.goto("http://islands.test/");
        await tab.waitForFunction(() => window.log);
        // Lazy: the first click activates the outer island and replays.
        for (let i = 0; i < 2; i++) {
          if (how.startsWith("trusted")) await tab.click("button");
          else await tab.evaluate(() => document.querySelector("button").click());
          await tab.waitForTimeout(30);
        }
        const log = await tab.evaluate(() => window.log);
        const fresh = JSON.stringify(log) === JSON.stringify(["effect sees outer 2", "effect sees outer 3"]);
        console.log(
          `${runtimes.padEnd(12)} ${mode.padEnd(6)} ${how.padEnd(22)} ${JSON.stringify(log)}${fresh ? "" : "  STALE"}`
        );
        await tab.close();
      }
    }
} finally {
  await browser.close();
}
