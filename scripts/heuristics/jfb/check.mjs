#!/usr/bin/env node
// Equivalence gate for the JFB Solid 2 variants (build.mjs). Loads each built
// entry from the running JFB server, seeds Math.random identically, drives
// every JFB operation through the app's own buttons / row links, and compares
// #main's innerHTML to the baseline after every step. `broken` must FAIL.
//
//   node scripts/heuristics/jfb/check.mjs [--url http://localhost:8080] [--out file.json]
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { parseArgs } from "../common.mjs";

const args = parseArgs(process.argv.slice(2));
const URL = args.url ?? "http://localhost:8080";
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
}

const VARIANTS = {
  baseline: "solid-next",
  H7: "solid-next-h7",
  L1: "solid-next-l1",
  "H7+L1": "solid-next-h7l1",
  child: "solid-next-child",
  "child-H7": "solid-next-child-h7",
  "rspec-r0": "solid-next-rspec-r0",
  "rspec-r1b": "solid-next-rspec-r1b",
  broken: "solid-next-broken"
};

// Row helpers use JFB's own selectors (benchmarksCommon / benchmarksPuppeteer).
const label = n => `tbody>tr:nth-of-type(${n})>td:nth-of-type(2)>a`;
const remove = n => `tbody>tr:nth-of-type(${n})>td:nth-of-type(3)>a>span:nth-of-type(1)`;
// Every JFB CPU benchmark's operations, plus selection changes and removals
// at both ends and after reorders.
const STEPS = [
  ["01 run", "#run"],
  ["03 update", "#update"],
  ["03 update again", "#update"],
  ["04 select row 2", label(2)],
  ["04 select row 5", label(5)],
  ["04 re-select row 5", label(5)],
  ["05 swap", "#swaprows"],
  ["04 select swapped row 999", label(999)],
  ["05 swap back", "#swaprows"],
  ["06 remove row 4", remove(4)],
  ["06 remove row 1", remove(1)],
  ["06 remove last row", remove(998)],
  ["08 append 1k", "#add"],
  ["03 update 2k", "#update"],
  ["05 swap 2k", "#swaprows"],
  ["04 select row 1500", label(1500)],
  ["09 clear", "#clear"],
  ["05 swap on empty", "#swaprows"],
  ["03 update on empty", "#update"],
  ["02 run", "#run"],
  ["02 replace", "#run"],
  ["04 select row 10", label(10)],
  ["02 replace with selection", "#run"],
  ["07 create 10k", "#runlots"],
  ["03 update 10k", "#update"],
  ["04 select row 10000", label(10000)],
  ["09 clear 10k", "#clear"],
  ["01 run after clear", "#run"]
];

const SEED = `(() => { let s = 0x2545f491; Math.random = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; })();`;

const browser = await chromium.launch({ args: ["--js-flags=--expose-gc"] });
async function trace(dir) {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.addInitScript(SEED);
  await page.goto(`${URL}/frameworks/keyed/${dir}/index.html`);
  await page.waitForSelector("#run");
  const out = [];
  for (const [, sel] of STEPS) {
    await page.click(sel);
    await page.evaluate(() => new Promise(r => setTimeout(r, 0)));
    out.push(await page.evaluate(() => document.getElementById("main").innerHTML));
  }
  await page.close();
  return { out, errors };
}

const ref = await trace(VARIANTS.baseline);
const report = { url: URL, chromium: browser.version(), steps: STEPS.map(s => s[0]), variants: {} };
// Sanity: the baseline trace itself follows JFB's expectations.
const rows = h => (h.match(/<tr/g) || []).length;
const expectRows = { "01 run": 1000, "08 append 1k": 1997, "09 clear": 0, "07 create 10k": 10000, "02 replace": 1000 };
for (const [i, [name]] of STEPS.entries())
  if (name in expectRows && rows(ref.out[i]) !== expectRows[name])
    throw new Error(`baseline step ${name}: ${rows(ref.out[i])} rows, expected ${expectRows[name]}`);
const dangers = h => (h.match(/class="danger"/g) || []).length;
for (const [i, [name]] of STEPS.entries())
  if (/^04/.test(name) && dangers(ref.out[i]) !== 1) throw new Error(`baseline step ${name}: ${dangers(ref.out[i])} selected rows`);
let bad = false;
for (const [name, dir] of Object.entries(VARIANTS)) {
  const t = name === "baseline" ? ref : await trace(dir);
  const at = t.out.findIndex((s, i) => s !== ref.out[i]);
  const ok = at === -1 && t.errors.length === 0;
  report.variants[name] = {
    dir,
    ok,
    firstMismatch: at === -1 ? null : STEPS[at][0],
    pageErrors: t.errors,
    bytesCompared: t.out.reduce((a, s) => a + s.length, 0)
  };
  const expected = name === "broken" ? !ok : ok;
  if (!expected) bad = true;
  console.log(
    `${(ok ? "ok  " : "FAIL").padEnd(5)} ${name.padEnd(10)} ${at === -1 ? "" : `first mismatch at "${STEPS[at][0]}"`} ${t.errors.join("; ")}${name === "broken" ? (ok ? "  <- negative control did NOT fail" : "  (negative control, expected)") : ""}`
  );
}
await browser.close();
if (args.out) writeFileSync(args.out, JSON.stringify(report, null, 2) + "\n");
process.exit(bad ? 1 : 0);
