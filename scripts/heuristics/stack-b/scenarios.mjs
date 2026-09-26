// Stack-B signal-level scenarios (documentation/plans/heuristic-oracles/stack-b).
//
// Same module shape as ../scenarios.mjs: `make(n)` → { mount, unmount, sink,
// ops }. Every program is written by hand once per variant; an oracle is a
// node option the `dist/oracle` runtime honours (`oracle` bits, effect
// `equals`) or a source rewrite a compiler would perform (memo fusion).
//
// Node options are built per node from what a compiler could prove about
// THAT node, never blanket-applied:
//   fuse  — memo inlined into its only tracked reader, the reader keeps the
//           memo's cut-off (`equals: same`, which sets CONFIG_ORACLE_FUSED).
//   DET   — OWNERLESS | DETACHED (H8b): the compute creates nothing, has no
//           cleanup, reads no context, and every source dies with it.
//   OWN   — OWNERLESS only (H8a).
//   SF    — Track A's `statusFree` host option (sync + non-throwing).
export const ORACLE_OWNERLESS = 1 << 26;
export const ORACLE_DETACHED = 1 << 27;

function header({ sf = false, projection = false } = {}) {
  const names = ["createMemo", "createRenderEffect", "createRoot", "createSignal", "flush"];
  if (projection) names.push("createProjection");
  if (sf) names.unshift("statusFree");
  return `import { ${names.join(", ")} } from "@solidjs/signals";
const OWNERLESS = ${ORACLE_OWNERLESS}, DETACHED = ${ORACLE_DETACHED};
const OWN = OWNERLESS, DET = OWNERLESS | DETACHED;
const same = (a, b) => a === b;`;
}

/** `, { ...statusFree, equals: same, oracle: DET }` or "" */
function opts({ sf = false, equals = false, oracle = "" } = {}) {
  const parts = [];
  if (sf) parts.push("...statusFree");
  if (equals) parts.push("equals: same");
  if (oracle) parts.push(`oracle: ${oracle}`);
  return parts.length ? `, { ${parts.join(", ")} }` : "";
}

const rootOpen = "createRoot(d => {";
const rootClose = ids => (ids ? `}, { id: "r" })` : "})");

/* ------------------------------------------------------------------ Q1 --- */

/**
 * Rows with selection (js-framework-benchmark shape, no DOM): per row a label
 * signal with its text binding, and a class binding that says whether the
 * row is selected. Selection is modelled three ways:
 *   memo  — `isSel = createMemo(() => selected() === id)` per row (today)
 *   fused — H1 applied to that memo: the class binding reads `selected()`
 *   proj  — one `createProjection` keyed by id whose derive flips only the
 *           old and the new key; the class binding reads `isSelected[id]`
 *           (the idiom of packages/signals/tests/store/createProjection.test.ts
 *           "selection" test).
 * `stack` adds every oracle a compiler could license on the oracle runtime:
 * H8b on the label binding (its only source is row-local), H8b on the memo's
 * reader (the memo is row-local), H8a only on the nodes that read a shared
 * source, and statusFree on every compute.
 */
export function sel({ mode = "memo", sf = false, stack = false, sfMemoOnly = false, stack2 = false } = {}) {
  if (stack2) {
    // Refined stack (added after run 1): only the parts that measured as
    // wins — H8b where it qualifies, statusFree on memos only, no H8a.
    const src = sel({ mode });
    let out = src.replace("createRenderEffect(() => label(), v => { sink.runs++; sink.text = v; });",
      "createRenderEffect(() => label(), v => { sink.runs++; sink.text = v; }, { oracle: DET });");
    if (mode === "memo")
      out = out
        .replace("import { createMemo,", "import { statusFree, createMemo,")
        .replace("createMemo(() => selected() === id)", "createMemo(() => selected() === id, statusFree)")
        .replace("createRenderEffect(() => isSel(), v => { sink.runs++; if (v) sink.sel = id; });",
          "createRenderEffect(() => isSel(), v => { sink.runs++; if (v) sink.sel = id; }, { oracle: DET });");
    if (out === src) throw new Error("stack2: no edit");
    return out;
  }
  const SF = sf || stack;
  const labelFx = opts({ sf: SF, oracle: stack ? "DET" : "" });
  if (sfMemoOnly)
    // Track A's original placement: statusFree on the isSelected memo only.
    return sel({ mode: "memo" })
      .replace('import { createMemo,', 'import { statusFree, createMemo,')
      .replace("createMemo(() => selected() === id)", "createMemo(() => selected() === id, statusFree)");
  let selection;
  if (mode === "memo")
    selection = `const isSel = createMemo(() => selected() === id${opts({ sf: SF, oracle: stack ? "OWN" : "" })});
    createRenderEffect(() => isSel(), v => { sink.runs++; if (v) sink.sel = id; }${opts({ sf: SF, oracle: stack ? "DET" : "" })});`;
  else if (mode === "fused")
    selection = `createRenderEffect(() => selected() === id, v => { sink.runs++; if (v) sink.sel = id; }${opts({ sf: SF, equals: true, oracle: stack ? "OWN" : "" })});`;
  else
    selection = `createRenderEffect(() => isSelected[id], v => { sink.runs++; if (v) sink.sel = id; }${opts({ sf: SF, oracle: stack ? "OWN" : "" })});`;
  const projection =
    mode === "proj"
      ? `let prev;
        isSelected = createProjection(draft => {
          const s = selected();
          if (prev !== undefined && prev !== s) delete draft[prev];
          if (s >= 0) draft[s] = true;
          prev = s;
        }, {});`
      : "";
  return `${header({ sf: SF, projection: mode === "proj" })}
export function make(n) {
  const [selected, setSelected] = createSignal(-1);
  const sink = { runs: 0, text: "", sel: -1 };
  let rows, dispose, isSelected, round = 0;
  function Row(id) {
    const [label, setLabel] = createSignal("row " + id);
    createRenderEffect(() => label(), v => { sink.runs++; sink.text = v; }${labelFx});
    ${selection}
    return setLabel;
  }
  return {
    mount() {
      dispose = ${rootOpen}
        ${projection}
        rows = [];
        for (let i = 0; i < n; i++) rows.push(Row(i));
        return d;
      ${rootClose(false)};
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

/* --------------------------------------------------------------- Q2/Q3 --- */
// Policies: a = no fusion; b = fuse single-reader memos whose sources are all
// local (die with the memo's scope); c = fuse every single-reader memo.
// `det` adds H8b on every node that qualifies; `ids` gives the root an id.

/** rows: `isSel` reads the shared `selected` → fused only under (c). */
export function rows({ policy = "a", det = false, ids = false } = {}) {
  const fuse = policy === "c";
  const selection = fuse
    ? // Reads a shared source: never detached.
      `createRenderEffect(() => selected() === id, v => { sink.runs++; if (v) sink.sel = id; }${opts({ equals: true })});`
    : `const isSel = createMemo(() => selected() === id);
    createRenderEffect(() => isSel(), v => { sink.runs++; if (v) sink.sel = id; }${opts({ oracle: det ? "DET" : "" })});`;
  return `${header()}
export function make(n) {
  const [selected, setSelected] = createSignal(-1);
  const sink = { runs: 0, text: "", sel: -1 };
  let rows, dispose, round = 0;
  function Row(id) {
    const [label, setLabel] = createSignal("row " + id);
    createRenderEffect(() => label(), v => { sink.runs++; sink.text = v; }${opts({ oracle: det ? "DET" : "" })});
    ${selection}
    return setLabel;
  }
  return {
    mount() {
      dispose = ${rootOpen}
        rows = [];
        for (let i = 0; i < n; i++) rows.push(Row(i));
        return d;
      ${rootClose(ids)};
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

/** chain: `count` (shared) → `scaled` → `label` → binding. `label` reads only
 * the item-local `scaled` → fused under (b); `scaled` reads `count` → (c). */
export function chain({ policy = "a", det = false, ids = false } = {}) {
  const fx = opts({ equals: policy !== "a", oracle: det ? "DET" : "" });
  let body;
  if (policy === "c")
    body = `createRenderEffect(() => \`\${count() * 2 + 1}px\`, v => { sink.runs++; sink.v = v; }${opts({ equals: true })});`;
  else if (policy === "b")
    body = `const scaled = createMemo(() => count() * 2 + 1);
          createRenderEffect(() => \`\${scaled()}px\`, v => { sink.runs++; sink.v = v; }${fx});`;
  else
    body = `const scaled = createMemo(() => count() * 2 + 1);
          const label = createMemo(() => \`\${scaled()}px\`${opts({ oracle: det ? "DET" : "" })});
          createRenderEffect(() => label(), v => { sink.runs++; sink.v = v; }${fx});`;
  return `${header()}
export function make(n) {
  const [count, setCount] = createSignal(0);
  const sink = { runs: 0, v: "" };
  let dispose;
  return {
    mount() {
      dispose = ${rootOpen}
        for (let i = 0; i < n; i++) {
          ${body}
        }
        return d;
      ${rootClose(ids)};
      flush();
    },
    sink,
    unmount() { dispose(); },
    ops: { update() { setCount(c => (c + 1) % 1000); flush(); } }
  };
}`;
}

/** todos: `visible` reads the shared filter → (c) only; the root-level
 * `remaining` aggregate reads only item signals created under the same root
 * and has one reader → fused under (b) and (c). */
export function todos({ policy = "a", det = false, ids = false } = {}) {
  const DETo = det ? "DET" : "";
  const visible =
    policy === "c"
      ? `createRenderEffect(() => filter() === "all" || (filter() === "done") === done(), v => { sink.runs++; sink.shown = v; }${opts({ equals: true })});`
      : `const visible = createMemo(() => filter() === "all" || (filter() === "done") === done());
      createRenderEffect(() => visible(), v => { sink.runs++; sink.shown = v; }${opts({ oracle: DETo })});`;
  const count = `{
          let c = 0;
          for (let i = 0; i < items.length; i++) if (!items[i].done()) c++;
          return c;
        }`;
  const remaining =
    policy === "a"
      ? `const remaining = createMemo(() => ${count});
        createRenderEffect(() => remaining(), v => { sink.runs++; sink.left = v; }${opts({ oracle: DETo })});`
      : `createRenderEffect(() => ${count}, v => { sink.runs++; sink.left = v; }${opts({ equals: true, oracle: DETo })});`;
  return `${header()}
export function make(n) {
  const [filter, setFilter] = createSignal("all");
  const sink = { runs: 0, cls: "", text: "", shown: true, left: 0 };
  let items, dispose, round = 0;
  function Item(i) {
    const [done, setDone] = createSignal(false);
    const [title] = createSignal("todo " + i);
    createRenderEffect(() => (done() ? "completed" : ""), v => { sink.runs++; sink.cls = v; }${opts({ oracle: DETo })});
    createRenderEffect(() => title(), v => { sink.runs++; sink.text = v; }${opts({ oracle: DETo })});
    ${visible}
    return { done, setDone };
  }
  return {
    mount() {
      dispose = ${rootOpen}
        items = [];
        for (let i = 0; i < n; i++) items.push(Item(i));
        ${remaining}
        return d;
      ${rootClose(ids)};
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
 * dash: a monitoring dashboard. Three shared sources (time range, unit,
 * alert threshold); per widget two local signals (name, raw value) and five
 * derived memos with mixed reader counts; two root aggregates.
 *
 *   memo      sources          readers                          (b)   (c)
 *   scaled    raw, range*      display, alert, total  (3)       –     –
 *   title     name             title text             (1)       fuse  fuse
 *   bar       raw              bar style              (1)       fuse  fuse
 *   display   scaled, unit*    value text             (1)       –     fuse
 *   alert     scaled, thresh*  class, note, overCount (3)       –     –
 *   note      raw              note binding, read only when alert() (1, conditional)
 *                                                                fuse  fuse
 *   total     every scaled     total text             (1)       fuse  fuse
 *   overCount every alert      header text, badge     (2)       –     –
 *   (* = shared source, outlives the widget)
 */
export function dash({ policy = "a", det = false, ids = false, only = "" } = {}) {
  // `only` (attribution): "widget" fuses title/bar/note but not total; "total" fuses only total.
  const b = policy !== "a" && only !== "total";
  const bt = policy !== "a" && only !== "widget";
  const c = policy === "c";
  const D = det ? "DET" : "";
  const fx = (fused, detOk) => opts({ equals: fused, oracle: detOk ? D : "" });
  const lines = [];
  lines.push(`const scaled = createMemo(() => raw() * FACTORS[range()]);`);
  if (b)
    lines.push(
      `createRenderEffect(() => name().toUpperCase(), v => { sink.runs++; sink.title = v; }${fx(true, true)});`,
      `createRenderEffect(() => Math.min(100, raw()) + "%", v => { sink.runs++; sink.bar = v; }${fx(true, true)});`
    );
  else
    lines.push(
      `const title = createMemo(() => name().toUpperCase());`,
      `const bar = createMemo(() => Math.min(100, raw()) + "%");`,
      `createRenderEffect(() => title(), v => { sink.runs++; sink.title = v; }${fx(false, true)});`,
      `createRenderEffect(() => bar(), v => { sink.runs++; sink.bar = v; }${fx(false, true)});`
    );
  if (c)
    // Fused display reads the shared unit: not detached.
    lines.push(`createRenderEffect(() => scaled() + " " + unit(), v => { sink.runs++; sink.text = v; }${fx(true, false)});`);
  else
    lines.push(
      `const display = createMemo(() => scaled() + " " + unit());`,
      `createRenderEffect(() => display(), v => { sink.runs++; sink.text = v; }${fx(false, true)});`
    );
  lines.push(
    `const alert = createMemo(() => scaled() > threshold());`,
    `createRenderEffect(() => alert(), v => { sink.runs++; if (v) sink.alert = i; }${fx(false, true)});`
  );
  if (b)
    lines.push(`createRenderEffect(() => (alert() ? (raw() * 7) % 13 : -1), v => { sink.runs++; sink.note = v; }${fx(true, true)});`);
  else
    lines.push(
      `const note = createMemo(() => (raw() * 7) % 13);`,
      `createRenderEffect(() => (alert() ? note() : -1), v => { sink.runs++; sink.note = v; }${fx(false, true)});`
    );
  const totalBody = `{
          let t = 0;
          for (let i = 0; i < items.length; i++) t += items[i].scaled();
          return t;
        }`;
  const total = bt
    ? `createRenderEffect(() => ${totalBody}, v => { sink.runs++; sink.total = v; }${fx(true, true)});`
    : `const total = createMemo(() => ${totalBody});
        createRenderEffect(() => total(), v => { sink.runs++; sink.total = v; }${fx(false, true)});`;
  return `${header()}
const FACTORS = [1, 2, 5];
export function make(n) {
  const [range, setRange] = createSignal(0);
  const [unit, setUnit] = createSignal("ms");
  const [threshold, setThreshold] = createSignal(100);
  const sink = { runs: 0, title: "", bar: "", text: "", alert: -1, note: 0, total: 0, over: 0, badge: "" };
  let items, dispose, round = 0;
  function Widget(i) {
    const [name, setName] = createSignal("w" + i);
    const [raw, setRaw] = createSignal(i % 97);
    ${lines.join("\n    ")}
    return { raw, setRaw, setName, scaled, alert };
  }
  return {
    mount() {
      dispose = ${rootOpen}
        items = [];
        for (let i = 0; i < n; i++) items.push(Widget(i));
        ${total}
        const overCount = createMemo(() => {
          let c = 0;
          for (let i = 0; i < items.length; i++) if (items[i].alert()) c++;
          return c;
        }${opts({ oracle: D })});
        createRenderEffect(() => overCount(), v => { sink.runs++; sink.over = v; }${opts({ oracle: D })});
        createRenderEffect(() => (overCount() > 0 ? "badge warn" : "badge"), v => { sink.runs++; sink.badge = v; }${opts({ oracle: D })});
        return d;
      ${rootClose(ids)};
      flush();
    },
    sink,
    unmount() { dispose(); },
    ops: {
      tick() {
        round++;
        for (let i = round % 10; i < n; i += 10) items[i].setRaw(r => (r + 37) % 150);
        flush();
      },
      range() { setRange(r => (r + 1) % 3); flush(); },
      threshold() { setThreshold(t => (t === 100 ? 140 : 100)); flush(); },
      unit() { setUnit(u => (u === "ms" ? "s" : "ms")); flush(); },
      rename() { round++; items[round % n].setName("w" + (round % n) + "." + (round % 5)); flush(); }
    }
  };
}`;
}

/* ---------------------------------------------------------------- cells --- */
// Each cell: { label, runtime, source, fired: [substrings that prove the
// oracle is in the generated module] }. The first cell of a scenario is the
// equivalence reference; `ref` names another reference when a cell's sink
// may differ only by construction (never used today).

const Q1 = {
  name: "sel",
  question: 1,
  cells: [
    { label: "memo@prod", runtime: "prod", source: sel({ mode: "memo" }), fired: [] },
    { label: "memo+SF@prod", runtime: "prod", source: sel({ mode: "memo", sf: true }), fired: ["...statusFree"] },
    { label: "memo+SFmemo@prod", runtime: "prod", source: sel({ mode: "memo", sfMemoOnly: true }), fired: ["selected() === id, statusFree"], extra: true },
    { label: "memo(control)@oracle", runtime: "oracle", source: sel({ mode: "memo" }), fired: [] },
    { label: "memo+stack@oracle", runtime: "oracle", source: sel({ mode: "memo", stack: true }), fired: ["oracle: DET", "oracle: OWN", "...statusFree"] },
    { label: "fused@oracle", runtime: "oracle", source: sel({ mode: "fused" }), fired: ["equals: same"] },
    { label: "fused+stack@oracle", runtime: "oracle", source: sel({ mode: "fused", stack: true }), fired: ["equals: same", "oracle: DET", "...statusFree"] },
    { label: "memo+stack2@oracle", runtime: "oracle", source: sel({ mode: "memo", stack2: true }), fired: ["oracle: DET", "selected() === id, statusFree"], extra: true },
    { label: "fused+stack2@oracle", runtime: "oracle", source: sel({ mode: "fused", stack2: true }), fired: ["equals: same", "oracle: DET"], extra: true },
    { label: "proj+stack2@oracle", runtime: "oracle", source: sel({ mode: "proj", stack2: true }), fired: ["createProjection(", "oracle: DET"], extra: true },
    { label: "proj@prod", runtime: "prod", source: sel({ mode: "proj" }), fired: ["createProjection("] },
    { label: "proj+SF@prod", runtime: "prod", source: sel({ mode: "proj", sf: true }), fired: ["createProjection(", "...statusFree"] },
    { label: "proj(control)@oracle", runtime: "oracle", source: sel({ mode: "proj" }), fired: ["createProjection("] },
    { label: "proj+stack@oracle", runtime: "oracle", source: sel({ mode: "proj", stack: true }), fired: ["createProjection(", "oracle: DET", "oracle: OWN", "...statusFree"] }
  ]
};

function policyScenario(name, gen, firedB, firedC) {
  return {
    name,
    question: 2,
    cells: [
      { label: "a@prod", runtime: "prod", source: gen({ policy: "a" }), fired: [] },
      { label: "a@oracle", runtime: "oracle", source: gen({ policy: "a" }), fired: [] },
      { label: "b@oracle", runtime: "oracle", source: gen({ policy: "b" }), fired: firedB },
      { label: "c@oracle", runtime: "oracle", source: gen({ policy: "c" }), fired: firedC },
      // Q3
      { label: "b+H8b@oracle", runtime: "oracle", source: gen({ policy: "b", det: true }), fired: [...firedB, "oracle: DET"] },
      { label: "a-ids@prod", runtime: "prod", source: gen({ policy: "a", ids: true }), fired: ['id: "r"'] },
      { label: "b-ids@oracle", runtime: "oracle", source: gen({ policy: "b", ids: true }), fired: [...firedB, 'id: "r"'] },
      { label: "b+H8b-ids@oracle", runtime: "oracle", source: gen({ policy: "b", det: true, ids: true }), fired: [...firedB, "oracle: DET", 'id: "r"'] }
    ]
  };
}

export const SCENARIOS = [
  Q1,
  // rows under (b) fuses nothing (isSel reads a shared source): b ≡ a.
  policyScenario("rows", rows, [], ["equals: same"]),
  policyScenario("chain", chain, ["equals: same"], ["equals: same"]),
  policyScenario("todos", todos, ["equals: same"], ["equals: same"]),
  policyScenario("dash", dash, ["equals: same"], ["equals: same"])
];

// Attribution for dash (b): which fusion carries the tick/mount delta.
SCENARIOS.find(s => s.name === "dash").cells.push(
  { label: "b[widget-only]@oracle", runtime: "oracle", source: dash({ policy: "b", only: "widget" }), fired: ["equals: same"], extra: true },
  { label: "b[total-only]@oracle", runtime: "oracle", source: dash({ policy: "b", only: "total" }), fired: ["equals: same"], extra: true }
);
