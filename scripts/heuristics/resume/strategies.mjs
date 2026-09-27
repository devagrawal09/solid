// Client entries for challenge 2 (documentation/plans/resumability.md). Every
// strategy shares one event host: a document click listener that maps a row
// click to `select(id)` and the rename button to `rename()`. Strategies differ
// in what runs at load and what runs before a handler.
//
// Correctness rule (hydrate-before-write): before a handler writes, every
// island that reads what it writes must be live — hydrated while the state
// still equals the server snapshot, or (resumability) its subscribed bindings
// woken — so the write updates them normally.
//
//   A        full hydration: every island at load.
//   D        pruned hydration: the footer (reads nothing any handler writes)
//            is never hydrated; the rest at load.
//   E-lazy   runtime-only lazy: nothing at load; the first event hydrates
//            EVERY island (the runtime cannot know who reads what), then runs.
//   E-naive  UNSAFE control: the first event hydrates only the island it
//            happened in. Must fail the gate (the detail island goes stale).
//   F        compiler-scoped lazy: a static handler → islands map (from the
//            handlers' write sets and the islands' read sets); before a
//            handler runs, hydrate its islands not yet hydrated.
//   C        pruned resumability: no component ever runs on the client. The
//            server serializes the live closure — signal values reachable by
//            a write, the bindings that read them (element ref, expression),
//            and each signal's subscribers. A handler wakes the subscribers of
//            what it writes, then writes.
//   B        naive resumability: as C, but every binding and value on the page
//            is serialized (static id cells, footer links).

// Shared event host, parameterized by `run(handler, arg)`.
const HOST = `
function __host(run) {
  document.addEventListener("click", e => {
    const t = e.target;
    if (t.closest("[data-action=rename]")) return run("rename");
    const tr = t.closest("tr[data-row]");
    if (tr) return run("select", +tr.getAttribute("data-row"));
  });
}`;

// Hydration strategies: the compiled hydratable app + @solidjs/web hydrate.
export function hydrationEntry(compiledApp, strategy) {
  const islands = strategy === "D" || strategy.startsWith("F") ? "table detail header" : "table detail header footer";
  return `${compiledApp}
import { hydrate as __hydrate, render as __render, createComponent as __cc } from "@solidjs/web";
import { flush as __flush } from "solid-js";
${HOST}
const __ISLANDS = ${JSON.stringify(islands.split(" "))};
// F's map: handler → islands reading what it writes (select writes selected:
// table, detail; rename writes labels[selected] and renames: table, detail, header).
const __MAP = { select: ["table", "detail"], rename: ["table", "detail", "header"] };
let __state, __regions;
const __live = new Set();
function __boot() {
  if (__state) return;
  const data = JSON.parse(document.getElementById("data").textContent);
  __state = makeState(data);
  __regions = makeRegions(__state, data);
}
function __hy(name) {
  if (__live.has(name)) return;
  __live.add(name);
  __boot();
  // Oracle for staggered island hydration: Solid 2 closes hydration globally
  // once the first pass drains (_$HY.done → later hydrate() calls fall back to
  // a client render). A later island re-opens it (this app keeps nothing in
  // the serialization registry, which the drain clears).
  if (globalThis._$HY.done) globalThis._$HY.done = false;
  const el = document.getElementById("r-" + name);
  ${strategy === "F-csr"
    ? `// Cost bound, not a strategy: a hydration runtime as cheap as a client
  // render (the island is re-rendered from scratch; node identity is lost).
  el.textContent = "";
  __render(() => __cc(__regions[name], {}), el);`
    : `__hydrate(() => __cc(__regions[name], {}), el, { renderId: name });`}
}
function __handle(h, arg) {
  h === "select" ? __state.select(arg) : __state.rename();
  __flush();
}
globalThis._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
window.__init = () => {
  ${
    strategy === "A" || strategy === "D"
      ? `for (const n of __ISLANDS) __hy(n); __flush(); __host(__handle);`
      : strategy === "E-lazy"
        ? `__host((h, a) => { for (const n of __ISLANDS) __hy(n); __flush(); __handle(h, a); });`
        : strategy === "E-naive"
          ? `__host((h, a) => { __hy(h === "select" ? "table" : "header"); __flush(); __handle(h, a); });`
          : `__host((h, a) => { for (const n of __MAP[h]) __hy(n); __flush(); __handle(h, a); });`
  }
};
`;
}

// Resumability runtime (B and C): signals only — no component code, no web
// runtime. `q` is the serialized page state (see server side in bench.mjs).
export function resumeEntry() {
  return `
import { createSignal, createRenderEffect, flush } from "solid-js";
${HOST}
let Q = null, els = null, selected, setSelected, renames, setRenames;
const labelSigs = new Map();
const woke = new Set();
function label(i) {
  let s = labelSigs.get(i);
  if (!s) labelSigs.set(i, (s = createSignal(Q.s.labels[i])));
  return s;
}
// Expressions a resumable compiler would emit per binding site.
const EXPR = [
  id => (selected() === id ? "danger" : ""),                       // 0 row class
  id => label(id)[0](),                                             // 1 row label
  () => { const s = selected(); return s < 0 ? "nothing selected" : "#" + s + ": " + label(s)[0](); }, // 2 detail
  () => String(renames()),                                          // 3 header count
  v => v                                                            // 4 static value (B only)
];
function apply(kind, el, v) {
  if (kind === 0) el.className = v; else if (kind === 1) el.textContent = v; else el.setAttribute("href", v);
}
function boot() {
  if (Q) return;
  Q = JSON.parse(document.getElementById("q").textContent);
  [selected, setSelected] = createSignal(Q.s.selected);
  [renames, setRenames] = createSignal(Q.s.renames);
  els = document.querySelectorAll("[data-q]");
}
function wake(key) {
  const subs = Q.subs[key];
  if (!subs) return;
  for (const b of subs) {
    if (woke.has(b)) continue;
    woke.add(b);
    const [kind, q, expr, arg] = Q.b[b];
    const el = els[q];
    let first = true;
    createRenderEffect(() => EXPR[expr](arg), v => {
      // The server already rendered the first value.
      if (first) { first = false; return; }
      apply(kind, el, v);
    });
  }
}
function run(h, arg) {
  boot();
  if (h === "select") {
    wake("selected");
    flush();
    setSelected(arg);
  } else {
    const s = selected();
    if (s < 0) return; // makeState.rename: no selection, no write
    wake("renames");
    wake("l:" + s);
    flush();
    label(s)[1](label(s)[0]() + "!");
    setRenames(renames() + 1);
  }
  flush();
}
window.__init = () => __host(run);
`;
}

// F-linked: F with nothing hand-written — the analyzable twin app
// (app-islands.jsx, module-scope state), the handler → islands map derived
// by the compiler (summarizeIslands + linkIslands, in bench.mjs), and the
// shipped late-island hydration (no `_$HY.done` oracle).
export function linkedEntry(appFile, dataFile, map) {
  return `import ${JSON.stringify(dataFile)};
import { select, rename, Table, Detail, Header, Footer } from ${JSON.stringify(appFile)};
import { hydrate as __hydrate, createComponent as __cc } from "@solidjs/web";
import { flush as __flush } from "solid-js";
${HOST}
const __REGIONS = { table: Table, detail: Detail, header: Header, footer: Footer };
// Derived by the island linker from app-islands.jsx.
const __MAP = ${JSON.stringify(map)};
const __live = new Set();
function __hy(name) {
  if (__live.has(name)) return;
  __live.add(name);
  __hydrate(() => __cc(__REGIONS[name], {}), document.getElementById("r-" + name), { renderId: name });
}
globalThis._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
// Module evaluation (data parse + state creation), counted into init by bench.mjs.
window.__modMs = performance.now() - globalThis.__modT0;
window.__init = () => {
  __host((h, a) => {
    for (const n of __MAP[h]) __hy(n);
    __flush();
    h === "select" ? select(a) : rename();
    __flush();
  });
};
`;
}

// The data module F-linked's app reads at import (the page's JSON blob).
// It also opens the module-evaluation clock: the app creates its state at
// import, on the real page (the blank-page eval probe cannot see that work).
export const LINKED_DATA = `globalThis.__modT0 = performance.now();
const el = typeof document !== "undefined" && document.getElementById("data");
globalThis.__islandData = el ? JSON.parse(el.textContent) : { labels: [], footer: [] };
`;
