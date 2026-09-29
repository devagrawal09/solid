#!/usr/bin/env node
// Compiler-derived server components, gated and measured against the
// hand-written ones (documentation/plans/ssr-hydration-redesign.md,
// "Compiler-derived server components"):
//
//   examples/hackernews            hand-written "use server" components (frames runtime)
//   examples/hackernews-sc-blocks  the same app in generator blocks v2, no "use server"
//                                  on markup: the compiler derives the frames
//
// Both are built (`pnpm build` in each) and served by their own server.js,
// with the HN APIs answered by fixtures (hn-fixtures.mjs). In Chromium the
// gate loads the story list, a story and a user page, then navigates between
// them on the client (link clicks, history back, the next feed page), and
// compares the canonical DOM of the two apps after every step (markers,
// island / frame attributes, hydration keys and the frames runtime's
// `<solid-frame>` wrappers removed; styles through CSSOM). It also checks
// that a keyed toggle keeps its state across a refetch of its frame.
//
//   node scripts/ssr-redesign/sc-gate.mjs            # gate + measurements
//   node scripts/ssr-redesign/sc-gate.mjs --check    # gate only
//   node scripts/ssr-redesign/sc-gate.mjs --reps 7 --out file.json
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gz, kb, launchChromium, median, ROOT } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const CHECK = args.includes("--check");
const REPS = Number(opt("reps", 5));
const APPS = { hackernews: 3321, "hackernews-sc-blocks": 3322 };
const FIXTURES = join(ROOT, "scripts/ssr-redesign/hn-fixtures.mjs");
const STORY = "/stories/30186326";
const USER = "/users/lxm"; // the captured story's author

const servers = [];
async function serve(app, port) {
  const srv = spawn(process.execPath, ["--import", FIXTURES, "server.js"], {
    cwd: join(ROOT, "examples", app),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "ignore", "inherit"]
  });
  servers.push(srv);
  const base = `http://localhost:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(base + "/users/x");
      return base;
    } catch {
      await new Promise(r => setTimeout(r, 100));
    }
  }
  throw new Error(`${app} did not start`);
}

/** The canonical DOM of the page body (see the header comment). */
function canonical() {
  const skip = new Set(["script", "template", "link", "style", "meta"]);
  const walk = n => {
    // Text the parser moved into the body from after it (the document's
    // trailing newlines) is not the app's.
    if (n.nodeType === 3) return n.parentNode === document.body && !n.data.trim() ? "" : n.data;
    if (n.nodeType !== 1) return "";
    const tag = n.localName;
    if (skip.has(tag)) return "";
    const kids = [...n.childNodes].map(walk).join("");
    if (tag === "solid-frame") return kids;
    // Link state inside the route's content is compared only in the nav:
    // the hand-written frames runtime does not claim anchors its morphs
    // create, so @solidjs/router leaves their aria-current unset or stale;
    // the compiled app applies the router's rule to every managed link.
    const outside = n.closest("header.header");
    const attrs = [...n.attributes]
      .filter(a => !a.name.startsWith("data-") && a.name !== "_hk")
      .filter(a => a.name !== "aria-current" || outside)
      .map(a => (a.name === "style" ? `style="${n.style.cssText}"` : `${a.name}="${a.value}"`))
      .sort()
      .join(" ");
    return `<${tag}${attrs ? " " + attrs : ""}>${kids}</${tag}>`;
  };
  return walk(document.body);
}

const ready = {
  list: () => document.querySelectorAll(".news-item").length > 0,
  story: () => document.querySelectorAll(".item-view .toggle a").length > 3,
  user: () => !!document.querySelector(".user-view h1")
};

/** What the target page shows once its content has landed (the URL moves first). */
function expected(what, path) {
  const u = new URL(path, "http://x");
  if (what === "list") {
    const feed = { "": 0, top: 0, new: 1, show: 2, ask: 3, job: 4 }[u.pathname.split("/")[1]];
    const n = Number(u.searchParams.get("page")) || 1;
    return feed === 0 && n === 1 ? "Facebook loses users for the first time" : `Fixture story ${feed * 1000 + n * 100}`;
  }
  if (what === "user") return `User : ${u.pathname.split("/")[2]}`;
  return "Facebook loses users for the first time";
}

async function settle(page, what, path) {
  await page.waitForFunction(
    ([w, p, text]) =>
      location.pathname + location.search === p &&
      {
        list: () => document.querySelector(".news-item .title a")?.textContent === text,
        story: () =>
          document.querySelectorAll(".item-view .toggle a").length > 3 &&
          document.querySelector(".item-view h1")?.textContent === text,
        user: () => document.querySelector(".user-view h1")?.textContent === text
      }[w]() &&
      !document.body.textContent.includes("Loading..."),
    [what, path, expected(what, path)],
    { timeout: 20000 }
  );
  await page.waitForLoadState("networkidle");
}

/** One app's session: full loads, then client navigations. */
async function session(browser, base) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  let requests = [];
  page.on("request", r => requests.push(r.url().replace(base, "")));
  const snaps = [];
  const snap = async name => snaps.push({ name, dom: await page.evaluate(canonical) });
  for (const [path, what] of [
    ["/", "list"],
    [STORY, "story"],
    [USER, "user"]
  ]) {
    await page.goto(base + path, { waitUntil: "load" });
    await settle(page, what, path);
    await snap(`load ${path}`);
  }
  const navs = [];
  const nav = async (name, act, what, path) => {
    requests = [];
    await act();
    await settle(page, what, path);
    // A client navigation keeps the document: no document request.
    const doc = requests.filter(u => !u.includes(".") && !u.startsWith("/_server") && !u.startsWith("/assets"));
    navs.push({ name, requests: [...requests], documentLoads: doc.length });
    await snap(name);
  };
  await page.goto(base + "/", { waitUntil: "load" });
  await settle(page, "list", "/");
  await nav("list → story", () => page.click(`a[href="${STORY}"]`), "story", STORY);
  await nav("story → user", () => page.click(`.item-view-header a[href="${USER}"]`), "user", USER);
  await nav("user → new", () => page.click(`nav a[href="/new"]`), "list", "/new");
  await nav("new → page 2", () => page.click(`a[aria-label="Next Page"]`), "list", "/new?page=2");
  await nav("back → new", () => page.goBack(), "list", "/new");
  await nav("back → user", () => page.goBack(), "user", USER);
  await nav("user → top", () => page.click(`nav a[href="/"]`), "list", "/");
  await nav("top → story", () => page.click(`a[href="${STORY}"]`), "story", STORY);
  await context.close();
  return { snaps, navs, errors };
}

/** A keyed toggle keeps its state across a refetch (same arguments) of its frame. */
async function keyed(browser, base) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(base + STORY, { waitUntil: "load" });
  await settle(page, "story", STORY);
  const before = await page.evaluate(async () => {
    const a = document.querySelectorAll(".toggle a")[2];
    a.click();
    await new Promise(r => setTimeout(r, 50));
    return a.parentElement.className;
  });
  // A refetch of the story's frame (same arguments): history re-navigation.
  await page.evaluate(() => {
    history.pushState(null, "", location.href);
    history.back();
  });
  await page.waitForTimeout(500);
  await page.waitForLoadState("networkidle");
  const after = await page.evaluate(() => ({
    cls: document.querySelectorAll(".toggle a")[2].parentElement.className,
    text: document.querySelectorAll(".toggle a")[2].textContent
  }));
  // Still interactive after the refetch.
  const again = await page.evaluate(async () => {
    const a = document.querySelectorAll(".toggle a")[2];
    a.click();
    await new Promise(r => setTimeout(r, 50));
    return a.parentElement.className;
  });
  await page.context().close();
  return { before, after, again };
}

/** Page anatomy and JS at load / on the first navigation. */
async function measure(browser, base) {
  const out = {};
  for (const [path, what] of [
    ["/", "list"],
    [STORY, "story"]
  ]) {
    const html = await (await fetch(base + path, { headers: { "accept-encoding": "identity" } })).text();
    const renders = [];
    for (let i = 0; i < REPS; i++) {
      const t = performance.now();
      await (await fetch(base + path, { headers: { "accept-encoding": "identity" } })).text();
      renders.push(performance.now() - t);
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    const js = new Map();
    let phase = "load";
    const frames = [];
    page.on("response", async res => {
      const u = res.url();
      if (u.endsWith(".js")) js.set(u, phase);
      else if (phase !== "load" && res.request().resourceType() === "fetch") frames.push(u);
    });
    await page.goto(base + path, { waitUntil: "load" });
    await settle(page, what, path);
    phase = "nav";
    const target = what === "list" ? STORY : USER;
    const selector = what === "list" ? `a[href="${STORY}"]` : `.item-view-header a[href="${USER}"]`;
    await page.click(selector);
    await settle(page, what === "list" ? "story" : "user", target);
    await context.close();
    const size = async u => gz(await (await fetch(u, { headers: { "accept-encoding": "identity" } })).text());
    let load = 0,
      nav = 0;
    for (const [u, p] of js) (p === "load" ? (load += await size(u)) : (nav += await size(u)));
    let framesGz = 0;
    for (const u of frames) if (u.includes("/_server")) framesGz += await size(u);
    out[path] = {
      htmlGz: gz(html),
      htmlBytes: Buffer.byteLength(html),
      jsLoadGz: load,
      jsNavGz: nav,
      navResponsesGz: framesGz,
      navRequests: frames.length + [...js.values()].filter(p => p === "nav").length,
      serverMs: median(renders)
    };
  }
  return out;
}

const browser = await launchChromium();
let failed = false;
const result = { apps: {} };
try {
  const bases = {};
  for (const [app, port] of Object.entries(APPS)) bases[app] = await serve(app, port);
  const sessions = {};
  for (const app of Object.keys(APPS)) sessions[app] = await session(browser, bases[app]);
  const [a, b] = Object.keys(APPS);
  for (let i = 0; i < sessions[a].snaps.length; i++) {
    const x = sessions[a].snaps[i],
      y = sessions[b].snaps[i];
    const ok = x.dom === y.dom;
    if (!ok) {
      failed = true;
      let k = 0;
      while (x.dom[k] === y.dom[k]) k++;
      console.log(`✗ ${x.name}: DOM differs at ${k}\n  ${a}: …${x.dom.slice(Math.max(0, k - 120), k + 200)}\n  ${b}: …${y.dom.slice(Math.max(0, k - 120), k + 200)}`);
    } else console.log(`✓ ${x.name}: same DOM (${(x.dom.length / 1024).toFixed(1)} KB)`);
  }
  for (const app of Object.keys(APPS)) {
    const s = sessions[app];
    if (s.errors.length) {
      failed = true;
      console.log(`✗ ${app}: page errors ${s.errors.join(" | ")}`);
    }
    for (const n of s.navs)
      if (n.documentLoads) {
        failed = true;
        console.log(`✗ ${app}: ${n.name} reloaded the document`);
      }
    result.apps[app] = { navs: s.navs.map(n => ({ name: n.name, requests: n.requests.length, urls: n.requests })) };
    console.log(`  ${app}: requests per navigation ${s.navs.map(n => `${n.name} ${n.requests.length}`).join(", ")}`);
  }
  const k = await keyed(browser, bases["hackernews-sc-blocks"]);
  const kept = k.before === k.after.cls && /collapsed/.test(k.after.text) && k.again !== k.after.cls;
  if (!kept) failed = true;
  console.log(`${kept ? "✓" : "✗"} keyed toggle across a refetch of its frame: ${JSON.stringify(k)}`);
  result.keyed = k;
  if (!CHECK)
    for (const app of Object.keys(APPS)) {
      const m = await measure(browser, bases[app]);
      result.apps[app].measure = m;
      for (const [p, v] of Object.entries(m))
        console.log(
          `  ${app.padEnd(22)} ${p.padEnd(18)} HTML ${kb(v.htmlGz)} KB gz | JS at load ${kb(v.jsLoadGz)} KB gz | JS on first navigation ${kb(v.jsNavGz)} KB gz (+ ${kb(v.navResponsesGz)} KB gz of responses, ${v.navRequests} requests) | server ${v.serverMs.toFixed(1)} ms`
        );
    }
} finally {
  await browser.close();
  for (const s of servers) s.kill();
}
if (opt("out")) writeFileSync(opt("out"), JSON.stringify(result, null, 2) + "\n");
if (failed) {
  console.log("gate: FAIL");
  process.exit(1);
}
console.log("gate: ok");
