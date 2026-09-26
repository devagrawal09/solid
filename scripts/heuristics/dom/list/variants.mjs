// List + component oracle variants (DOM, Chromium). Sources are JSX compiled
// by the real compiler; oracle-only steps are small, named edits of that
// output. Every variant must pass the same tbody-HTML equivalence gate.
//
//   baseline      keyed <For> over a Row component; the per-row `isSel` memo
//                 reaches Row's class binding through a props getter.
//   C1-inline     cross-component: Row inlined into the For callback (props
//                 object and getter indirection gone, memo kept).
//   C2-fuse       C1 + the memo fused into its now-local single reader, the
//                 class binding, keeping its equality cut-off.
//   L1-nodes      specialized list: each row is proven to render exactly one
//                 element, so the mapped array goes straight to the DOM
//                 reconciler (no flatten / normalize / insertExpression
//                 dispatch). Row owners and the keyed diff are unchanged.
//   C2+L1         both.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT } from "../../common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
const compile = (src, name) => transform(src, { filename: `${name}.jsx`, generate: "dom" }).code;

const baselineSrc = readFileSync(join(here, "baseline.jsx"), "utf8");

// C1: the author's Row body, inlined at its only call site.
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
  return code.replace(from, to);
}

// C2: remove the memo, read the source in the binding, keep `equals`.
function fuse(code) {
  code = edit(code, "const isSel = createMemo(() => selected() === row.id);", "", "fuse memo");
  code = edit(code, "isSel() ?", "selected() === row.id ?", "fuse read");
  // The class effect is the only `_$effect(` in the inlined row.
  const at = code.indexOf("_$className(");
  const close = code.indexOf("});", at);
  if (at < 0 || close < 0) throw new Error("fuse: class effect not found");
  return code.slice(0, close) + "}, { equals: (a, b) => a === b });" + code.slice(close + 3);
}

// L1: the For call replaced by a list whose rows are single elements.
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
  // render(() => _$createComponent(For, { get each() { return rows(); }, children: CB }), tbody)
  const start = code.indexOf("dispose = render(() => _$createComponent(For, {");
  if (start < 0) throw new Error("L1: For call not found");
  const childrenAt = code.indexOf("children: ", start);
  const end = code.indexOf("}), tbody);", childrenAt);
  if (childrenAt < 0 || end < 0) throw new Error("L1: For children not found");
  let children = code.slice(childrenAt + "children: ".length, end).trimEnd();
  const body = `dispose = createRoot(d => { __forNodes(tbody, () => rows(), ${children}); return d; });`;
  code = code.slice(0, start) + body + code.slice(end + "}), tbody);".length);
  code = edit(code, 'import { createMemo, createRoot, createSignal, flush, For } from "solid-js";',
    'import { createMemo, createRoot, createSignal, flush, For } from "solid-js";' + FOR_NODES, "L1 import");
  return code;
}

const baseline = compile(baselineSrc, "baseline");
const c1 = compile(inlineSrc, "inline");
const c2 = fuse(c1);

export const LIST_VARIANTS = {
  baseline: { runtime: "prod", source: baseline },
  "C1-inline": { runtime: "prod", source: c1 },
  "C2-fuse": { runtime: "oracle", source: c2 },
  "L1-nodes": { runtime: "prod", source: nodesList(baseline) },
  "C2+L1": { runtime: "oracle", source: nodesList(c2) },
  control: { runtime: "oracle", source: baseline }
};
