// Stack A, list suite: every "build" heuristic applied together to the
// <For> + Row component benchmark (scripts/heuristics/dom/list/baseline.jsx),
// plus leave-one-out. All variants are named edits of the real compiler's
// output; `listVariant(flags)` composes them, so each leave-one-out cell is
// exactly STACK with one edit not applied.
//
//   C1   Row inlined at its only call site (source-level, then compiled).
//   H7   typed text: `{row.id}` / `{row.label()}` become a text-node `.data`
//        write in a plain render effect (template carries the text node)
//        instead of `insert`; the class value is a typed string, so no
//        readShallow and a direct setAttribute.
//   L1   rows proven single-element: mapArray output goes straight to the
//        DOM reconciler (no flatten / normalize / insertExpression).
//   H8b  `oracle: OWNERLESS | DETACHED` on render effects whose sources all
//        die with the row and which register no cleanup: the id and label
//        text effects (needs H7: `insert` takes no node options and may own
//        inner effects) and the class effect when it reads the row-local
//        `isSel` memo. Never on isSel, never on anything reading `selected`.
//        `h8bLabel: false` keeps the label effect attached: its signal is
//        created in build(), outside the row, and outlives it on removeAdd,
//        so a sound proof would refuse it (STACK-H8bLabel).
//   SF   Track A's `statusFree` host option on `isSel` (sync, cannot throw).
//   fuseShared   C2 applied anyway: isSel fused into the class effect with
//        `equals` (the policy says not to: it reads the shared `selected`).
//
// Fusion of row-local memos (policy-correct C2) is part of the stack by
// definition, but this benchmark has no row-local memo: the only memo,
// isSel, reads the shared `selected` signal. It is a no-op here.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
const compile = (src, name) => transform(src, { filename: `${name}.jsx`, generate: "dom" }).code;

export const DETACHED_BITS = (1 << 26) | (1 << 27); // OWNERLESS | DETACHED = 201326592

const baselineSrc = readFileSync(join(ROOT, "scripts/heuristics/dom/list/baseline.jsx"), "utf8");
const inlineSrc = baselineSrc.replace(
  "return <Row row={row} selected={isSel()} />;",
  `return (
                <tr class={isSel() ? "danger" : ""}>
                  <td class="col-md-1">{row.id}</td>
                  <td class="col-md-4">{row.label()}</td>
                </tr>
              );`
);
if (inlineSrc === baselineSrc) throw new Error("inline pattern not found");

function edit(code, from, to, what) {
  if (!code.includes(from)) throw new Error(`${what}: pattern not found in compiled output`);
  return code.split(from).join(to);
}
function editRe(code, re, fn, what, expected) {
  let count = 0;
  const out = code.replace(re, (...m) => {
    count++;
    return fn(...m);
  });
  if (count !== expected) throw new Error(`${what}: expected ${expected} matches, got ${count}`);
  return out;
}

const MEMO = "const isSel = createMemo(() => selected() === row.id);";
const IMPORT = 'import { createMemo, createRoot, createSignal, flush, For } from "solid-js";';
const opts = h8b => (h8b ? `, { oracle: ${DETACHED_BITS} }` : "");

// The class effect as the compiler emits it. Group 1: condition; 2: element.
const CLASS_RE =
  /_\$effect\(\(\) => _\$readShallow\((.+?) \? "danger" : ""\), \(_v\$, _\$p\) => \{\s*_\$className\((_el\$\d*), _v\$, _\$p\);\s*\}\);/g;
// A compiled child insert. Group 1: element; 2: expression.
const INSERT_RE = /_\$insert\((_el\$\d*), \(\) => \{\s*return ([^;]+);\s*\}\);/g;

export function listVariant({ c1 = false, h7 = false, l1 = false, h8b = false, h8bLabel = true, sf = false, fuseShared = false }) {
  if (fuseShared && !c1) throw new Error("fuseShared needs C1 (the memo's reader is only local once inlined)");
  let code = compile(c1 ? inlineSrc : baselineSrc, c1 ? "inline" : "baseline");
  if (c1) {
    // The inlined Row is dead code (esbuild drops it too); remove it so each
    // edit below has exactly one site.
    const a = code.indexOf("function Row(props) {");
    const b = code.indexOf("export function make(");
    if (a < 0 || b < a) throw new Error("C1: dead Row not found");
    code = code.slice(0, a) + code.slice(b);
  }

  // isSel: fused away (fuseShared), or kept with/without statusFree.
  const classReadsSelected = fuseShared;
  if (fuseShared) {
    code = edit(code, MEMO, "", "fuse memo");
    code = edit(code, "_$readShallow(isSel() ?", "_$readShallow(selected() === row.id ?", "fuse read");
  } else if (sf) {
    code = edit(code, MEMO, "const isSel = createMemo(() => selected() === row.id, __statusFree);", "statusFree");
    code = edit(code, IMPORT, IMPORT + '\nimport { statusFree as __statusFree } from "solid-js";', "statusFree import");
  }
  // H8b on the class effect only when it reads row-local sources (isSel).
  const classOpts = fuseShared
    ? ", { equals: (a, b) => a === b }"
    : opts(h8b);

  // Class effect.
  code = editRe(
    code,
    CLASS_RE,
    (_, cond, el) =>
      h7
        ? `_$effect(() => (${cond} ? "danger" : ""), (_v$, _$p) => { _v$ !== _$p && ${el}.setAttribute("class", _v$); }${classOpts});`
        : `_$effect(() => _$readShallow(${cond} ? "danger" : ""), (_v$, _$p) => { _$className(${el}, _v$, _$p); }${classOpts});`,
    "class effect",
    1
  );
  if (classReadsSelected && classOpts.includes("oracle")) throw new Error("policy: never detach a reader of `selected`");

  // Text children.
  if (h7) {
    code = edit(
      code,
      "_$template(`<tr><td class=col-md-1></td><td class=col-md-4>`)",
      "_$template(`<tr><td class=col-md-1> </td><td class=col-md-4> `)",
      "H7 template"
    );
    let k = 0;
    code = editRe(
      code,
      INSERT_RE,
      (_, el, expr) => {
        const t = `_t$${k++}`;
        const detach = h8b && (h8bLabel || !expr.includes("label()"));
        return `var ${t} = ${el}.firstChild; _$effect(() => ${expr}, v => { ${t}.data = v; }${opts(detach)});`;
      },
      "H7 text",
      2
    );
  }
  if (l1) code = nodesList(code);
  return code;
}

// L1 (verbatim from dom/list/variants.mjs): the For call replaced by a list
// whose rows are single elements.
const FOR_NODES = `
import { mapArray as __mapArray } from "solid-js";
import __reconcile from ${JSON.stringify(join(ROOT, "packages/web/src/reconcile.ts"))};
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
function nodesList(code) {
  const start = code.indexOf("dispose = render(() => _$createComponent(For, {");
  if (start < 0) throw new Error("L1: For call not found");
  const childrenAt = code.indexOf("children: ", start);
  const end = code.indexOf("}), tbody);", childrenAt);
  if (childrenAt < 0 || end < 0) throw new Error("L1: For children not found");
  const children = code.slice(childrenAt + "children: ".length, end).trimEnd();
  const body = `dispose = createRoot(d => { __forNodes(tbody, () => rows(), ${children}); return d; });`;
  code = code.slice(0, start) + body + code.slice(end + "}), tbody);".length);
  return edit(code, IMPORT, IMPORT + FOR_NODES, "L1 import");
}

const STACK = { c1: true, h7: true, l1: true, h8b: true, sf: true };
const without = k => ({ ...STACK, [k]: false });

/** Markers that must be present (+) or absent (-) in the generated module. */
export function listMarkers(f) {
  const m = [];
  m.push([f.c1 ? "-" : "+", "_$createComponent(Row"]);
  m.push([f.l1 ? "+" : "-", "__forNodes(tbody"]);
  m.push([f.l1 ? "-" : "+", "_$createComponent(For"]);
  m.push([f.h7 ? "+" : "-", ".data = v"]);
  m.push([f.h7 ? "-" : "+", "_$insert(_el$"]);
  m.push([f.h7 ? "-" : "+", "_$readShallow("]);
  m.push([f.h8b ? "+" : "-", `oracle: ${DETACHED_BITS}`]);
  m.push([f.sf && !f.fuseShared ? "+" : "-", "__statusFree);"]);
  m.push([f.fuseShared ? "+" : "-", "equals: (a, b) => a === b"]);
  m.push([f.fuseShared ? "-" : "+", "createMemo(() => selected() === row.id"]);
  return m;
}
/** Expected count of `oracle: <bits>` sites (id, label, class). */
export function detachedSites(f) {
  if (!f.h8b) return 0;
  return (f.h7 ? (f.h8bLabel === false ? 1 : 2) : 0) + (f.fuseShared ? 0 : 1);
}

const defs = {
  baseline: [{}, "prod"],
  control: [{}, "oracle"],
  "baseline@sync": [{}, "sync"],
  STACK: [STACK, "oracle"],
  "STACK+fuseShared": [{ ...STACK, fuseShared: true }, "oracle"],
  "STACK-C1": [without("c1"), "oracle"],
  "STACK-H7": [without("h7"), "oracle"],
  "STACK-L1": [without("l1"), "oracle"],
  "STACK-H8b": [without("h8b"), "oracle"],
  "STACK-SF": [without("sf"), "oracle"],
  // Sound H8b: the label signal is created in build(), outside the row, and
  // survives the row (removeAdd), so the label effect does not qualify.
  "STACK-H8bLabel": [{ ...STACK, h8bLabel: false }, "oracle"],
  "STACK@oracle-sync": [STACK, "oracle-sync"]
};
export const LIST_VARIANTS = Object.fromEntries(
  Object.entries(defs).map(([name, [flags, runtime]]) => [
    name,
    { runtime, flags, source: listVariant(flags), markers: listMarkers(flags), detached: detachedSites(flags) }
  ])
);
