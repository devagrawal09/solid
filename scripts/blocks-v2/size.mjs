#!/usr/bin/env node
// Bundle cost of generator blocks v2: minified + gzip bytes of small app
// fixtures, and how many of those bytes come from the block modules.
//
//   node scripts/blocks-v2/size.mjs [--out file.json] [--show fixture]
//
// Method (the #2883 treeshake harness, packages/signals/tests/treeshake.test.ts):
// vite library build of each fixture with production defines, `@solidjs/signals`
// resolved to its SOURCE (packages/signals/src, so per-module retention is
// visible) and `solid-js` / `@solidjs/web` to their built browser prod
// entries (packages/*/dist), then esbuild minify with `_`-property mangling
// (as the dist build does) and gzip -9. JSX fixtures are compiled first by the
// native compiler (`generate: "dom"`), with the options each fixture names.
// Per-module bytes are rollup's `renderedLength` (unminified, after shaking).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { compiler, ROOT } from "../track-a/compile.mjs";
import { parseArgs } from "./build.mjs";

// vite is a devDependency of packages/signals (not of the root).
const { build, transformWithEsbuild } = await import(
  pathToFileURL(createRequire(join(ROOT, "packages/signals/package.json")).resolve("vite")).href
);
const args = parseArgs(process.argv.slice(2));
const SRC = args["signals-src"] ? join(ROOT, args["signals-src"]) : join(ROOT, "packages/signals/src");

// --- fixtures -------------------------------------------------------------------

const APP_V2 = `import { $component, $memo, $effect, $event, $signal, $store, $cleanup, readStore } from "solid-js";
import { render } from "@solidjs/web";

const Row = $component(function* (props) {
  return function* () {
    return <li classList={{ done: yield* props.item.done }}>{yield* props.item.label}</li>;
  };
});

const App = $component(function* () {
  const [count, setCount] = yield* $signal(0);
  const [store, setStore] = yield* $store({ items: [{ label: "a", done: false }] });
  const doubled = yield* $memo(function* () { return (yield* count) * 2; });
  const size = yield* $memo(function* () { return yield* readStore(store, s => s.items.length); });
  yield* $effect(function* () {
    const c = yield* count;
    document.title = "count " + c;
    yield* $cleanup(() => { document.title = ""; });
  });
  const inc = $event(function* () { yield* setCount((yield* count) + 1); });
  const add = $event(function* () {
    const n = yield* size;
    setStore(s => { s.items.push({ label: "item " + n, done: false }); });
  });
  return function* () {
    return (
      <main>
        <button onClick={inc}>{yield* count} / {yield* doubled}</button>
        <button onClick={add}>add</button>
        <ul><Row item={yield* store.items[0]} /></ul>
      </main>
    );
  };
});

render(() => <App />, document.body);
`;

// The same app as it must be written for the runtime driver (no yield* in JSX).
const APP_V2_UNCOMPILED = `import { $component, $memo, $effect, $event, $signal, $store, $cleanup, readStore } from "solid-js";
import { render } from "@solidjs/web";

const Row = $component(function* (props) {
  return function* () {
    const done = yield* props.item.done;
    const label = yield* props.item.label;
    return <li classList={{ done }}>{label}</li>;
  };
});

const App = $component(function* () {
  const [count, setCount] = yield* $signal(0);
  const [store, setStore] = yield* $store({ items: [{ label: "a", done: false }] });
  const doubled = yield* $memo(function* () { return (yield* count) * 2; });
  const size = yield* $memo(function* () { return yield* readStore(store, s => s.items.length); });
  yield* $effect(function* () {
    const c = yield* count;
    document.title = "count " + c;
    yield* $cleanup(() => { document.title = ""; });
  });
  const inc = $event(function* () { yield* setCount((yield* count) + 1); });
  const add = $event(function* () {
    const n = yield* size;
    setStore(s => { s.items.push({ label: "item " + n, done: false }); });
  });
  return function* () {
    const item = yield* store.items[0];
    return (
      <main>
        <button onClick={inc}>{count} / {doubled}</button>
        <button onClick={add}>add</button>
        <ul>{Row({ item })}</ul>
      </main>
    );
  };
});

render(() => <App />, document.body);
`;

// The same app, handwritten plain Solid.
const APP_PLAIN = `import { createSignal, createMemo, createEffect, createStore, onCleanup } from "solid-js";
import { render } from "@solidjs/web";

function Row(props) {
  return <li classList={{ done: props.item.done }}>{props.item.label}</li>;
}

function App() {
  const [count, setCount] = createSignal(0);
  const [store, setStore] = createStore({ items: [{ label: "a", done: false }] });
  const doubled = createMemo(() => count() * 2);
  const size = createMemo(() => store.items.length);
  createEffect(count, c => {
    document.title = "count " + c;
    return () => { document.title = ""; };
  });
  const inc = () => setCount(count() + 1);
  const add = () => {
    const n = size();
    setStore(s => { s.items.push({ label: "item " + n, done: false }); });
  };
  return (
    <main>
      <button onClick={inc}>{count()} / {doubled()}</button>
      <button onClick={add}>add</button>
      <ul><Row item={store.items[0]} /></ul>
    </main>
  );
}

render(() => <App />, document.body);
`;

const HELLO = `import { createSignal } from "solid-js";
import { render } from "@solidjs/web";
function Counter() {
  const [count, setCount] = createSignal(0);
  return <button onClick={() => setCount(count() + 1)}>{count()}</button>;
}
render(() => <Counter />, document.body);
`;

export const FIXTURES = [
  {
    name: "signals core floor",
    code: `export { createSignal, createMemo, createEffect, createRoot, flush } from "@solidjs/signals";`
  },
  {
    name: "signals + $ (one lowered memo block)",
    code: `import { $, createMemo, createSignal, perform } from "@solidjs/signals";
const [a] = createSignal(1);
export const m = createMemo($(function () { return perform(a) * 2; }));`
  },
  { name: "web hello (no blocks)", code: HELLO, jsx: {} },
  { name: "web app, plain Solid", code: APP_PLAIN, jsx: {} },
  { name: "web app, v2 compiled", code: APP_V2, jsx: {} },
  { name: "web app, v2 compiled + hostFusion", code: APP_V2, jsx: { hostFusion: true } },
  { name: "web app, v2 uncompiled", code: APP_V2_UNCOMPILED, jsx: { generators: false } }
];

// --- bundling -------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "blocks-v2-size-"));

async function bundle(fixture) {
  let code = fixture.code;
  if (fixture.jsx) {
    code = compiler.transform(code, { filename: "entry.jsx", generate: "dom", ...fixture.jsx }).code;
  }
  const entry = join(dir, `${fixture.name.replace(/\W+/g, "-")}.js`);
  writeFileSync(entry, code);
  const result = await build({
    configFile: false,
    logLevel: "silent",
    define: {
      __DEV__: "false",
      __OBSERVE__: "false",
      __TEST__: "false",
      __ASYNC__: "true",
      __ORACLE__: "false"
    },
    resolve: {
      alias: {
        "@solidjs/signals": join(SRC, "index.ts"),
        "solid-js": process.env.SOLID_DIST ?? join(ROOT, "packages/solid/dist/solid.js"),
        "@solidjs/web": join(ROOT, "packages/web/dist/web.js")
      }
    },
    build: {
      write: false,
      minify: false,
      target: "esnext",
      lib: { entry, formats: ["es"], fileName: "out" }
    }
  });
  const chunk = result[0].output[0];
  const modules = {};
  for (const [id, mod] of Object.entries(chunk.modules)) {
    if (mod.renderedLength > 0) modules[id.replace(ROOT + "/", "")] = mod.renderedLength;
  }
  const minified = (
    await transformWithEsbuild(chunk.code, "out.js", { minify: true, mangleProps: /^_/ })
  ).code;
  return {
    min: Buffer.byteLength(minified),
    gzip: gzipSync(minified, { level: 9 }).length,
    modules,
    code: chunk.code
  };
}

const BLOCK_MODULES = ["signals/src/generator.ts", "signals/src/block-api.ts"];
const results = {};
let md = "| fixture | min | gzip | generator.ts | block-api.ts |\n| --- | ---: | ---: | ---: | ---: |\n";
for (const fixture of FIXTURES) {
  const r = await bundle(fixture);
  results[fixture.name] = r;
  const mod = name =>
    Object.entries(r.modules)
      .filter(([id]) => id.endsWith(name))
      .reduce((a, [, n]) => a + n, 0);
  md += `| ${fixture.name} | ${r.min} | ${r.gzip} | ${mod(BLOCK_MODULES[0])} | ${mod(BLOCK_MODULES[1])} |\n`;
  if (args.show && fixture.name.includes(args.show)) {
    const out = join(ROOT, "node_modules/.cache/blocks-v2/size-show.js");
    writeFileSync(out, r.code);
    process.stderr.write(`wrote ${out}\n`);
  }
}
rmSync(dir, { recursive: true, force: true });
const outFile = args.out ?? join(ROOT, "node_modules/.cache/blocks-v2/size.json");
mkdirSync(join(outFile, ".."), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify(
    Object.fromEntries(Object.entries(results).map(([k, v]) => [k, { ...v, code: undefined }])),
    null,
    2
  )
);
process.stdout.write(`${md}\n(generator.ts / block-api.ts: unminified rendered bytes after shaking)\nraw: ${outFile}\n`);
