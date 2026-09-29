#!/usr/bin/env node
// Browser check of an example against its `-blocks` twin, in Chromium.
//
//   node scripts/example-blocks/browser.mjs <example> [--mode static|server|dev]
//
// Loads the production build of the original and of the twin, runs the
// twin's `tests/browser.steps.mjs` script against both, and after load and
// after every step compares the app's DOM (hydration keys and markers
// normalized away). Fails on a DOM difference, a console error or warning,
// a page error, or a hydration mismatch message. `DUMP=<file>` writes the
// twin's snapshots there.
//
// The steps module exports:
//   mode: "static" (serve `dist/`, SPA fallback to index.html)
//       | "server" (run `node <server>` with PORT set; build it first)
//       | "dev"    (run the example's `vite` dev server: the dev tier)
//   server?: "server.js"            (mode "server")
//   serverImport?: "tests/…mjs"      (mode "server": `node --import` for both servers)
//   dist?: "dist" | "csr/dist"      (mode "static"; the directory to serve)
//   clock?: boolean                  (install Playwright's fake clock, paused, at load)
//   init?: async page => void        (before the first step: init scripts, …)
//   root?: CSS selector of the compared subtree (default "body")
//   normalize?: (html) => html       (extra, app-specific normalization)
//   snapshot?: async page => string  (replaces reading `root`'s innerHTML)
//   steps: [name, async (page, ctx) => void][] (the first navigates)
//   ignoreConsole?: RegExp           (console messages that are not failures)
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
process.env.PLAYWRIGHT_BROWSERS_PATH ||= "/opt/pw-browsers";
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node22/lib/node_modules/playwright"));
}

const name = process.argv[2];
if (!name) throw new Error("usage: browser.mjs <example>");
const twinDir = join(ROOT, "examples", `${name}-blocks`);
const loaded = await import(pathToFileURL(join(twinDir, "tests/browser.steps.mjs")).href);
// `--mode <m>` overrides the module's `mode`; a `<m>Steps` export, when
// present, replaces `steps` for that mode (e.g. the production build of a
// dev-tier app renders only a banner).
const modeArg = process.argv.includes("--mode")
  ? process.argv[process.argv.indexOf("--mode") + 1]
  : undefined;
// `--variant <v>` applies the module's `variants[v]` overrides (mode, server,
// dist, steps, …): one steps module for an example with several builds.
const variantArg = process.argv.includes("--variant")
  ? process.argv[process.argv.indexOf("--variant") + 1]
  : undefined;
if (variantArg && !loaded.variants?.[variantArg]) throw new Error(`no variant ${variantArg}`);
const base = { ...loaded, ...(variantArg ? loaded.variants[variantArg] : undefined) };
const mode = modeArg ?? base.mode;
const spec = { ...base, mode, steps: base[`${mode}Steps`] ?? base.steps };
console.log(`mode: ${mode}${variantArg ? `, variant: ${variantArg}` : ""}`);

const TYPES = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".png": "image/png"
};

/** Default normalization: hydration keys, markers and comments. */
function normalize(html) {
  let out = html
    .replace(/\s(data-hk|_hk)="[^"]*"/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[\s\S]*?<\/script>/g, "")
    .replace(/<template\b[\s\S]*?<\/template>/g, "");
  if (spec.normalize) out = spec.normalize(out);
  return out;
}

async function startServer(dir, port, dev) {
  const args = dev
    ? [join(dir, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort"]
    : [spec.server ?? "server.js"];
  const child = spawn(process.execPath, args, {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: dev ? "development" : "production",
      // A module both servers are started with (e.g. a `fetch` stub serving
      // fixtures), resolved against the twin's directory.
      ...(spec.serverImport
        ? {
            NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(join(twinDir, spec.serverImport)).href}`
          }
        : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let log = "";
  child.stdout.on("data", d => (log += d));
  child.stderr.on("data", d => (log += d));
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`server in ${dir} exited:\n${log}`);
    try {
      await fetch(url);
      return { url, stop: () => child.kill(), log: () => log };
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  child.kill();
  throw new Error(`server in ${dir} did not start:\n${log}`);
}

async function run(dir, browser, port) {
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);
  const problems = [];
  page.on("console", msg => {
    const text = msg.text();
    if (spec.ignoreConsole && spec.ignoreConsole.test(text)) return;
    if (msg.type() === "error" || msg.type() === "warning" || /hydrat|mismatch/i.test(text))
      problems.push(`console.${msg.type()}: ${text}`);
  });
  page.on("pageerror", e => problems.push(`pageerror: ${e.message}`));
  let base,
    stop = () => {};
  if (spec.mode === "server" || spec.mode === "dev") {
    const s = await startServer(dir, port, spec.mode === "dev");
    base = s.url;
    stop = s.stop;
  } else {
    base = "http://app.local";
    const dist = join(dir, spec.dist ?? "dist");
    await page.route("http://app.local/**", route => {
      let path = decodeURIComponent(new URL(route.request().url()).pathname);
      let file = join(dist, path);
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
      return route.fulfill({
        contentType: TYPES[extname(file)] ?? "application/octet-stream",
        body: readFileSync(file)
      });
    });
  }
  if (spec.clock) {
    // Paused: time moves only by the steps' `page.clock.runFor(…)`.
    await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
    await page.clock.pauseAt(new Date("2026-01-01T00:00:01Z"));
  }
  if (spec.init) await spec.init(page);
  const snapshots = [];
  const ctx = { base };
  try {
    for (const [label, step] of spec.steps) {
      try {
        if (process.env.VERBOSE) console.error(`  ${dir.split("/").pop()}: ${label}`);
        await step(page, ctx);
      } catch (error) {
        // A step that cannot run (a missing element, a hung navigation) is a
        // difference in itself; the rest of the script depends on it.
        problems.push(`step "${label}" failed: ${String(error.message).split("\n")[0]}`);
        snapshots.push([label, `<step failed: ${String(error.message).split("\n")[0]}>`]);
        break;
      }
      const html = spec.snapshot
        ? await spec.snapshot(page)
        : await page.evaluate(
            sel => document.querySelector(sel)?.innerHTML ?? "<missing root>",
            spec.root ?? "body"
          );
      snapshots.push([label, normalize(html)]);
    }
  } finally {
    await page.close();
    stop();
  }
  return { snapshots, problems };
}

// Random ports: other servers may be listening on this shared machine.
const PORT = 20000 + Math.floor(Math.random() * 20000) * 2;
const browser = await chromium.launch();
let failed = false;
try {
  const original = await run(join(ROOT, "examples", name), browser, PORT);
  const twin = await run(twinDir, browser, PORT + 1);
  for (const [who, r] of [
    ["original", original],
    ["twin", twin]
  ]) {
    if (r.problems.length) {
      // Problems of the original are reported, not failures of the twin.
      console.log(`${who === "twin" ? "FAIL" : "note"} ${who}: ${r.problems.length} console/page problem(s)`);
      for (const p of r.problems) console.log(`     ${p.slice(0, 400)}`);
      if (who === "twin") failed = true;
    }
  }
  if (process.env.DUMP) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      process.env.DUMP,
      twin.snapshots.map(([label, html]) => `== ${label}\n${html}`).join("\n")
    );
  }
  const steps = Math.max(original.snapshots.length, twin.snapshots.length);
  for (let i = 0; i < steps; i++) {
    const label = (original.snapshots[i] ?? twin.snapshots[i])[0];
    const a = original.snapshots[i]?.[1];
    const b = twin.snapshots[i]?.[1];
    if (a === b) {
      console.log(`ok   ${label} (${a?.length} chars)`);
    } else {
      failed = true;
      let at = 0;
      while (a && at < a.length && a[at] === b?.[at]) at++;
      console.log(`FAIL ${label}: DOM differs at ${at}`);
      console.log(`     original: …${a?.slice(Math.max(0, at - 120), at + 200)}`);
      console.log(`     twin:     …${b?.slice(Math.max(0, at - 120), at + 200)}`);
    }
  }
} finally {
  await browser.close();
}
console.log(failed ? "browser check FAILED" : "browser check passed");
process.exit(failed ? 1 : 0);
