// @vitest-environment jsdom
//
// Delegated island handlers (island_emit/client.rs, the `$dg` helper):
// Solid's delegated events are bound as `node.$$type = h`, and one listener
// per event type on the document runs every island handler on the event's
// path, from the target up, so a click reaching nested islands (even on
// different runtimes) runs all their handlers in one listener and the page
// flushes once (documentation/plans/island-runtime-tiers.md, section 7; the
// browser check is scripts/island-tiers/native-event.mjs). Real compiler
// output on the t0 helper and the kernel.
const fs = require("fs");
const path = require("path");
const { compileIslands } = require("../index.js");

const RUNTIMES = {
  "@solidjs/signals/t0": path.resolve(__dirname, "../../signals/dist/islands/t0.js"),
  "@solidjs/signals/kernel": path.resolve(__dirname, "../../signals/dist/islands/kernel.js")
};

const OUTER = `
import { $component, $event, $signal } from "solid-js";
export const Outer = $component(function* (props) {
  const [a, setA] = yield* $signal(1);
  const inc = $event(function* (e) { setA(x => x + 1); self.calls.push("outer " + e.currentTarget.className); });
  return function* () {
    return <div class="outer" onClick={inc}><p>{yield* a}</p>{props.children}</div>;
  };
});
`;
const INNER = `
import { $component, $effect, $event, $signal } from "solid-js";
export const Inner = $component(function* (props) {
  const [b, setB] = yield* $signal(10);
  const inc = $event(function* (e) {
    setB(x => x + 10);
    self.calls.push("inner " + e.currentTarget.className);
    if (self.stop) e.stopPropagation();
  });
  yield* $effect(function* () {
    const v = yield* b;
    if (v !== 10) self.calls.push("effect sees outer " + document.querySelector(".outer p").textContent);
  });
  return function* () { return <button class="inner" onClick={inc}>{yield* b}</button>; };
});
`;

let n = 0;
async function chunkOf(src, idPrefix) {
  const out = compileIslands(src, { filename: `${idPrefix}.tsx`, idPrefix });
  expect(out.fallback).toBe(null);
  const [island] = out.manifest.islands;
  let code = out.chunks[0].code;
  for (const [spec, file] of Object.entries(RUNTIMES))
    code = code.replace(JSON.stringify(spec), JSON.stringify(file));
  const dir = path.join(__dirname, ".delegation-tmp");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${idPrefix}-${process.pid}-${n++}.mjs`);
  fs.writeFileSync(file, code);
  try {
    return { chunk: await import(file), island, code };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const tick = () => new Promise(r => setTimeout(r, 0));

async function page(extra = "") {
  const outer = await chunkOf(OUTER, "o");
  const inner = await chunkOf(INNER, "n");
  document.body.innerHTML = `<div class="outer" data-i="${outer.island.id}"><p>1</p>${extra}<button class="inner" data-i="${inner.island.id}">10</button></div>`;
  const add = vi.spyOn(document, "addEventListener");
  outer.chunk.activate(document.querySelector(".outer"));
  inner.chunk.activate(document.querySelector(".inner"));
  inner.chunk.flush();
  const clicks = add.mock.calls.filter(c => c[0] === "click").length;
  add.mockRestore();
  return { outer, inner, clicks };
}

beforeEach(() => {
  self.calls = [];
  self.stop = false;
});

describe("delegated island handlers", () => {
  test("one document listener runs both nested islands' handlers, inner first; one flush after", async () => {
    const { outer, clicks } = await page();
    expect(outer.code).toContain(".$$click = inc;");
    expect(outer.code).not.toContain('addEventListener("click"');
    // One listener per type for the page (earlier tests' may already be there).
    expect(clicks).toBeLessThanOrEqual(1);
    expect([...document.$$E]).toContain("click");
    document.querySelector(".inner").click();
    await tick();
    expect(self.calls).toEqual(["inner inner", "outer outer", "effect sees outer 2"]);
    expect(document.querySelector(".outer p").textContent).toBe("2");
    expect(document.querySelector(".inner").textContent).toBe("20");
  });

  test("stopPropagation in an inner handler stops the walk", async () => {
    await page();
    self.stop = true;
    document.querySelector(".inner").click();
    await tick();
    expect(self.calls).toEqual(["inner inner", "effect sees outer 1"]);
    expect(document.querySelector(".outer p").textContent).toBe("1");
  });

  test("a Solid root below resumes the walk above it: its handlers run once", async () => {
    // A Solid delegation root (a hydrated fallback module) inside the outer
    // island: its container listener walks its own nodes, then marks the
    // event (`_$SOLID_EVENT_OWNER`, Solid's nested-root protocol).
    await page(`<section class="solid-root"><a class="solid">x</a></section>`);
    const root = document.querySelector(".solid-root");
    const link = document.querySelector(".solid");
    let solidRuns = 0;
    link.$$click = () => solidRuns++;
    root.addEventListener("click", e => {
      if (e.target === link) link.$$click(e);
      e._$SOLID_EVENT_OWNER = root;
    });
    link.click();
    await tick();
    expect(solidRuns).toBe(1);
    // The island above the Solid root still sees the event.
    expect(self.calls).toEqual(["outer outer"]);
  });
});
