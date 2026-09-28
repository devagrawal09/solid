// Track A stage 2: module capability summaries and the capability linker's
// whole-graph proof (capabilities.js). Every refusal case must keep the full
// runtime and say why.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { summarizeCapabilities } = require("..");
const { proveGraph } = require("../capabilities.js");

const REPO = path.resolve(__dirname, "../../..");
const LIBRARIES = {
  "solid-js": path.join(REPO, "packages/solid/dist/solid.js"),
  "@solidjs/web": path.join(REPO, "packages/web/dist/web.js"),
  "@solidjs/signals": path.join(REPO, "packages/signals/dist/prod/index.js")
};

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solid-capabilities-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "app" }));
  const nodeModules = path.join(root, "node_modules", "untyped-lib");
  fs.mkdirSync(nodeModules, { recursive: true });
  fs.writeFileSync(path.join(nodeModules, "package.json"), JSON.stringify({ name: "untyped-lib" }));
  fs.writeFileSync(path.join(nodeModules, "index.js"), "export const x = 1;");
  for (const [name, code] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), code);
  }
  const resolve = async (source, importer) => {
    if (LIBRARIES[source]) return LIBRARIES[source];
    if (source === "untyped-lib") return path.join(nodeModules, "index.js");
    if (source.startsWith(".")) {
      const base = path.resolve(path.dirname(importer), source);
      for (const ext of ["", ".tsx", ".ts", ".js", ".css"]) {
        if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
      }
    }
    return null;
  };
  return {
    root,
    resolve,
    prove: (typedSummary, entry = "src/main.tsx") =>
      proveGraph({ entries: [path.join(root, entry)], resolve, root, typedSummary })
  };
}

const MAIN = `import { render } from "@solidjs/web";\nimport { App } from "./app";\nrender(() => <App />, document.body);\n`;

describe("summarizeCapabilities", () => {
  test("reports edges, host computes and library component props with positions", () => {
    const code = `import { $, createMemo, createSignal, Show } from "solid-js";
import { helper } from "./helper";
const [n] = createSignal(0);
const a = createMemo(() => n() === 1);
const b = createMemo(() => helper(n()));
const c = createMemo(async () => 1);
const d = createMemo($(function* () { return (yield* n) === 1; }));
export const view = <Show when={n() > 0}>x</Show>;
export const later = () => import("./later");
`;
    const summary = summarizeCapabilities(code, { filename: "mod.tsx" });
    expect(summary.imports.map(i => i.source)).toEqual(["solid-js", "./helper"]);
    expect(summary.imports[0].names).toEqual(["$", "createMemo", "createSignal", "Show"]);
    expect(summary.computes.map(c => [c.line, c.proof])).toEqual([
      [4, "sync"],
      [5, "unproven"],
      [6, "async"],
      [7, "sync"]
    ]);
    // `createSignal(0)` is a value, not a compute.
    expect(summary.computes.some(c => c.host === "createSignal")).toBe(false);
    expect(summary.componentProps).toEqual([
      expect.objectContaining({
        source: "solid-js",
        component: "Show",
        prop: "when",
        proof: "sync"
      })
    ]);
    const start = summary.componentProps[0].start;
    expect(code.slice(start, start + 7)).toBe("n() > 0");
    expect(summary.dynamicImports).toEqual([expect.objectContaining({ source: "./later" })]);
  });

  test("positions are UTF-16 offsets into the authored source", () => {
    const code = `import { createMemo } from "solid-js";\nconst s = "é😀";\nconst m = createMemo(() => s === "x");\n`;
    const [compute] = summarizeCapabilities(code, { filename: "m.ts" }).computes;
    expect(code.slice(compute.start, compute.start + 5)).toBe("() =>");
  });

  test("a block that attempts may suspend (async); an unproven block is not claimed", () => {
    const code = `import { $, createMemo, attempt } from "solid-js";
const w = createMemo($(function* () { return yield* attempt(() => load()); }));
const u = createMemo($(function* () { return helper(); }));
`;
    const computes = summarizeCapabilities(code, { filename: "w.js" }).computes;
    expect(computes.map(c => c.proof)).toEqual(["async", "unproven"]);
  });
});

describe("proveGraph", () => {
  test("proves a synchronous graph and selects the async-free entry", async () => {
    const { prove } = project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { createMemo, createSignal, Show } from "solid-js";
import "./app.css";
export function App() {
  const [n, setN] = createSignal(0);
  const big = createMemo(() => n() > 10);
  return <Show when={n() >= 0}><button onClick={() => setN(n() + 1)}>{big() ? "big" : "small"}</button></Show>;
}
`,
      "src/app.css": "button {}"
    });
    const report = await prove();
    expect(report.reasons).toEqual([]);
    expect(report.asyncFree).toBe(true);
    expect(report.entry).toBe("@solidjs/signals/sync");
    expect(report.modules).toEqual(["src/main.tsx", "src/app.tsx"]);
    expect(report.libraries["solid-js"]).toEqual(["Show", "createMemo", "createSignal"]);
    expect(report.counts).toMatchObject({
      computes: 1,
      computesLocal: 1,
      propsChecked: 1,
      assets: 1
    });
  });

  test("an async capability import keeps the full runtime", async () => {
    const { prove } = project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { isPending } from "solid-js";\nexport const App = () => String(isPending(() => 0));\n`
    });
    const report = await prove();
    expect(report.asyncFree).toBe(false);
    expect(report.entry).toBe(null);
    expect(report.reasons).toEqual([
      {
        file: "src/app.tsx",
        line: null,
        reason: "imports async capability `isPending` from solid-js",
        kind: "async"
      }
    ]);
  });

  test("an async compute keeps the full runtime even with a typed summary", async () => {
    const { prove, root } = project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { createMemo } from "solid-js";\nconst data = createMemo(async () => 1);\nexport const App = () => null;\n`
    });
    const file = path.join(root, "src/app.tsx");
    const report = await prove({ files: { [file]: { computes: { 71: "sync" }, props: {} } } });
    expect(report.asyncFree).toBe(false);
    expect(report.reasons[0].reason).toMatch(/compute is async \(async compute function\)/);
  });

  test("an unproven compute needs a typed `sync` verdict at its position", async () => {
    const source = `import { createMemo } from "solid-js";\nconst list = () => [1, 2];\nconst sorted = createMemo(() => list().slice().sort());\nexport const App = () => sorted().join();\n`;
    const { prove, root } = project({ "src/main.tsx": MAIN, "src/app.tsx": source });
    const withoutTypes = await prove();
    expect(withoutTypes.asyncFree).toBe(false);
    expect(withoutTypes.reasons[0].reason).toMatch(/not proven synchronous .*no typed summary/);

    const file = path.join(root, "src/app.tsx");
    const start = source.indexOf("() => list()");
    const unknownTyped = await prove({
      files: { [file]: { computes: { [start]: "unknown" }, props: {} } }
    });
    expect(unknownTyped.asyncFree).toBe(false);
    expect(unknownTyped.reasons[0].reason).toMatch(/typed: unknown/);

    const typed = await prove({ files: { [file]: { computes: { [start]: "sync" }, props: {} } } });
    expect(typed.asyncFree).toBe(true);
    expect(typed.counts.computesTyped).toBe(1);
  });

  test("a library component compute prop must be proven; other props are free", async () => {
    const source = `import { For } from "solid-js";\nconst rows = () => [1];\nexport const App = () => <For each={rows()} fallback={load()}>{r => r}</For>;\n`;
    const { prove, root } = project({ "src/main.tsx": MAIN, "src/app.tsx": source });
    const report = await prove();
    expect(report.reasons.map(r => r.reason)).toEqual(["<For each> not proven synchronous"]);
    const file = path.join(root, "src/app.tsx");
    const typed = await prove({
      files: { [file]: { computes: {}, props: { [source.indexOf("rows()")]: "sync" } } }
    });
    expect(typed.asyncFree).toBe(true);
  });

  test("a non-literal dynamic import is unclassified; a literal one is followed", async () => {
    const { prove } = project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `export const App = () => null;\nexport const a = () => import("./lazy");\nexport const b = (p) => import(p);\n`,
      "src/lazy.ts": `import { latest } from "solid-js";\nexport const L = latest;\n`
    });
    const report = await prove();
    expect(report.modules).toContain("src/lazy.ts");
    expect(report.reasons.map(r => r.reason).sort()).toEqual([
      "imports async capability `latest` from solid-js",
      "unclassified dynamic import (non-literal)"
    ]);
  });

  test("packages without a manifest and unresolved imports are unknown", async () => {
    const { prove } = project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { x } from "untyped-lib";\nimport { y } from "./missing";\nexport const App = () => x + y;\n`
    });
    const report = await prove();
    expect(report.asyncFree).toBe(false);
    expect(report.reasons.map(r => r.reason)).toEqual([
      "`untyped-lib` (untyped-lib) has no capability manifest",
      "unresolved import `./missing`"
    ]);
  });

  test("a namespace import of a library with async capabilities is refused", async () => {
    const { prove } = project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import * as Solid from "solid-js";\nexport const App = () => Solid.untrack(() => null);\n`
    });
    const report = await prove();
    expect(report.reasons.map(r => r.reason)).toEqual([
      "namespace import of solid-js (includes async capabilities)"
    ]);
  });
});

// Core runtime slicing (documentation/plans/core-runtime-slicing.md): the
// per-feature switches of @solidjs/signals (src/core/features.ts).
describe("proveGraph features", () => {
  const off = report =>
    Object.entries(report.features)
      .filter(([, f]) => !f.on)
      .map(([name]) => name)
      .sort();

  test("a signals-only client graph switches every import-decided feature off", async () => {
    const { prove } = project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { createSignal, Show } from "solid-js";\nexport function App() {\n  const [n] = createSignal(0);\n  return <Show when={n() >= 0}>{n()}</Show>;\n}\n`
    });
    const report = await prove();
    expect(off(report)).toEqual(["ITERABLE", "OPTIMISTIC", "SNAPSHOTS", "STORES", "VERDICTS"]);
    // Compiled seams are a compiler-configuration fact, on by default.
    expect(report.features.COMPILED_SEAMS.on).toBe(true);
  });

  test("each feature export turns its switch on, with the reason", async () => {
    const { prove } = project({
      "src/main.tsx": `import { hydrate } from "@solidjs/web";\nimport { App } from "./app";\nhydrate(() => <App />, document.body);\n`,
      "src/app.tsx": `import { createStore, isPending, $component } from "solid-js";\nexport const App = $component(function* () { return function* () { return null; }; });\nexport const s = createStore({});\nexport const p = () => isPending(() => 0);\n`
    });
    const report = await prove();
    expect(off(report)).toEqual([]);
    expect(report.features.STORES.because).toContain("solid-js: createStore");
    expect(report.features.VERDICTS.because).toContain("solid-js: isPending");
    // VERDICTS implies OPTIMISTIC: companions are optimistic nodes.
    expect(report.features.OPTIMISTIC.because).toContain(
      "VERDICTS (companions are optimistic nodes)"
    );
    expect(report.features.SNAPSHOTS.because).toContain("@solidjs/web: hydrate");
    expect(report.features.ITERABLE.because).toContain("solid-js: $component");
  });

  test("a hand-written yield* keeps ITERABLE on (AccessorIterable needs no block import)", async () => {
    const { prove } = project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { createSignal } from "solid-js";\nconst [n] = createSignal(1);\nfunction* read() { return yield* n; }\nexport const App = () => String(read);\n`
    });
    const report = await prove();
    expect(report.features.ITERABLE).toEqual({ on: true, because: ["src/app.tsx uses yield*"] });
  });

  test("an incompletely known graph keeps every switch on; an async-only reason does not", async () => {
    const { prove } = project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { x } from "untyped-lib";\nexport const App = () => x;\n`
    });
    const report = await prove();
    expect(off(report)).toEqual([]);
    expect(report.features.STORES.because).toContain("module graph not fully known");
    const asyncOnly = await project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { createMemo } from "solid-js";\nconst d = createMemo(async () => 1);\nexport const App = () => null;\n`
    }).prove();
    expect(asyncOnly.asyncFree).toBe(false);
    expect(off(asyncOnly)).toContain("STORES");
  });

  test("a namespace import uses every feature its package lists", async () => {
    const { prove } = project({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import * as Solid from "solid-js";\nexport const App = () => Solid.untrack(() => null);\n`
    });
    const report = await prove();
    expect(report.features.STORES.because).toContain("namespace import of solid-js");
    expect(off(report)).not.toContain("STORES");
  });
});

describe("proveGraph features from compiled facts", () => {
  const { transform } = require("..");
  const off = report =>
    Object.entries(report.features)
      .filter(([, f]) => !f.on)
      .map(([name]) => name)
      .sort();
  // The bundler's loader: each module's transformed code (what the bundle
  // includes), here the native compiler's DOM output.
  const loader =
    (compileOptions = {}, virtual = {}) =>
    async id =>
      id in virtual
        ? virtual[id]
        : transform(fs.readFileSync(id, "utf8"), {
            filename: id,
            generate: "dom",
            ...compileOptions
          }).code;
  const withLoad = (files, compileOptions, virtual) => {
    const p = project(files);
    return {
      ...p,
      proveCompiled: () =>
        proveGraph({
          entries: [path.join(p.root, "src/main.tsx")],
          resolve: p.resolve,
          root: p.root,
          load: loader(compileOptions, virtual)
        })
    };
  };
  const ALL_OFF = ["COMPILED_SEAMS", "ITERABLE", "OPTIMISTIC", "SNAPSHOTS", "STORES", "VERDICTS"];

  // Every body lowers to call form: no generator is left at runtime.
  const LOWERED = `import { $component, $signal, $memo, $event } from "solid-js";
export const App = $component(function* () {
  const [n, setN] = yield* $signal(0);
  const doubled = yield* $memo(function* () { return (yield* n) * 2; });
  const inc = $event(function* () { yield* setN(v => v + 1); });
  return function* () { return <button onClick={inc}>{yield* doubled}</button>; };
});
`;

  test("a fully lowered block app turns ITERABLE off; its authored imports would not", async () => {
    const p = withLoad({ "src/main.tsx": MAIN, "src/app.tsx": LOWERED });
    const bySource = await p.prove();
    expect(bySource.features.ITERABLE.on).toBe(true);
    const report = await p.proveCompiled();
    expect(report.facts.withFacts).toBe(report.facts.modules);
    expect(report.facts.delegations).toBe(0);
    expect(off(report)).toEqual(ALL_OFF);
  });

  test("a residual generator with yield* keeps ITERABLE on, naming the module", async () => {
    const p = withLoad({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { $component, $event, attempt } from "solid-js";
export const App = $component(function* () {
  const save = $event(function* () { yield* attempt(() => fetch("/x")); });
  return function* () { return <button onClick={save}>save</button>; };
});
`
    });
    const report = await p.proveCompiled();
    expect(report.features.ITERABLE.on).toBe(true);
    expect(report.features.ITERABLE.because[0]).toMatch(
      /^src\/app\.tsx:\d+: 1 yield\* left in compiled output$/
    );
    expect(report.facts.residualGenerators).toEqual([
      expect.objectContaining({ file: "src/app.tsx", delegations: 1 })
    ]);
  });

  test("an imported but never created store keeps STORES off; a created one turns it on", async () => {
    const unused = await withLoad({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { createSignal, createStore } from "solid-js";\nexport const App = () => { const [n] = createSignal(0); return <p>{n()}</p>; };\n`
    }).proveCompiled();
    expect(unused.features.STORES.on).toBe(false);
    const used = await withLoad({
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { createStore } from "solid-js";\nexport const App = () => { const [s] = createStore({ n: 1 }); return <p>{s.n}</p>; };\n`
    }).proveCompiled();
    expect(used.features.STORES.on).toBe(true);
    // The plain form is compiled to its own constructor (storeForms).
    expect(used.features.STORES.because).toContain("solid-js: createPlainStore (src/app.tsx)");
    expect(used.facts.creates).toEqual({ store: 1 });
  });

  test("compiled seams come from the output: none in plain output, the effect cut-off with memo fusion", async () => {
    const files = {
      "src/main.tsx": MAIN,
      "src/app.tsx": `import { createSignal, createMemo, createEffect } from "solid-js";\nconst [n] = createSignal(1);\nconst d = createMemo(() => n() * 2);\ncreateEffect(() => d(), v => console.log(v));\nexport const App = () => <p>x</p>;\n`
    };
    const plain = await withLoad(files).proveCompiled();
    expect(plain.features.COMPILED_SEAMS.on).toBe(false);
    // Block proofs emit `syncOnly` (not a seam: `sync` is kernel).
    const proven = await withLoad(files, { blockProofs: true, hostFusion: true }).proveCompiled();
    expect(proven.features.COMPILED_SEAMS.on).toBe(false);
    const fused = await withLoad(files, { memoFusion: true }).proveCompiled();
    expect(fused.features.COMPILED_SEAMS.on).toBe(true);
    expect(fused.features.COMPILED_SEAMS.because).toEqual([
      "src/app.tsx: compiled output requests effectEquals",
      "src/app.tsx: compiled output requests isEqual"
    ]);
  });

  test("a module whose compiled output is unknown falls back to its authored imports", async () => {
    const p = project({ "src/main.tsx": MAIN, "src/app.tsx": LOWERED });
    const report = await proveGraph({
      entries: [path.join(p.root, "src/main.tsx")],
      resolve: p.resolve,
      root: p.root,
      load: async id => (id.endsWith("app.tsx") ? null : loader()(id))
    });
    expect(report.facts.withFacts).toBe(report.facts.modules - 1);
    expect(report.features.ITERABLE.because).toContain("solid-js: $component (src/app.tsx)");
    expect(report.features.COMPILED_SEAMS.on).toBe(true);
  });

  test("a virtual entry is summarized from the loader, so the graph stays fully known", async () => {
    const p = project({ "src/app.tsx": `export const App = () => <p>hi</p>;\n` });
    const virtualEntry = "\0virtual:entry-client.tsx";
    const entryCode = `import { render } from "@solidjs/web";\nimport { App } from "./src/app.tsx";\nrender(App, document.body);\n`;
    const resolve = async (source, importer) =>
      importer === virtualEntry && source.startsWith(".")
        ? path.join(p.root, source)
        : p.resolve(source, importer);
    const withoutLoad = await proveGraph({ entries: [virtualEntry], resolve, root: p.root });
    expect(off(withoutLoad)).toEqual([]);
    const report = await proveGraph({
      entries: [virtualEntry],
      resolve,
      root: p.root,
      load: loader({}, { [virtualEntry]: entryCode })
    });
    expect(report.modules).toContain("virtual:entry-client.tsx");
    expect(off(report)).toEqual(ALL_OFF);
  });
});
