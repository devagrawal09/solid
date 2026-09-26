#!/usr/bin/env node
// Builds the js-framework-benchmark (JFB) Solid 2 entry and its heuristic
// oracle variants into a JFB checkout, one framework directory per variant:
//
//   frameworks/keyed/solid-next<suffix>/{index.html,package.json,src/main.jsx,dist/main.js}
//
// Pipeline (same for every variant, only the named edit differs):
//   main.jsx --(packages/compiler, generate:"dom", omitNestedClosingTags)-->
//   compiled.js --(variant edit of the compiled output)-->
//   esbuild bundle (iife; solid-js / @solidjs/web / @solidjs/signals aliased to
//   a frozen snapshot of this repo's dist trees or the rspec builds) -->
//   terser with JFB's keyed/solid options (module, compress.passes 3, mangle).
//
//   node scripts/heuristics/jfb/build.mjs --jfb <jfb checkout> [--only name,name]
//
// Variants (see README.md next to this file):
//   baseline   compiler output, verbatim.
//   H7         typed text/class: the row's class value is a string, so the
//              grouped effect writes it with setAttribute and skips readShallow
//              (the label/id are already text writes via textContent in JFB's source).
//   L1         single-element rows: <For> replaced by mapArray -> reconcileArrays
//              directly (L1-nodes in scripts/heuristics/dom/list/variants.mjs).
//   H7+L1      both.
//   child      the same app with {rowId} / {row.label()} as JSX children instead
//              of textContent (a source change: the shape H7 targets).
//   child-H7   child + typed text (H7-text in scripts/heuristics/dom/variants.mjs).
//   rspec-r0   baseline source on web-r0 + signals-r0 (rspec control build).
//   rspec-r1b  baseline source on web-r0 + signals-r16 (R1b).
import { transform as esTransform } from "esbuild";
import { rollup } from "rollup";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, ROOT } from "../common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
if (!args.jfb) throw new Error("--jfb <path to js-framework-benchmark checkout> is required");
const JFB = args.jfb;
const require = createRequire(import.meta.url);
const { minify } = require(join(ROOT, "node_modules/.pnpm/terser@5.49.0/node_modules/terser"));
const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);

// Frozen runtime snapshot: a concurrent workspace build cannot change a variant
// mid-series. Re-created only with --resnapshot.
const SNAP = join(JFB, ".solid-runtimes");
const RSPEC = join(ROOT, "node_modules/.cache/heuristics/rspec");
if (args.resnapshot || !existsSync(SNAP)) {
  rmSync(SNAP, { recursive: true, force: true });
  cpSync(join(ROOT, "packages/signals/dist/prod"), join(SNAP, "signals-prod"), { recursive: true });
  cpSync(join(ROOT, "packages/solid/dist/solid.js"), join(SNAP, "solid.js"));
  cpSync(join(ROOT, "packages/web/dist/web.js"), join(SNAP, "web.js"));
  cpSync(join(ROOT, "packages/web/src/reconcile.ts"), join(SNAP, "reconcile.ts"));
  cpSync(join(ROOT, "packages/web/src/constants.ts"), join(SNAP, "constants.ts"));
  for (const b of [0, 16]) cpSync(join(RSPEC, `signals-r${b}`), join(SNAP, `signals-r${b}`), { recursive: true });
  cpSync(join(RSPEC, "web-r0.js"), join(SNAP, "web-r0.js"));
}
function hashTree(p) {
  const h = createHash("sha256");
  const walk = q => {
    if (statSync(q).isDirectory()) for (const f of readdirSync(q).sort()) walk(join(q, f));
    else h.update(relative(p, q)).update(readFileSync(q));
  };
  walk(p);
  return h.digest("hex").slice(0, 16);
}

const compile = src =>
  transform(src, { filename: "main.jsx", generate: "dom", omitNestedClosingTags: true }).code;

function edit(code, from, to, what) {
  if (!code.includes(from)) throw new Error(`${what}: pattern not found in compiled output`);
  if (code.indexOf(from) !== code.lastIndexOf(from)) throw new Error(`${what}: pattern not unique`);
  return code.replace(from, to);
}

// --- sources --------------------------------------------------------------
const mainSrc = readFileSync(join(here, "main.jsx"), "utf8");
const childSrc = [
  ['<td class="col-md-1" textContent={rowId} />', '<td class="col-md-1">{rowId}</td>'],
  [
    "<a onClick={() => setSelected(rowId)} textContent={row.label()} />",
    "<a onClick={() => setSelected(rowId)}>{row.label()}</a>"
  ]
].reduce((s, [a, b]) => edit(s, a, b, "child source"), mainSrc);

const base = compile(mainSrc);
const child = compile(childSrc);

// --- H7 on the JFB source: typed class value in the grouped row effect -----
// className(el, v, p) with a string v is `v !== p && el.setAttribute("class", v)`
// plus hydration / class-object bookkeeping; readShallow is a no-op on strings.
function h7(code) {
  code = edit(
    code,
    'e: _$readShallow(isSelected[rowId] ? "danger" : ""),',
    'e: isSelected[rowId] ? "danger" : "",',
    "H7 class readShallow"
  );
  return edit(
    code,
    "_$className(_el$17, e, _p$?.e);",
    'e !== _p$?.e && _el$17.setAttribute("class", e);',
    "H7 class write"
  );
}

// --- H7 on the child source: exactly dom/variants.mjs H7-text --------------
function h7child(code) {
  code = edit(
    code,
    "_$template(`<tr><td class=col-md-1></td><td class=col-md-4><a></a>",
    "_$template(`<tr><td class=col-md-1> </td><td class=col-md-4><a> </a>",
    "H7 child template"
  );
  code = edit(code, "_$insert(_el$18, rowId);", "_el$18.firstChild.data = rowId;", "H7 child id");
  code = edit(
    code,
    `_$insert(_el$20, () => {
				return row.label();
			});`,
    `const _t$ = _el$20.firstChild;
			_$effect(() => row.label(), (v) => { _t$.data = v; });`,
    "H7 child label"
  );
  return edit(
    code,
    `_$effect(() => _$readShallow(isSelected[rowId] ? "danger" : ""), (_v$, _$p) => {
				_$className(_el$17, _v$, _$p);
			});`,
    `_$effect(() => (isSelected[rowId] ? "danger" : ""), (v, p) => { v !== p && _el$17.setAttribute("class", v); });`,
    "H7 child class"
  );
}

// --- L1: exactly dom/list/variants.mjs L1-nodes ---------------------------
const FOR_NODES = `
import { mapArray as __mapArray } from "solid-js";
import __reconcile from ${JSON.stringify(join(SNAP, "reconcile.ts"))};
function __forNodes(parent, each, row) {
  const mapped = __mapArray(each, row);
  let current = [];
  _$effect(mapped, nodes => {
    if (nodes.length === 0) parent.textContent = "";
    else if (current.length === 0) for (let i = 0; i < nodes.length; i++) parent.appendChild(nodes[i]);
    else __reconcile(parent, current, nodes);
    current = nodes.slice();
  });
}
`;
function l1(code) {
  const start = code.indexOf("_$insert(_el$16, _$createComponent(For, {");
  if (start < 0) throw new Error("L1: For insert not found");
  const eachAt = code.indexOf("get each() {\n\t\t\treturn data();\n\t\t},", start);
  const childrenAt = code.indexOf("children: ", start);
  const endMark = "\n\t}));";
  const end = code.indexOf(endMark, childrenAt);
  if (eachAt < 0 || childrenAt < 0 || end < 0) throw new Error("L1: For props not found");
  const children = code.slice(childrenAt + "children: ".length, end).trimEnd();
  code = code.slice(0, start) + `__forNodes(_el$16, () => data(), ${children});` + code.slice(end + endMark.length);
  return edit(
    code,
    'import { createSignal, createProjection, For } from "solid-js";',
    'import { createSignal, createProjection, For } from "solid-js";' + FOR_NODES,
    "L1 import"
  );
}

const prodRt = { signals: join(SNAP, "signals-prod/index.js"), web: join(SNAP, "web.js") };
const VARIANTS = {
  baseline: { dir: "solid-next", src: mainSrc, code: base, ...prodRt },
  H7: { dir: "solid-next-h7", src: mainSrc, code: h7(base), ...prodRt },
  L1: { dir: "solid-next-l1", src: mainSrc, code: l1(base), ...prodRt },
  "H7+L1": { dir: "solid-next-h7l1", src: mainSrc, code: l1(h7(base)), ...prodRt },
  child: { dir: "solid-next-child", src: childSrc, code: child, ...prodRt },
  "child-H7": { dir: "solid-next-child-h7", src: childSrc, code: h7child(child), ...prodRt },
  "rspec-r0": {
    dir: "solid-next-rspec-r0",
    src: mainSrc,
    code: base,
    signals: join(SNAP, "signals-r0/index.js"),
    web: join(SNAP, "web-r0.js")
  },
  "rspec-r1b": {
    dir: "solid-next-rspec-r1b",
    src: mainSrc,
    code: base,
    signals: join(SNAP, "signals-r16/index.js"),
    web: join(SNAP, "web-r0.js")
  },
  // Negative control for the equivalence gate (never timed): an H7 edit that
  // only writes truthy class values, so a deselected row keeps "danger".
  broken: {
    dir: "solid-next-broken",
    src: mainSrc,
    code: edit(h7(base), 'e !== _p$?.e && _el$17.setAttribute("class", e);', 'e && _el$17.setAttribute("class", e);', "broken"),
    ...prodRt
  }
};

const only = args.only ? new Set(args.only.split(",")) : null;
const manifest = {
  repoCommit: null,
  runtimes: {
    "signals-prod": hashTree(join(SNAP, "signals-prod")),
    "solid.js": hashTree(join(SNAP, "solid.js")),
    "web.js": hashTree(join(SNAP, "web.js")),
    "signals-r0": hashTree(join(SNAP, "signals-r0")),
    "signals-r16": hashTree(join(SNAP, "signals-r16")),
    "web-r0.js": hashTree(join(SNAP, "web-r0.js"))
  },
  variants: {}
};
try {
  manifest.repoCommit = (await import("node:child_process")).execSync("git rev-parse HEAD", { cwd: ROOT }).toString().trim();
} catch {}

for (const [name, v] of Object.entries(VARIANTS)) {
  if (only && !only.has(name)) continue;
  const fw = join(JFB, "frameworks/keyed", v.dir);
  mkdirSync(join(fw, "src"), { recursive: true });
  mkdirSync(join(fw, "dist"), { recursive: true });
  writeFileSync(join(fw, "src/main.jsx"), v.src);
  writeFileSync(join(fw, "src/compiled.js"), v.code);
  writeFileSync(
    join(fw, "index.html"),
    `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8"/>
    <title>${v.dir}-keyed</title>
    <link href="/css/currentStyle.css" rel="stylesheet"/>
</head>
<body>
<div id='main'></div>
<script src='dist/main.js'></script>
</body>
</html>
`
  );
  writeFileSync(
    join(fw, "package.json"),
    JSON.stringify(
      {
        name: `js-framework-benchmark-${v.dir}`,
        version: "1.0.0",
        type: "module",
        "js-framework-benchmark": {
          frameworkVersion: "2.0.0-rc.8-local",
          frameworkHomeURL: "https://www.solidjs.com/",
          language: "JavaScript",
          repoURL: "https://github.com/solidjs/solid"
        },
        scripts: { "build-prod": `node ${join(here, "build.mjs")} --jfb ${JFB} --only ${name}` }
      },
      null,
      2
    ) + "\n"
  );
  // JFB's server lists only directories with a package-lock.json.
  writeFileSync(
    join(fw, "package-lock.json"),
    JSON.stringify({ name: `js-framework-benchmark-${v.dir}`, version: "1.0.0", lockfileVersion: 3, requires: true, packages: {} }, null, 2) + "\n"
  );
  // Rollup, as JFB's keyed/solid entry uses (its tree-shaking matches the
  // real entry's bundle; esbuild keeps more of the runtime's module scope).
  const alias = { "solid-js": join(SNAP, "solid.js"), "@solidjs/web": v.web, "@solidjs/signals": v.signals };
  const bundle = await rollup({
    input: "\0entry",
    onwarn: () => {},
    plugins: [
      {
        name: "solid-jfb",
        resolveId(id, importer) {
          if (id === "\0entry") return id;
          if (alias[id]) return alias[id];
          if (id.startsWith(".") && importer) {
            const p = join(dirname(importer), id);
            if (existsSync(p)) return p;
            if (p.endsWith(".js") && existsSync(p.slice(0, -3) + ".ts")) return p.slice(0, -3) + ".ts";
          }
          if (id.startsWith("/") && existsSync(id)) return id;
          return null;
        },
        load(id) {
          if (id === "\0entry") return v.code;
          return null;
        },
        async transform(code, id) {
          if (!id.endsWith(".ts")) return null;
          return (await esTransform(code, { loader: "ts", format: "esm", target: "es2022" })).code;
        }
      }
    ]
  });
  const { output } = await bundle.generate({ format: "iife" });
  await bundle.close();
  const bundled = { outputFiles: [{ text: output[0].code }] };
  const min = await minify(bundled.outputFiles[0].text, { module: true, compress: { passes: 3 }, mangle: true });
  writeFileSync(join(fw, "dist/main.js"), min.code);
  const sha = createHash("sha256").update(min.code).digest("hex").slice(0, 16);
  manifest.variants[name] = {
    dir: v.dir,
    bytes: min.code.length,
    sha256: sha,
    signals: relative(SNAP, v.signals),
    web: relative(SNAP, v.web)
  };
  console.log(`${name.padEnd(10)} ${v.dir.padEnd(22)} ${String(min.code.length).padStart(6)} B  ${sha}`);
}
writeFileSync(join(JFB, "solid-variants.json"), JSON.stringify(manifest, null, 2) + "\n");
