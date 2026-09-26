// Heuristic-oracle scenarios (documentation/plans/heuristic-oracles.md).
//
// Every scenario is handwritten Solid written once as the idiomatic baseline
// and once per oracle: the same program with an assumed-true fact applied BY
// HAND — a node option the `dist/oracle` runtime honours (`oracle` bits,
// effect `equals`) or a source rewrite a compiler would perform. No compiler
// is involved: the point is to price each heuristic before building its proof.
//
// Module shape: `make(n)` → `{ mount(), unmount(), ops: { name: fn } }`.
// `mount` creates the graph under one root and flushes; the harness measures
// `mount` as create + flush + dispose, and each op as one write + flush on a
// mounted graph.
//
// Oracle bit values mirror packages/signals/src/core/constants.ts.
export const ORACLE_DIRECT = 1 << 23;
export const ORACLE_LOCAL = 1 << 24;

const HEADER = `import { createMemo, createRenderEffect, createRoot, createSignal, flush } from "@solidjs/signals";
const DIRECT = ${ORACLE_DIRECT}, LOCAL = ${ORACLE_LOCAL};
const same = (a, b) => a === b;`;

/** Track A variants import the shipped host options; importing `statusFree`
 * installs the status-free recompute hook, so only these modules pay it. */
const withTrackA = source =>
  source.replace(
    "import { createMemo,",
    "import { statusFree, syncOnly, createMemo,"
  );

/**
 * js-framework-benchmark rows without the DOM: per row a label signal, an
 * `isSelected` memo over one shared `selected` signal, and two render effects
 * (text, class). The shape `<tr class={isSelected() ? "danger" : ""}>` and
 * `{label()}` compile to.
 */
function rows({ memo = "", labelFx = "", selFx = "", fused = false, grouped = false } = {}) {
  // H6: the row's two bindings as one effect with per-part change checks,
  // the shape a compiler emits for several dynamic parts of one element.
  const groupedBody = `createRenderEffect(() => [label(), ${fused ? "selected() === id" : "isSel()"}], (v, p) => {
      if (!p || v[0] !== p[0]) { sink.runs++; sink.text = v[0]; }
      if (!p || v[1] !== p[1]) { sink.runs++; if (v[1]) sink.sel = id; }
    });`;
  if (grouped)
    return rowsModule(`const [label, setLabel] = createSignal("row " + id);
    ${fused ? "" : `const isSel = createMemo(() => selected() === id);`}
    ${groupedBody}`);
  const selection = fused
    ? `createRenderEffect(() => selected() === id, v => { sink.runs++; if (v) sink.sel = id; }, { equals: same${selFx} });`
    : `const isSel = createMemo(() => selected() === id${memo ? (memo.startsWith("...") ? `, ${memo.slice(3)}` : `, { ${memo} }`) : ""});
      createRenderEffect(() => isSel(), v => { sink.runs++; if (v) sink.sel = id; }${selFx ? `, { ${selFx.slice(2)} }` : ""});`;
  return rowsModule(`const [label, setLabel] = createSignal("row " + id);
    createRenderEffect(() => label(), v => { sink.runs++; sink.text = v; }${labelFx ? `, { ${labelFx} }` : ""});
    ${selection}`);
}

function rowsModule(rowBody) {
  return `${HEADER}
export function make(n) {
  const [selected, setSelected] = createSignal(-1);
  const sink = { runs: 0, text: "", sel: -1 };
  let rows, dispose, round = 0;
  function Row(id) {
    ${rowBody}
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
    sink,
    unmount() { dispose(); },
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
}

/**
 * A two-memo derivation per item feeding one render effect: `scaled` then a
 * template string, the typical `style={\`\${size() * 2 + 1}px\`}` chain.
 */
function chain({ memo = "", fusedLabel = false, fusedAll = false, fx = "" } = {}) {
  // `...name` passes a shared options object (Track A's compiled host options).
  const opt = memo ? (memo.startsWith("...") ? `, ${memo.slice(3)}` : `, { ${memo} }`) : "";
  let body;
  if (fusedAll)
    body = `createRenderEffect(() => \`\${count() * 2 + 1}px\`, v => { sink.runs++; sink.v = v; }, { equals: same${fx} });`;
  else if (fusedLabel)
    body = `const scaled = createMemo(() => count() * 2 + 1${opt});
          createRenderEffect(() => \`\${scaled()}px\`, v => { sink.runs++; sink.v = v; }, { equals: same${fx} });`;
  else
    body = `const scaled = createMemo(() => count() * 2 + 1${opt});
          const label = createMemo(() => \`\${scaled()}px\`${opt});
          createRenderEffect(() => label(), v => { sink.runs++; sink.v = v; }${fx ? `, { ${fx.slice(2)} }` : ""});`;
  return `${HEADER}
export function make(n) {
  const [count, setCount] = createSignal(0);
  const sink = { runs: 0, v: "" };
  let dispose;
  return {
    mount() {
      dispose = createRoot(d => {
        for (let i = 0; i < n; i++) {
          ${body}
        }
        return d;
      });
      flush();
    },
    sink,
    unmount() { dispose(); },
    ops: { update() { setCount(c => c + 1); flush(); } }
  };
}`;
}

/**
 * TodoMVC without stores: per item `done` and `title` signals, a `visible`
 * memo over the shared filter, render effects for class, text and display, and
 * one `remaining` aggregate that reads every item.
 */
function todos({ memo = "", fx = "", fusedVisible = false, title = "signal" } = {}) {
  // H4: \`title\` has no setter anywhere, so it is a constant ("const");
  // H4+H5: a binding with no reactive read left needs no effect ("static").
  const titleDecl =
    title === "signal" ? `const [title] = createSignal("todo " + i);` : `const title = () => "todo " + i;`;
  const titleBinding =
    title === "static"
      ? `sink.runs++; sink.text = title();`
      : `createRenderEffect(() => title(), v => { sink.runs++; sink.text = v; }${fx ? `, { ${fx} }` : ""});`;
  const opt = memo ? `, { ${memo} }` : "";
  const fxOpt = fx ? `, { ${fx} }` : "";
  const visible = fusedVisible
    ? `createRenderEffect(() => filter() === "all" || (filter() === "done") === done(), v => { sink.runs++; sink.shown = v; }, { equals: same${fx ? `, ${fx}` : ""} });`
    : `const visible = createMemo(() => filter() === "all" || (filter() === "done") === done()${opt});
      createRenderEffect(() => visible(), v => { sink.runs++; sink.shown = v; }${fxOpt});`;
  return `${HEADER}
export function make(n) {
  const [filter, setFilter] = createSignal("all");
  const sink = { runs: 0, cls: "", text: "", shown: true, left: 0 };
  let items, dispose, round = 0;
  function Item(i) {
    const [done, setDone] = createSignal(false);
    ${titleDecl}
    createRenderEffect(() => (done() ? "completed" : ""), v => { sink.runs++; sink.cls = v; }${fxOpt});
    ${titleBinding}
    ${visible}
    return { done, setDone };
  }
  return {
    mount() {
      dispose = createRoot(d => {
        items = [];
        for (let i = 0; i < n; i++) items.push(Item(i));
        const remaining = createMemo(() => {
          let c = 0;
          for (let i = 0; i < items.length; i++) if (!items[i].done()) c++;
          return c;
        }${opt});
        createRenderEffect(() => remaining(), v => { sink.runs++; sink.left = v; });
        return d;
      });
      flush();
    },
    sink,
    unmount() { dispose(); },
    ops: {
      toggle() { const it = items[round++ % n]; it.setDone(!it.done()); flush(); },
      filter() { setFilter(["all", "done", "active"][round++ % 3]); flush(); }
    }
  };
}`;
}

/**
 * Oracles:
 *   H1 fuse   — a memo whose only reader is one render effect is inlined into
 *               it; the effect keeps the memo's equality cut-off (`equals`).
 *   H2 direct — memos commit directly instead of staging (CONFIG_ORACLE_DIRECT).
 *   H3 local  — nodes whose sources all die with them skip unlinking at
 *               disposal (CONFIG_ORACLE_LOCAL). Only nodes that really are
 *               local get the bit: `isSelected`/`visible` read a shared signal.
 *   H4 const  — a signal whose setter is never used is a plain value.
 *   H5 static — a binding left with no reactive read runs once, no effect node.
 *   H6 group  — one element's bindings share one effect with per-part checks.
 *   H5 status-free / sync-only — Track A stage 1's shipped host options
 *               (`statusFree`, `syncOnly`) on the memos they would be proven
 *               for, re-measured with steady-state warmups (prod runtime).
 * Each scenario lists which variants apply; `control` runs the baseline source
 * on the oracle runtime to price the oracle arms themselves.
 */
export const SCENARIOS = [
  {
    name: "rows",
    variants: {
      baseline: rows(),
      "H1-fuse": rows({ fused: true }),
      "H2-direct": rows({ memo: "oracle: DIRECT" }),
      "H3-local": rows({ labelFx: "oracle: LOCAL", selFx: ", oracle: LOCAL" }),
      "H1+H3": rows({ fused: true, labelFx: "oracle: LOCAL" }),
      "H6-group": rows({ grouped: true }),
      "H5-statusFree": withTrackA(rows({ memo: "...statusFree" })),
      "H5-syncOnly": withTrackA(rows({ memo: "...syncOnly" })),
      "H1+H6": rows({ fused: true, grouped: true })
    }
  },
  {
    name: "chain",
    variants: {
      baseline: chain(),
      "H1-fuse": chain({ fusedLabel: true }),
      "H1-fuse-all": chain({ fusedAll: true }),
      "H2-direct": chain({ memo: "oracle: DIRECT" }),
      "H5-statusFree": withTrackA(chain({ memo: "...statusFree" })),
      "H5-syncOnly": withTrackA(chain({ memo: "...syncOnly" }))
    }
  },
  {
    name: "todos",
    variants: {
      baseline: todos(),
      "H1-fuse": todos({ fusedVisible: true }),
      "H2-direct": todos({ memo: "oracle: DIRECT" }),
      "H3-local": todos({ fx: "oracle: LOCAL" }),
      "H4-const": todos({ title: "const" }),
      "H4+H5-static": todos({ title: "static" }),
      "H1+H4+H5": todos({ fusedVisible: true, title: "static" })
    }
  }
];
