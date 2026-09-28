#!/usr/bin/env node
// Debug a compiled-islands variant in Chromium with an unminified bundle:
// load the page, run the app's session, print page errors (with stacks) and
// the root HTML after each step.
//   node scripts/ssr-redesign/islands-debug.mjs todos-local C-eager
import { join } from "node:path";
import { bundleClient, HERE, islandsCompiler, launchChromium, loadServer, ROOT } from "./lib.mjs";
import { APPS } from "./apps.mjs";

const [appName, vname, stepsArg] = process.argv.slice(2);
const app = APPS[appName];
const v = app.variants[vname];
const compiler = islandsCompiler({ minTier: v.islands.minTier, tier1Core: v.islands.tier1Core });
const root = join(HERE, v.islands.root);
const collected = compiler.collect(root);
const islands = { compiler, root, mode: v.islands.mode, prefetch: v.islands.prefetch, files: new Set(collected.files) };
const srv = await loadServer(join(HERE, v.server), join(ROOT, "node_modules/.cache/ssr-redesign", `debug-${appName}-${vname}.mjs`), { islands, tildeRoot: app.tildeRoot });
const html = await app.render(srv);
const client = await bundleClient(join(HERE, v.client), { minify: false, splitting: !!v.splitting, islands, tildeRoot: app.tildeRoot });
const page = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root">${html}</div><script type="module" src="/${client.entry}"></script></body></html>`;
const browser = await launchChromium();
const context = await browser.newContext();
const p = await context.newPage();
await p.route("http://bench.local/**", route => {
  const path = new URL(route.request().url()).pathname.slice(1);
  if (!path) return route.fulfill({ contentType: "text/html", body: page });
  if (client.files[path]) return route.fulfill({ contentType: "application/javascript", body: client.files[path] });
  return route.fulfill({ status: 404, body: "" });
});
if (app.init) await p.addInitScript(app.init);
p.on("pageerror", e => console.log("pageerror:", e.stack));
p.on("console", m => console.log("console:", m.text()));
await p.goto("http://bench.local/");
await p.waitForFunction(() => globalThis.__readyAt !== undefined);
const show = async label => console.log(`--- ${label}\n` + (await p.evaluate(() => document.getElementById("root").innerHTML)).slice(0, Number(process.env.CHARS || 600)));
await show("load");
const n = stepsArg ? Number(stepsArg) : app.session.length;
for (let i = 0; i < n; i++) {
  await p.evaluate(app.session[i]);
  await p.waitForTimeout(app.stepWait ?? 50);
  await show(`step ${i}`);
}
await browser.close();
