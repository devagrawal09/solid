// DOM oracle variants: hand edits of the real compiler's output for rows.jsx
// (`node scripts/heuristics/dom/bench.mjs --print-baseline` shows it). Each
// variant is what a compiler holding one more fact would emit.
//
//   baseline   the compiler output, verbatim.
//   H7-text    typed text: `id: number`, `label(): string` and a string
//              class value are known, so children are text-node writes (no
//              generic insert: no flatten/normalize, arrays, nodes,
//              functions) and the class skips readShallow (no store proxy).
//   H7-group   H7-text plus one effect for the whole template (class + text):
//              grouping children with attributes needs the same type fact,
//              since an untyped child may be a node list the effect cannot
//              diff.
//   H1-fuse    the `isSel` memo inlined into its only reader (the class
//              effect), keeping its equality cut-off (`equals`; oracle runtime).
//   H1+H7      both.
const HEAD = `import { createMemo, createRoot, createSignal, flush } from "solid-js";
import { template as _$template, insert as _$insert, readShallow as _$readShallow, className as _$className, effect as _$effect } from "@solidjs/web";
const same = (a, b) => a === b;`;

const TMPL = "var _tmpl$ = /* @__PURE__ */ _$template(`<tr><td class=col-md-1></td><td class=col-md-4>`);";
// Typed text: the template carries the text nodes, the compiler writes .data.
const TMPL_TEXT = "var _tmpl$ = /* @__PURE__ */ _$template(`<tr><td class=col-md-1> </td><td class=col-md-4> `);";

const shell = (tmpl, rowBody) => `${HEAD}
${tmpl}
export function make(n, tbody) {
  const [selected, setSelected] = createSignal(-1);
  let rows, dispose, round = 0;
  function Row(id) {
    const [label, setLabel] = createSignal("row " + id);
    ${rowBody}
    tbody.appendChild(_el$);
    return setLabel;
  }
  return {
    mount() {
      dispose = createRoot(d => {
        rows = [];
        for (let i = 0; i < n; i++) rows.push(Row(i));
        return d;
      });
      flush();
    },
    unmount() { dispose(); tbody.textContent = ""; },
    ops: {
      update10th() {
        round++;
        for (let i = 0; i < n; i += 10) rows[i]("row " + i + " !" + round);
        flush();
      },
      select() { setSelected(++round % n); flush(); }
    }
  };
}`;

const els = `var _el$ = _tmpl$();
    var _el$2 = _el$.firstChild;
    var _el$3 = _el$2.nextSibling;`;

export const DOM_VARIANTS = {
  baseline: {
    runtime: "prod",
    source: shell(
      TMPL,
      `const isSel = createMemo(() => selected() === id);
    ${els}
    _$insert(_el$2, id);
    _$insert(_el$3, label);
    _$effect(() => _$readShallow(isSel() ? "danger" : ""), (_v$, _$p) => { _$className(_el$, _v$, _$p); });`
    )
  },
  "H7-text": {
    runtime: "prod",
    source: shell(
      TMPL_TEXT,
      `const isSel = createMemo(() => selected() === id);
    ${els}
    _el$2.firstChild.data = id;
    const _t$ = _el$3.firstChild;
    _$effect(label, v => { _t$.data = v; });
    _$effect(() => (isSel() ? "danger" : ""), (v, p) => { v !== p && _el$.setAttribute("class", v); });`
    )
  },
  "H7-group": {
    runtime: "prod",
    source: shell(
      TMPL_TEXT,
      `const isSel = createMemo(() => selected() === id);
    ${els}
    _el$2.firstChild.data = id;
    const _t$ = _el$3.firstChild;
    _$effect(() => ({ e: isSel() ? "danger" : "", t: label() }), (v, p) => {
      v.e !== p?.e && _el$.setAttribute("class", v.e);
      v.t !== p?.t && (_t$.data = v.t);
    });`
    )
  },
  "H1-fuse": {
    runtime: "oracle",
    source: shell(
      TMPL,
      `${els}
    _$insert(_el$2, id);
    _$insert(_el$3, label);
    _$effect(() => _$readShallow(selected() === id ? "danger" : ""), (_v$, _$p) => { _$className(_el$, _v$, _$p); }, { equals: same });`
    )
  },
  "H1+H7": {
    runtime: "oracle",
    source: shell(
      TMPL_TEXT,
      `${els}
    _el$2.firstChild.data = id;
    const _t$ = _el$3.firstChild;
    _$effect(label, v => { _t$.data = v; });
    _$effect(() => (selected() === id ? "danger" : ""), (v, p) => { v !== p && _el$.setAttribute("class", v); }, { equals: same });`
    )
  },
  // Control: the baseline on the oracle runtime prices the oracle arms.
  "control": { runtime: "oracle", source: null }
};
DOM_VARIANTS.control.source = DOM_VARIANTS.baseline.source;
