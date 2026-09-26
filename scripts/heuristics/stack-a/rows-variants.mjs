// Stack A, rows suite (js-framework-benchmark shape without <For>; see
// scripts/heuristics/dom/variants.mjs). Edits of that suite's baseline and
// H7-text sources.
//
//   STACK       H7 typed text + H8b (OWNERLESS | DETACHED) on the label text
//               effect + statusFree on isSel.
//   STACK-H7    text back to `insert`. `insert` takes no node options (and
//               may own inner effects), so H8b has no site: this cell is
//               statusFree alone.
//   STACK-H8b   H7 + statusFree.
//   STACK-SF    H7 + H8b.
//   STACK+H8b-class   STACK plus the class effect detached as well (it reads
//               only the row-local isSel memo). Not part of the specified
//               stack; measured as an extra.
import { DOM_VARIANTS } from "../dom/variants.mjs";

export const DETACHED_BITS = (1 << 26) | (1 << 27);
const MEMO = "const isSel = createMemo(() => selected() === id);";
const IMPORT = 'import { createMemo, createRoot, createSignal, flush } from "solid-js";';
const LABEL_H7 = "_$effect(label, v => { _t$.data = v; });";
const CLASS_H7 = `_$effect(() => (isSel() ? "danger" : ""), (v, p) => { v !== p && _el$.setAttribute("class", v); });`;

function edit(code, from, to, what) {
  if (!code.includes(from)) throw new Error(`${what}: pattern not found`);
  return code.split(from).join(to);
}

export function rowsVariant({ h7 = false, h8b = false, sf = false, h8bClass = false }) {
  let code = (h7 ? DOM_VARIANTS["H7-text"] : DOM_VARIANTS.baseline).source;
  if (sf) {
    code = edit(code, MEMO, "const isSel = createMemo(() => selected() === id, __statusFree);", "statusFree");
    code = edit(code, IMPORT, IMPORT + '\nimport { statusFree as __statusFree } from "solid-js";', "statusFree import");
  }
  if (h8b && h7)
    code = edit(code, LABEL_H7, `_$effect(label, v => { _t$.data = v; }, { oracle: ${DETACHED_BITS} });`, "H8b label");
  if (h8bClass) {
    if (!h7) throw new Error("h8bClass is defined on the H7 source");
    code = edit(code, CLASS_H7, CLASS_H7.slice(0, -2) + `, { oracle: ${DETACHED_BITS} });`, "H8b class");
  }
  return code;
}

export function rowsMarkers(f) {
  return [
    [f.h7 ? "+" : "-", "_t$.data = v"],
    [f.h7 ? "-" : "+", "_$insert(_el$3, label)"],
    [f.h7 ? "-" : "+", "_$readShallow("],
    [f.sf ? "+" : "-", "__statusFree);"],
    [(f.h8b && f.h7) || f.h8bClass ? "+" : "-", `oracle: ${DETACHED_BITS}`]
  ];
}
export function detachedSites(f) {
  return (f.h8b && f.h7 ? 1 : 0) + (f.h8bClass ? 1 : 0);
}

const STACK = { h7: true, h8b: true, sf: true };
const defs = {
  baseline: [{}, "prod"],
  control: [{}, "oracle"],
  "baseline@sync": [{}, "sync"],
  STACK: [STACK, "oracle"],
  "STACK-H7": [{ ...STACK, h7: false }, "oracle"],
  "STACK-H8b": [{ ...STACK, h8b: false }, "oracle"],
  "STACK-SF": [{ ...STACK, sf: false }, "oracle"],
  "STACK+H8b-class": [{ ...STACK, h8bClass: true }, "oracle"],
  "STACK@oracle-sync": [STACK, "oracle-sync"]
};
export const ROWS_VARIANTS = Object.fromEntries(
  Object.entries(defs).map(([name, [flags, runtime]]) => [
    name,
    { runtime, flags, source: rowsVariant(flags), markers: rowsMarkers(flags), detached: detachedSites(flags) }
  ])
);
