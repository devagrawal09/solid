// @vitest-environment jsdom
//
// The frames applier (frames-client.mjs) and its integration with the
// islands entry: keyed morphs that hand an island's state to its new anchor
// (real compiler output, activated on the t0 helper), unkeyed islands that
// start over, island-frame refetches, client navigation into the outlet,
// the response cache and prefetch. documentation/plans/ssr-hydration-redesign.md,
// "Compiler-derived server components".
const fs = require("fs");
const path = require("path");
const { compileIslands } = require("../index.js");
const { islandsEntry, navModule, routeTable } = require("../islands-build.js");

const T0 = path.resolve(__dirname, "../../signals/dist/islands/t0.js");
const load = () => import("../frames-client.mjs");

const TOGGLE = `
import { $component, $event, $signal } from "solid-js";
export const Toggle = $component(function* (props) {
  const [open, setOpen] = yield* $signal(true);
  const toggle = $event(function* () { setOpen(o => !o); });
  return function* () {
    return <div class={["toggle", { open: yield* open }]}><a onClick={toggle}>{(yield* open) ? "[-]" : "[+]"}</a></div>;
  };
});
`;

/** The Toggle chunk (keyed state on), importable. */
async function toggleChunk() {
  const out = compileIslands(TOGGLE, { filename: "toggle.tsx", keyedState: true });
  const dir = path.join(__dirname, ".frames-tmp");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `chunk-${process.pid}.mjs`);
  fs.writeFileSync(file, out.chunks[0].code.replace('"@solidjs/signals/t0"', JSON.stringify(T0)));
  try {
    const chunk = await import(file);
    const t0 = await import(T0);
    return { chunk, flush: t0.flush, id: out.manifest.islands[0].id };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const toggleHtml = (id, key, extra = "") =>
  `<div data-i="${id}"${key == null ? "" : ` data-k="${key}"`} class="toggle open"><a>[-]</a></div>${extra}`;

/** The entry's activator (`self.$SI.act`) over one chunk. */
function installActivator(chunk, flush) {
  const acts = [];
  self.$SI = {
    act: (el, id, st) =>
      Promise.resolve().then(() => {
        (el.$i ||= {})[id] = 1;
        chunk.activate(el, st);
        flush();
        acts.push([id, el.getAttribute("data-k"), st]);
      })
  };
  return acts;
}

const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = "";
  delete self.$SI;
  window.scrollTo = () => {};
});

describe("keyed morph", () => {
  test("a keyed island keeps its state on its new anchor; an unkeyed one starts over", async () => {
    const { morph } = await load();
    const { chunk, flush, id } = await toggleChunk();
    const acts = installActivator(chunk, flush);
    document.body.innerHTML = `<ul data-f="Story-x" class="thread"><li>${toggleHtml(id, "7")}</li><li>${toggleHtml(id, null)}</li></ul>`;
    const region = document.querySelector("ul");
    const [keyed, unkeyed] = document.querySelectorAll("[data-i]");
    for (const a of [keyed, unkeyed]) {
      chunk.activate(a);
      (a.$i ||= {})[id] = 1;
    }
    // Collapse both.
    keyed.querySelector("a").click();
    unkeyed.querySelector("a").click();
    flush();
    expect(keyed.className).toBe("toggle");
    expect(unkeyed.className).toBe("toggle");
    let landed = 0;
    document.addEventListener("solid-islands", () => landed++);
    // The refetch: the server's HTML (both open again, new content around).
    morph(
      region,
      `<ul data-f="Story-x" class="thread fresh"><li>${toggleHtml(id, "7", "<p>new reply</p>")}</li><li>${toggleHtml(id, null)}</li></ul>`
    );
    await tick();
    // The region keeps its identity; attributes and content are the server's.
    expect(document.querySelector("ul")).toBe(region);
    expect(region.className).toBe("thread fresh");
    expect(region.querySelector("p").textContent).toBe("new reply");
    expect(landed).toBe(1);
    const [k2, u2] = document.querySelectorAll("[data-i]");
    expect(k2).not.toBe(keyed);
    // Keyed: activated with the old cells' values, holes applied.
    expect(acts).toEqual([[id, "7", [false]]]);
    expect(k2.className).toBe("toggle");
    expect(k2.textContent).toBe("[+]");
    // …and interactive on the new anchor.
    k2.querySelector("a").click();
    flush();
    expect(k2.className).toBe("toggle open");
    // Unkeyed: the server's state (open), not active until its first event.
    expect(u2.className).toBe("toggle open");
    expect(u2.$i).toBeUndefined();
  });

  test("a region that is itself an island's anchor is replaced", async () => {
    const { morph } = await load();
    document.body.innerHTML = `<div data-f="F" data-i="i0" class="a">old</div>`;
    const el = document.querySelector("div");
    const next = morph(el, `<div data-f="F" data-i="i0" class="b">new</div>`);
    expect(next).not.toBe(el);
    expect(document.querySelector("div").className).toBe("b");
  });
});

describe("island frames", () => {
  test("frame() fetches the declared-GET address with the arguments and drops stale responses", async () => {
    const { frame, configure, invalidate } = await load();
    configure({ endpoint: "/_server" });
    invalidate();
    const calls = [];
    const pending = [];
    global.fetch = vi.fn(u => {
      calls.push(u);
      return new Promise(r =>
        pending.push(() =>
          r({
            ok: true,
            text: async () => `<ul data-f="Search-1">${u.includes("b") ? "B" : "A"}</ul>`
          })
        )
      );
    });
    document.body.innerHTML = `<ul data-f="Search-1">first</ul>`;
    const el = document.querySelector("ul");
    const pa = frame(el, '["a"]');
    const pb = frame(el, '["b"]');
    expect(calls).toEqual([
      "/_server/Search-1?args=" + encodeURIComponent('["a"]'),
      "/_server/Search-1?args=" + encodeURIComponent('["b"]')
    ]);
    pending[1]();
    await pb;
    expect(el.textContent).toBe("B");
    pending[0]();
    await pa;
    expect(el.textContent).toBe("B");
  });
});

describe("navigation", () => {
  const routes = [
    [
      ["/", "/top"],
      "Stories-1",
      ({ location }) => [location.pathname.split("/")[1] || "top", Number(location.query.page) || 1]
    ],
    [["/stories/:id"], "Story-1", ({ params }) => [params.id]],
    [["/about"], null, null]
  ];
  let calls;
  beforeEach(async () => {
    const { invalidate } = await load();
    invalidate();
    calls = [];
    global.fetch = vi.fn(async u => {
      calls.push(decodeURIComponent(u));
      const id = /\/_server\/([^?]+)/.exec(u)[1];
      const args = JSON.parse(decodeURIComponent(u.split("args=")[1]));
      return {
        ok: true,
        text: async () => `<div data-f="${id}" class="v">${args.join(",")}</div>`
      };
    });
    history.replaceState(null, "", "/");
    document.body.innerHTML = `<header><a href="/">HN</a><a href="/stories/1">s</a></header><!--o--><div data-f="Stories-1" class="v">top,1</div><!--/o-->`;
    self.$SI = { links: vi.fn() };
  });

  test("another route's frame replaces the outlet; the same route's frame morphs", async () => {
    const { navigate } = await load();
    await navigate(routes, "/stories/42");
    expect(calls).toEqual(['/_server/Story-1?args=["42"]']);
    expect(location.pathname).toBe("/stories/42");
    expect(document.querySelector(".v").textContent).toBe("42");
    expect(self.$SI.links).toHaveBeenCalled();
    const el = document.querySelector(".v");
    await navigate(routes, "/stories/43");
    // Same frame: morphed in place.
    expect(document.querySelector(".v")).toBe(el);
    expect(el.textContent).toBe("43");
    // The header outside the outlet is untouched.
    expect(document.querySelector("header").children.length).toBe(2);
  });

  test("responses are cached (prefetch, history) and a route without a frame is a full load", async () => {
    const { navigate, prefetch } = await load();
    prefetch(routes, "/top?page=2");
    await tick();
    expect(calls).toEqual(['/_server/Stories-1?args=["top",2]']);
    await navigate(routes, "/top?page=2");
    expect(calls.length).toBe(1);
    expect(document.querySelector(".v").textContent).toBe("top,2");
    const assign = vi.fn();
    const loc = window.location;
    delete window.location;
    window.location = { ...loc, href: loc.href, origin: loc.origin, assign };
    try {
      navigate(routes, "/about");
      expect(assign).toHaveBeenCalledWith("http://localhost:3000/about");
    } finally {
      window.location = loc;
    }
  });

  test("match: params, optional segments and splats", async () => {
    const { match } = await load();
    expect(match("/stories/:id", "/stories/7")).toEqual({ id: "7" });
    expect(match("/stories/:id", "/stories")).toBe(null);
    expect(match("/a/:b?", "/a")).toEqual({});
    expect(match("/files/*rest", "/files/x/y")).toEqual({ rest: "x/y" });
    expect(match("/", "/top")).toBe(null);
  });
});

describe("islands entry with frames", () => {
  const island = {
    id: "i0",
    root: "Toggle",
    tier: 0,
    events: ["click"],
    windowEvents: [],
    activation: "lazy",
    anchor: "element",
    preventDefault: false,
    nests: false
  };
  test("the activator, the navigation interceptor and the router's link state", () => {
    const s = islandsEntry({ islands: [island], frames: { nav: true, prefetch: true } });
    expect(s).toContain('"i0": () => import("virtual:solid-islands/chunk/i0")');
    expect(s).toContain("self.$SI = { act: (el, id, st) =>");
    expect(s).toContain('const $nav = () => import("virtual:solid-frames/nav");');
    expect(s).toContain("$links();");
    expect(s).toContain('addEventListener("popstate"');
    expect(s).toContain('["pointerover", "focusin"]');
    // Eager islands activate on each landing, as streamed boundaries do.
    const e = islandsEntry({
      islands: [{ ...island, activation: "load" }],
      frames: { nav: false }
    });
    expect(e).toContain('document.addEventListener("solid-islands", $act);');
    expect(e).not.toContain("$nav");
    // Without frames the entry is unchanged.
    expect(islandsEntry({ islands: [island] })).not.toContain("$SI");
  });

  test("the navigation module: the route table from the manifests", () => {
    const collected = {
      routers: [
        {
          file: "/app/src/app.tsx",
          router: {
            routes: [{ paths: ["/x"], component: "X", module: "./routes/x", preload: true }]
          }
        }
      ],
      frames: [{ id: "X-1", driver: "route", file: "/app/src/routes/x.tsx" }],
      framesClient: new Map([["/app/src/routes/x.tsx", "export const $$routeArgs = {};"]])
    };
    const fsExists = fs.existsSync;
    const fsStat = fs.statSync;
    fs.existsSync = f => f === "/app/src/routes/x.tsx" || fsExists(f);
    fs.statSync = f => (f === "/app/src/routes/x.tsx" ? { isFile: () => true } : fsStat(f));
    try {
      const t = routeTable(collected);
      expect(t).toMatchObject([
        { paths: ["/x"], frame: "X-1", argsFile: "/app/src/routes/x.tsx", preload: true }
      ]);
      const m = navModule(t);
      expect(m).toContain(
        'import { $$routeArgs as r0 } from "/app/src/routes/x.tsx?solid-frames-args";'
      );
      expect(m).toContain('[["/x"], "X-1", r0["X-1"]]');
    } finally {
      fs.existsSync = fsExists;
      fs.statSync = fsStat;
    }
  });
});

// --- disposal of swapped-out islands ------------------------------------------------------

const KERNEL = path.resolve(__dirname, "../../signals/dist/islands/kernel.js");

// A tier-1 island that runs a timer (started at load, stopped by its
// `$cleanup`), keyed by its anchor's `data-k`.
const TICKER = `
import { $component, $event, $signal, $settled, $cleanup } from "solid-js";
export const Ticker = $component(function* (props) {
  const [n, setN] = yield* $signal(0);
  const tick = $event(function* () { setN(x => x + 1); });
  yield* $settled(function* () {
    const id = setInterval(tick, 4);
    yield* $cleanup(() => { clearInterval(id); self.cleanups.push(props.name); });
  });
  return function* () { return <p class="ticker">{yield* n}</p>; };
});
`;

async function tickerChunk() {
  const out = compileIslands(TICKER, { filename: "ticker.tsx", keyedState: true });
  const [island] = out.manifest.islands;
  expect(island.tier).toBe(1);
  const dir = path.join(__dirname, ".frames-tmp");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `ticker-${process.pid}.mjs`);
  fs.writeFileSync(
    file,
    out.chunks[0].code.replace('"@solidjs/signals/kernel"', JSON.stringify(KERNEL))
  );
  try {
    const chunk = await import(file);
    return { chunk, id: island.id };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tickerHtml = (id, key, name) =>
  `<p data-i="${id}" data-k="${key}" data-s='${JSON.stringify({ [id]: { name } })}' class="ticker">0</p>`;

/** The entry's activation (`$sd`): the root disposer kept on the anchor. */
function activateKept(chunk, el, id, st) {
  (el.$i ||= {})[id] = 1;
  const d = chunk.activate(el, st);
  if (typeof d === "function") (el.$d ||= {})[id] = d;
  chunk.flush();
}

const wait = ms => new Promise(r => setTimeout(r, ms));

describe("disposal of swapped-out islands", () => {
  beforeEach(() => {
    self.cleanups = [];
  });

  test("a refetch disposes the old island (cleanup, timer) and its keyed state transplants", async () => {
    const { morph, dispose } = await load();
    const { chunk, id } = await tickerChunk();
    const acts = [];
    self.$SI = {
      act: (el, i, st) =>
        Promise.resolve().then(() => {
          activateKept(chunk, el, i, st);
          acts.push([i, el.getAttribute("data-k"), st]);
        })
    };
    document.body.innerHTML = `<ul data-f="Lake-1"><li>${tickerHtml(id, "7", "A")}</li></ul>`;
    const region = document.querySelector("ul");
    const old = region.querySelector("p");
    activateKept(chunk, old, id);
    await wait(40);
    const ticked = Number(old.textContent);
    expect(ticked).toBeGreaterThan(0);
    // The lake refetches: the server's HTML starts the ticker at 0 again.
    morph(region, `<ul data-f="Lake-1"><li>${tickerHtml(id, "7", "A")}</li></ul>`);
    // The old island is disposed: its cleanup ran, once, and its timer stopped.
    expect(self.cleanups).toEqual(["A"]);
    expect(old.$d).toBe(null);
    const frozen = old.textContent;
    await wait(30);
    expect(old.textContent).toBe(frozen);
    // The keyed island's state moved to its new anchor, which ticks on.
    const next = region.querySelector("p");
    expect(next).not.toBe(old);
    expect(acts.length).toBe(1);
    expect(acts[0][0]).toBe(id);
    expect(acts[0][1]).toBe("7");
    expect(acts[0][2][0]).toBeGreaterThanOrEqual(ticked);
    await wait(30);
    expect(Number(next.textContent)).toBeGreaterThan(acts[0][2][0]);
    // Disposing the new one (as a later swap would) stops it too.
    dispose([region]);
    expect(self.cleanups).toEqual(["A", "A"]);
    const last = next.textContent;
    await wait(20);
    expect(next.textContent).toBe(last);
  });

  test("a navigation disposes the islands of the outlet it replaces", async () => {
    const { navigate, invalidate } = await load();
    const { chunk, id } = await tickerChunk();
    invalidate();
    global.fetch = vi.fn(async () => ({
      ok: true,
      text: async () => `<div data-f="About-1">about</div>`
    }));
    history.replaceState(null, "", "/");
    self.$SI = { links: () => {} };
    document.body.innerHTML = `<!--o--><div data-f="Home-1">${tickerHtml(id, "1", "home")}</div><!--/o-->`;
    const p = document.querySelector("p");
    activateKept(chunk, p, id);
    await wait(20);
    await navigate([[["/about"], "About-1", () => []]], "/about");
    expect(document.querySelector("[data-f]").textContent).toBe("about");
    expect(self.cleanups).toEqual(["home"]);
    const frozen = p.textContent;
    await wait(20);
    expect(p.textContent).toBe(frozen);
  });

  test("a tier-0 island keeps no disposer; disposing its subtree is harmless", async () => {
    const { dispose } = await load();
    const { chunk, flush, id } = await toggleChunk();
    document.body.innerHTML = `<ul>${toggleHtml(id, "1")}</ul>`;
    const a = document.querySelector("[data-i]");
    expect(chunk.activate(a)).toBeUndefined();
    flush();
    expect(a.$d).toBeUndefined();
    expect(() => dispose([document.querySelector("ul")])).not.toThrow();
  });
});
