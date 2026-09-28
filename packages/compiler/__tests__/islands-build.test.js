// Compiled islands: the JS surface (`compileIslands`) and the build glue
// (`islandsEntry`: loader, eager activation, prefetch policies, fallback
// hydration). The partitioner and emitters are unit-tested in Rust
// (src/island_emit/tests.rs); behavior is proven in the web package's
// conformance islands mode and the ssr-redesign browser gate.
const { compileIslands } = require("../index.js");
const { islandsEntry, IslandsCompiler } = require("../islands-build.js");
const fs = require("fs");
const os = require("os");
const path = require("path");

const TOGGLE = `
import { $component, $event, $signal } from "solid-js";
// @island-prefetch intent
export const Toggle = $component(function* (props) {
  const [open, setOpen] = yield* $signal(true);
  const toggle = $event(function* () { setOpen(o => !o); });
  return function* () {
    return <div class={{ open: yield* open }}><a onClick={toggle}>{(yield* open) ? "-" : "+"}</a>{props.children}</div>;
  };
});
`;

describe("compileIslands", () => {
  test("returns the server module, one chunk per island and the manifest", () => {
    const out = compileIslands(TOGGLE, { filename: "toggle.tsx" });
    expect(out.fallback).toBe(null);
    expect(out.chunks.map(c => c.id)).toEqual(["i0"]);
    const [island] = out.manifest.islands;
    expect(island).toMatchObject({
      id: "i0",
      root: "Toggle",
      tier: 0,
      events: ["click"],
      anchor: "element",
      activation: "lazy",
      prefetch: "intent"
    });
    expect(out.server).toContain('data-i="i0"');
    expect(out.chunks[0].code).toContain('from "@solidjs/signals/t0"');
  });

  test("runtime specifiers and id prefixes are options", () => {
    const out = compileIslands(TOGGLE, { filename: "toggle.tsx", idPrefix: "t", t0Module: "rt0" });
    expect(out.manifest.islands[0].id).toBe("t0");
    expect(out.chunks[0].code).toContain('from "rt0"');
  });

  test("a module the compiler cannot compile falls back to the hydratable outputs", () => {
    const out = compileIslands(
      `import { $component, $signal, $event } from "solid-js";
export const App = $component(function* () {
  const [on, set] = yield* $signal(false);
  const flip = $event(function* () { set(x => !x); });
  return function* () { return <button onClick={flip}>{(yield* on) ? <b>on</b> : <i>off</i>}</button>; };
});`,
      { filename: "app.tsx" }
    );
    expect(out.fallback).toMatch(/live expression producing JSX/);
    expect(out.manifest.fallback).toBe(out.fallback);
    expect(out.client).toContain("getNextElement");
    expect(out.chunks).toEqual([]);
  });
});

describe("islandsEntry", () => {
  const island = {
    id: "i0",
    root: "Toggle",
    tier: 0,
    events: ["click"],
    windowEvents: [],
    activation: "lazy",
    anchor: "element",
    preventDefault: false,
    nests: false,
    size: 500
  };

  test("lazy islands get the loader, no static chunk import", () => {
    const s = islandsEntry({ islands: [island] });
    expect(s).toContain('() => import("virtual:solid-islands/chunk/i0")');
    expect(s).toContain("stopImmediatePropagation");
    expect(s).toContain("dispatchEvent(new e.constructor(e.type, e))");
    expect(s).not.toMatch(/^import /m);
    // No prefetch code under the default policy, no nested-anchor walk.
    expect(s).not.toContain("IntersectionObserver");
    expect(s).not.toContain("parentElement.closest");
    expect(s).not.toContain("data-pd");
  });

  test("eager mode imports and activates every island at load", () => {
    const s = islandsEntry({ islands: [{ ...island, tier: 1 }], mode: "eager" });
    expect(s).toContain(
      'import { activate as a0, flush as f0 } from "virtual:solid-islands/chunk/i0"'
    );
    expect(s).toContain(`for (const el of document.querySelectorAll('[data-i~="i0"]')) a0(el);`);
    expect(s).toContain("f0();");
    expect(s).not.toContain("const L =");
  });

  test("hot islands activate at load even in auto mode", () => {
    const s = islandsEntry({ islands: [island, { ...island, id: "i1", activation: "load" }] });
    expect(s).toContain('from "virtual:solid-islands/chunk/i1"');
    expect(s).toContain('"i0": [() => import("virtual:solid-islands/chunk/i0")');
  });

  test("prefetch: app default, per-island overrides, budget and network downgrade", () => {
    const s = islandsEntry({
      islands: [
        island,
        { ...island, id: "i1", root: "Todos" },
        { ...island, id: "i2", root: "Chart", prefetch: "idle" }
      ],
      prefetch: "visible",
      overrides: { Todos: "load" },
      budget: 1000
    });
    expect(s).toContain('for (const id of ["i1"]) pf(id);');
    expect(s).toContain(
      'requestIdleCallback || setTimeout)(() => { for (const id of ["i2"]) pf(id); })'
    );
    expect(s).toContain('const ids = ["i0"], io = new IntersectionObserver');
    expect(s).toContain("let $b = 1000;");
    expect(s).toContain("$nc.saveData || /2g/.test($nc.effectiveType)");
    expect(() => islandsEntry({ islands: [island], prefetch: "soon" })).toThrow(
      /unknown prefetch policy/
    );
  });

  test("window events of settled listener stubs activate their islands", () => {
    const s = islandsEntry({ islands: [{ ...island, windowEvents: ["hashchange"] }] });
    expect(s).toContain('for (const t of ["hashchange"]) addEventListener(t, W);');
    expect(s).toContain("function W(e)");
  });

  test("preventDefault and nested anchors are only paid for when present", () => {
    const s = islandsEntry({ islands: [{ ...island, preventDefault: true, nests: true }] });
    expect(s).toContain('t.closest("[data-pd]")');
    expect(s).toContain('el.parentElement.closest("[data-i]")');
  });

  test("streaming: islands activate as boundary chunks land; spanning islands wait", () => {
    const plain = islandsEntry({ islands: [{ ...island, activation: "load", tier: 1 }] });
    expect(plain).not.toContain('addEventListener("solid-islands"');
    const s = islandsEntry({
      islands: [
        { ...island, activation: "load", tier: 1, waits: true },
        { ...island, id: "i1", waits: true }
      ],
      streams: true
    });
    // Eager: one scan now and one per landed chunk, each anchor once.
    expect(s).toContain('document.addEventListener("solid-islands", $act);');
    expect(s).toContain("if (s[id] || (w && $pd(el))) continue;");
    // Lazy: a waiting island's activation waits for its boundary.
    expect(s).toContain('const WT = ["i1"];');
    expect(s).toContain("Promise.all([L[id][0](), ready(el, id)])");
    expect(s).toContain("/^l\\d/.test(n.data)");
  });

  test("a fallback root is hydrated", () => {
    const s = islandsEntry({ islands: [], hydrate: [{ module: "/src/app.tsx", export: "App" }] });
    expect(s).toContain('import { App as $H0 } from "/src/app.tsx";');
    expect(s).toContain('$hydrate(() => $cc($H0, {}), document.querySelector("#root"));');
  });
});

describe("IslandsCompiler", () => {
  test("collects islands across relative imports with unique id prefixes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "islands-"));
    fs.writeFileSync(path.join(dir, "toggle.tsx"), TOGGLE);
    fs.writeFileSync(
      path.join(dir, "app.tsx"),
      `import { $component, $event, $signal } from "solid-js";
import { Toggle } from "./toggle";
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const inc = $event(function* () { setN(x => x + 1); });
  return function* () { return <main><button onClick={inc}>{yield* n}</button><Toggle>x</Toggle></main>; };
});`
    );
    const compiler = new IslandsCompiler();
    const { islands, chunks, fallbacks, files } = compiler.collect(path.join(dir, "app.tsx"));
    expect(fallbacks).toEqual([]);
    expect(files.map(f => path.basename(f))).toEqual(["app.tsx", "toggle.tsx"]);
    expect(islands.map(i => [i.id, i.root, i.tier])).toEqual([
      ["i0", "App", 0],
      ["i1_0", "Toggle", 0]
    ]);
    expect([...chunks.keys()]).toEqual(["i0", "i1_0"]);
    fs.rmSync(dir, { recursive: true });
  });
});
