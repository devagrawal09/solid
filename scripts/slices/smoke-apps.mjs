#!/usr/bin/env node
// Core runtime slicing — do the SLICED production bundles run?
// (documentation/plans/core-runtime-slicing.md, "Landed").
//
//   node scripts/slices/smoke-apps.mjs [--examples a,b]
//
// Dev and test builds resolve the flat dev runtime, where every feature
// switch is on, so the example test suites never execute a slice. This
// builds each example with `vite build` and the capability linker (feature
// slicing and compiled facts on), loads the emitted chunks in jsdom, and
// drives the app's main flow. A wrong proof fails loudly (`[FEATURE_EXCLUDED]`,
// or a missing accessor iterator) or renders the wrong DOM. Needs
// packages/{signals,solid,web} and the native compiler built.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const only = args.includes("--examples") ? args[args.indexOf("--examples") + 1].split(",") : null;

const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
async function until(check, what, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try {
      ok = check();
    } catch {}
    if (ok) return;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick(10);
  }
}

// TodoMVC flow shared by todos and todos-blocks.
async function todoFlow(doc, win) {
  const input = () => doc.querySelector("input.new-todo");
  await until(() => input(), "the new-todo input");
  // Past the initial load (`Loading` fallback).
  await until(
    () => doc.querySelector("section.main, .todo-list, footer") || true,
    "the list",
    2000
  );
  for (const title of ["write proofs", "measure"]) {
    input().value = title;
    input().dispatchEvent(new win.Event("input", { bubbles: true }));
    input().dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await tick(20);
  }
  await until(() => doc.querySelectorAll(".todo-list li").length === 2, "two rows");
  await until(() => /2/.test(doc.querySelector(".todo-count")?.textContent ?? ""), "count 2");
  doc.querySelector(".todo-list li input.toggle").click();
  await until(() => /1/.test(doc.querySelector(".todo-count")?.textContent ?? ""), "count 1", 5000);
  return `rows: ${doc.querySelectorAll(".todo-list li").length}, count: "${doc.querySelector(".todo-count").textContent.trim()}"`;
}

// The TodoMVC flow, then the hash filter (`createHashFilter`'s settled
// listener): two rows, one completed; `#/completed` shows one row.
async function todoFlowWithFilter(doc, win) {
  const detail = await todoFlow(doc, win);
  win.location.hash = "#/completed";
  win.dispatchEvent(new win.HashChangeEvent("hashchange"));
  await until(() => doc.querySelectorAll(".todo-list li").length === 1, `the completed filter (${win.location.hash}, rows ${doc.querySelectorAll(".todo-list li").length}, footer ${doc.querySelector("footer")?.outerHTML.slice(0, 400)})`);
  return `${detail}, #/completed rows: ${doc.querySelectorAll(".todo-list li").length}`;
}

const EXAMPLES = {
  "sync-blocks": {
    entry: "src/main.tsx",
    typedSummary: ".solid-capabilities.json",
    async flow(doc, win) {
      const add = async title => {
        const draft = doc.querySelector("input.draft");
        draft.value = title;
        draft.dispatchEvent(new win.InputEvent("input", { bubbles: true }));
        await tick();
        doc
          .querySelector("form.add")
          .dispatchEvent(new win.SubmitEvent("submit", { bubbles: true, cancelable: true }));
        await tick();
      };
      await add("write proofs");
      await add("measure");
      await until(
        () => doc.querySelector(".count")?.textContent === "2 items left",
        "2 items left"
      );
      doc
        .querySelectorAll("li label")[1]
        .dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      await until(() => doc.querySelector(".count")?.textContent === "1 item left", "1 item left");
      doc.querySelector("button.show-done").click();
      await until(() => doc.querySelectorAll("li").length === 1, "the done filter");
      doc.querySelector("button.warmer").click();
      await until(() => /25°C/.test(doc.querySelector(".converter span")?.textContent), "25°C");
      return `items: ${doc.querySelectorAll("li").length}, converter: "${doc.querySelector(".converter span").textContent}"`;
    }
  },
  "todos-blocks": { entry: "src/main.tsx", flow: todoFlowWithFilter },
  // A mixed app (blocks-v2-performance.md §11): the same example with its
  // `.ts` modules left to the runtime (the Solid plugin's default
  // extensions), so filter.ts's `onSettled(function* …)` reaches an
  // otherwise driver-free bundle uncompiled. The linker installs the block
  // driver in that module and warns; without it the listener never attaches.
  "todos-blocks-mixed": {
    dir: "todos-blocks",
    entry: "src/main.tsx",
    uncompiledTs: true,
    flow: todoFlowWithFilter,
    expectWarning: /src\/filter\.ts:\d+: a generator body handed to `onSettled` was left uncompiled/
  },
  todos: { entry: "src/main.tsx", flow: todoFlow },
  sierpinski: {
    entry: "src/main.tsx",
    async flow(doc) {
      await until(() => doc.body.querySelectorAll("div").length > 10, "the triangle");
      return `dots: ${doc.body.querySelectorAll("div").length}`;
    }
  }
};

async function smoke(name, spec) {
  const dir = join(ROOT, "examples", spec.dir ?? name);
  const require = createRequire(join(dir, "package.json"));
  const { build } = await import(require.resolve("vite"));
  const { JSDOM } = require(
    require.resolve("jsdom", { paths: [dir, join(ROOT, "examples/sync-blocks")] })
  );
  const { solidCapabilities } = createRequire(import.meta.url)(
    join(ROOT, "packages/compiler/capabilities.js")
  );
  process.env.SOLID_CAPABILITIES = "0";
  const reportFile = join(ROOT, "node_modules/.cache/slices", `${name}.smoke.report.json`);
  const warnings = [];
  const solidPlugin = spec.uncompiledTs
    ? await import(pathToFileURL(require.resolve("@solidjs/vite-plugin")).href).then(m => (typeof m.default === "function" ? m.default : m.default.default))
    : null;
  const capabilities = solidCapabilities({
    entries: [spec.entry],
    typedSummary: spec.typedSummary,
    report: reportFile
  });
  const result = await build({
    root: dir,
    // The mixed variant: the Solid plugin with its default extensions (no
    // `.ts`), in place of the example's own configuration.
    configFile: spec.uncompiledTs
      ? false
      : ["vite.config.mjs", "vite.config.ts", "vite.config.js"]
          .map(f => join(dir, f))
          .find(existsSync),
    logLevel: "warn",
    plugins: spec.uncompiledTs
      ? [solidPlugin(), capabilities]
      : [capabilities],
    build: {
      write: false,
      reportCompressedSize: false,
      modulePreload: false,
      rollupOptions: {
        onwarn(warning, warn) {
          warnings.push(String(warning.message ?? warning));
          warn(warning);
        }
      }
    }
  });
  const report = JSON.parse(readFileSync(reportFile, "utf8"));
  const off = Object.keys(report.features).filter(f => !report.features[f].on);
  const out = mkdtempSync(join(tmpdir(), `solid-smoke-${name}-`));
  let entry = null;
  for (const o of (Array.isArray(result) ? result : [result]).flatMap(r => r.output)) {
    const file = join(out, o.fileName);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, o.type === "chunk" ? o.code : o.source);
    if (o.type === "chunk" && o.isEntry) entry = file;
  }
  const dom = new JSDOM(`<!doctype html><html><body><div id="root"></div></body></html>`, {
    url: "http://localhost/",
    pretendToBeVisual: true
  });
  const errors = [];
  const g = globalThis;
  const expose = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    location: dom.window.location,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    // jsdom has no idle callbacks (sierpinski's async memos use them).
    requestIdleCallback: cb => setTimeout(() => cb({ timeRemaining: () => 1 }), 1),
    cancelIdleCallback: id => clearTimeout(id)
  };
  for (const key of Object.getOwnPropertyNames(dom.window))
    if (!(key in g) && /^[A-Z]/.test(key)) expose[key] = dom.window[key];
  for (const [key, value] of Object.entries(expose))
    Object.defineProperty(g, key, { value, configurable: true, writable: true });
  const random = Math.random;
  // todos' fake API fails a third of its writes at random: keep the flow deterministic.
  Math.random = () => 0.5;
  const onError = e => errors.push(e?.error ?? e);
  process.on("unhandledRejection", onError);
  dom.window.addEventListener("error", onError);
  try {
    await import(pathToFileURL(entry).href);
    let detail = await spec.flow(dom.window.document, dom.window);
    if (errors.length) throw errors[0];
    if (spec.expectWarning) {
      if (!warnings.some(w => spec.expectWarning.test(w)))
        throw new Error(`no driver-install warning (warnings: ${JSON.stringify(warnings)})`);
      detail += `, driver installed for ${report.driverInstalls.map(d => `${d.file}:${d.line}`).join(", ")}`;
    }
    return { ok: true, off, detail };
  } catch (error) {
    return {
      ok: false,
      off,
      detail: String(error?.stack ?? error)
        .split("\n")
        .slice(0, 3)
        .join(" | ")
    };
  } finally {
    // The child process exits next; the window stays up for the app's
    // pending timers.
    Math.random = random;
    process.off("unhandledRejection", onError);
    rmSync(out, { recursive: true, force: true });
  }
}

// Each example runs in its own process: an app's pending timers must not
// outlive its window into the next one.
if (args.includes("--child")) {
  const name = args[args.indexOf("--child") + 1];
  const r = await smoke(name, EXAMPLES[name]);
  process.stdout.write(`\n@@RESULT ${JSON.stringify(r)}\n`);
  process.exit(0);
}
const { spawnSync } = await import("node:child_process");
let failed = 0;
console.log("| example | switched off | result |\n| --- | --- | --- |");
for (const name of Object.keys(EXAMPLES)) {
  if (only && !only.includes(name)) continue;
  const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", name], {
    encoding: "utf8",
    maxBuffer: 1 << 26
  });
  const line = /@@RESULT (.*)/.exec(child.stdout ?? "")?.[1];
  const r = line
    ? JSON.parse(line)
    : { ok: false, off: [], detail: `no result (${(child.stderr ?? "").split("\n")[0]})` };
  if (!r.ok) failed++;
  console.log(
    `| ${name} | ${r.off.join(", ") || "none"} | ${r.ok ? "ok" : "FAILED"}: ${r.detail} |`
  );
}
process.exit(failed ? 1 : 0);
