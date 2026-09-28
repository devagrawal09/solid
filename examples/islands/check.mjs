// End-to-end check of the built example in Chromium: serve dist/, load the
// prerendered page, and drive every island — a Toggle (tier 0), the counter
// cut from App (tier 0), and the todo list (tier 1) — printing the scripts
// each step loaded. Exits non-zero on a failed expectation.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
}
const dist = new URL("./dist/", import.meta.url).pathname;
const files = {};
const walk = dir => {
  for (const f of readdirSync(join(dist, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${f.name}` : f.name;
    if (f.isDirectory()) walk(rel);
    else files[rel] = readFileSync(join(dist, rel));
  }
};
walk("");
const browser = await chromium.launch();
const page = await browser.newPage();
const loaded = [];
await page.route("http://islands.local/**", route => {
  const path = new URL(route.request().url()).pathname.slice(1) || "index.html";
  const body = files[path];
  if (!body) return route.fulfill({ status: 404, body: "" });
  if (path.endsWith(".js")) loaded.push(`${path} (${gzipSync(body).length} B gz)`);
  const type = path.endsWith(".js") ? "application/javascript" : path.endsWith(".html") ? "text/html" : "text/plain";
  return route.fulfill({ contentType: type, body });
});
const errors = [];
page.on("pageerror", e => errors.push(e.message));
let failed = false;
const expect = (what, ok) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failed = true;
};
const step = async (label, fn, wait = 100) => {
  const before = loaded.length;
  await fn();
  await page.waitForTimeout(wait);
  console.log(`  ${label}: loaded ${loaded.slice(before).join(", ") || "nothing"}`);
};

await step("load", () => page.goto("http://islands.local/"));
expect("the page is prerendered (no client render)", (await page.textContent("h1")) === "Compiled islands");

await step("click the first toggle", () => page.click(".toggle a"));
expect("toggle collapses its replies", (await page.getAttribute(".toggle", "class")) === "toggle");
expect("toggle text updates", (await page.textContent(".toggle a")) === "[+] collapsed");

await step("click +1 twice", async () => {
  await page.click(".counter button");
  await page.waitForTimeout(50);
  await page.click(".counter button");
});
expect("counter counts both clicks (the first is replayed)", (await page.textContent(".counter b")) === "2");
expect("plural hole updates", (await page.textContent(".counter")).includes("times"));

await step("check the second todo", () => page.click(".todos li:nth-child(2) input"));
expect("todo row replaced as done", (await page.getAttribute(".todos li:nth-child(2)", "class")) === "done");
expect("remaining count updates", (await page.textContent(".todos .left strong")) === "0");
expect("Show opens", (await page.locator(".todos p.done").count()) === 1);

await step("add a todo", async () => {
  await page.fill(".todos .new", "Ship it");
  await page.press(".todos .new", "Enter");
});
expect("a row is created", (await page.locator(".todos li").count()) === 3);
expect("Show closes", (await page.locator(".todos p.done").count()) === 0);

expect("no page errors", errors.length === 0);
if (errors.length) console.log(errors);
await browser.close();
process.exit(failed ? 1 : 0);
