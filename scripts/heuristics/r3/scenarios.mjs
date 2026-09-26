// Round 3 scenarios (documentation/plans/heuristic-oracles.md, "Round 3"):
// the heuristics outside the core memo/effect graph — async status, stores,
// actions. Same module shape and method as ../scenarios.mjs: `make(n)` →
// `{ mount(), unmount(), sink, ops }`, each op one write + flush.
//
// Every cell names the runtime it runs on:
//   prod    shipped prod tree (baseline, runtime-only alternatives that use
//           public API, compiled-output variants that use shipped internals)
//   oracle  prod + `__ORACLE__` arms (an assumed fact nothing verifies)
//
// Async sources are MANUAL thenables: `then` records the callbacks and the op
// resolves them synchronously, so an async round-trip runs inside one op with
// no microtask (handleAsync subscribes with a plain `.then`).
export const ORACLE_STATUSLESS = 1 << 28;

const THENABLE = `function flight() {
  const cbs = [];
  return { then(res) { cbs.push(res); }, resolve(v) { for (const cb of cbs.splice(0)) cb(v); } };
}`;

/**
 * H9 — status-walk elision. One async source `data`, n row memos over it, one
 * render effect per row, all inside one Loading boundary. `refetch` bumps the
 * source (pending walk to every row and effect), resolves it (every row
 * recomputes, every effect runs), flushes.
 *
 *   baseline      the program as written
 *   sync-source   the same update with a synchronous source: the floor with
 *                 no async machinery at all (not an equivalent program — a
 *                 bound on what any status optimization can save)
 *   H9-statusless row memos are status-transparent (oracle): the pending
 *                 notification passes through them to the effects
 *   H9-direct     compiled output with the transparent memos fused away:
 *                 each effect reads the source directly (H1 on top of H9)
 */
function asyncRows({ sync = false, rowOpts = "", fuse = false } = {}) {
  const source = sync
    ? `const data = createMemo(() => ({ v: ver() }));`
    : `const data = createMemo(() => { const v = ver(); return (current = flight()); });`;
  const row = fuse
    ? `createRenderEffect(() => data().v + i, v => { sink.runs++; sink.last = v; });`
    : `const r = createMemo(() => data().v + i${rowOpts ? `, ${rowOpts}` : ""});
          createRenderEffect(() => r(), v => { sink.runs++; sink.last = v; });`;
  return `import { createLoadingBoundary, createMemo, createRenderEffect, createRoot, createSignal, flush } from "@solidjs/signals";
${THENABLE}
export function make(n) {
  const [ver, setVer] = createSignal(0);
  const sink = { runs: 0, last: 0, view: null };
  let current = null, dispose, round = 0;
  const settle = () => { if (current) { const c = current; current = null; c.resolve({ v: round }); flush(); } };
  return {
    mount() {
      dispose = createRoot(d => {
        ${source}
        const view = createLoadingBoundary(() => {
          for (let i = 0; i < n; i++) {
          ${row}
          }
          return "ready";
        }, () => "loading");
        createRenderEffect(() => view(), v => { sink.view = v; });
        return d;
      });
      flush();
      settle();
    },
    sink,
    unmount() { dispose(); },
    ops: {
      refetch() {
        setVer(++round);
        flush();
        settle();
      }
    }
  };
}`;
}

/**
 * S1/S2 — stores. A store of n rows `{ id, label }` plus `selected`; per row
 * a text effect on `row.label` and a selection memo + effect. Ops as in the
 * signal-level rows scenario.
 *
 *   baseline     proxy reads (`row.label`), draft writes
 *   S1-handle    compiled output with the store proven non-escaping: handle
 *                reads (`readHandle1`), no proxies ever created for reads
 *   S2-scalar    compiled output with the store scalar-replaced: a static
 *                shape, never escaping, never reconciled or spread → one
 *                signal per field (the signal-level rows program)
 *   R-path       runtime-only: the same proxies read through the shipped
 *                path API (`readPath1`) — what a runtime helper can do
 *                without an escape proof
 */
function storeRows(kind) {
  const read = {
    baseline: `const row = untrack(() => state.rows[i]);
        const label = () => row.label;
        const selected = () => state.selected;`,
    "S1-handle": `const row = readHandleChild(root, ["rows", i]);
        const label = () => readHandle1(row, "label");
        const selected = () => readHandle1(root, "selected");`,
    "R-path": `const row = untrack(() => state.rows[i]);
        const label = () => readPath1(row, "label");
        const selected = () => readPath1(state, "selected");`
  }[kind];
  if (kind === "S2-scalar")
    return `import { createMemo, createRenderEffect, createRoot, createSignal, flush } from "@solidjs/signals";
export function make(n) {
  const sink = { runs: 0, text: "", sel: -1 };
  let dispose, setters, setSelected, round = 0;
  return {
    mount() {
      dispose = createRoot(d => {
        const [selected, setSel] = createSignal(-1);
        setSelected = setSel;
        setters = [];
        for (let i = 0; i < n; i++) {
          const [label, setLabel] = createSignal("row " + i);
          setters.push(setLabel);
          createRenderEffect(() => label(), v => { sink.runs++; sink.text = v; });
          const isSel = createMemo(() => selected() === i);
          createRenderEffect(() => isSel(), v => { sink.runs++; if (v) sink.sel = i; });
        }
        return d;
      });
      flush();
    },
    sink,
    unmount() { dispose(); },
    ops: {
      update10th() {
        round++;
        for (let i = 0; i < n; i += 10) setters[i]("row " + i + " #" + round);
        flush();
      },
      select() {
        setSelected((++round * 7) % n);
        flush();
      }
    }
  };
}`;
  const create =
    kind === "S1-handle"
      ? `const [root, set] = createStoreHandle({ rows: Array.from({ length: n }, (_, i) => ({ id: i, label: "row " + i })), selected: -1 });`
      : `const [state, set] = createStore({ rows: Array.from({ length: n }, (_, i) => ({ id: i, label: "row " + i })), selected: -1 });`;
  return `import { createMemo, createRenderEffect, createRoot, createStore, createStoreHandle, flush, readHandle1, readHandleChild, readPath1, untrack } from "@solidjs/signals";
export function make(n) {
  const sink = { runs: 0, text: "", sel: -1 };
  let dispose, setStore, round = 0;
  return {
    mount() {
      dispose = createRoot(d => {
        ${create}
        setStore = set;
        for (let i = 0; i < n; i++) {
          ${read}
          createRenderEffect(() => label(), v => { sink.runs++; sink.text = v; });
          const isSel = createMemo(() => selected() === i);
          createRenderEffect(() => isSel(), v => { sink.runs++; if (v) sink.sel = i; });
        }
        return d;
      });
      flush();
    },
    sink,
    unmount() { dispose(); },
    ops: {
      update10th() {
        const r = ++round;
        setStore(s => { for (let i = 0; i < n; i += 10) s.rows[i].label = "row " + i + " #" + r; });
        flush();
      },
      select() {
        const k = (++round * 7) % n;
        setStore(s => { s.selected = k; });
        flush();
      }
    }
  };
}`;
}

/**
 * A1 — synchronous actions. An event handler that performs two writes with
 * no async gap, over n readers of each signal.
 *
 *   baseline   \`action(function* () { setA(k); setB(k); })\` invoked, then flush
 *   A1-batch   compiled output for an action proven synchronous (no yield of
 *              a thenable, no await): the writes as a plain batch
 */
function syncAction(kind) {
  const call =
    kind === "baseline"
      ? `act(k);`
      : `setA(k); setB(k);`;
  return `import { action, createRenderEffect, createRoot, createSignal, flush } from "@solidjs/signals";
export function make(n) {
  const sink = { runs: 0, a: 0, b: 0 };
  let dispose, setA, setB, act, round = 0;
  return {
    mount() {
      dispose = createRoot(d => {
        const [a, sa] = createSignal(0);
        const [b, sb] = createSignal(0);
        setA = sa; setB = sb;
        act = action(function* (k) { setA(k); setB(k); });
        for (let i = 0; i < n; i++) {
          createRenderEffect(() => a(), v => { sink.runs++; sink.a = v; });
          createRenderEffect(() => b(), v => { sink.runs++; sink.b = v; });
        }
        return d;
      });
      flush();
    },
    sink,
    unmount() { dispose(); },
    ops: {
      write() {
        const k = ++round;
        ${call}
        flush();
      }
    }
  };
}`;
}

/**
 * Selection: n rows, each showing whether it is the selected one. `select`
 * moves the selection (two rows change, n comparisons in the baseline).
 *
 *   baseline      per row \`createMemo(() => selected() === id)\` + effect
 *   H1-fuse       the memo fused into its effect (oracle equals), the
 *                 compiled form measured in round 1
 *   R-projection  runtime-only answer: one selection projection; each row
 *                 reads its own key, so only the two changed rows are notified
 */
function select(kind) {
  const row = {
    baseline: `const isSel = createMemo(() => selected() === i);
          createRenderEffect(() => isSel(), v => { sink.runs++; if (v) sink.sel = i; });`,
    "H1-fuse": `createRenderEffect(() => selected() === i, v => { sink.runs++; if (v) sink.sel = i; }, { equals: (a, b) => a === b });`,
    "R-projection": `createRenderEffect(() => sel[i] === true, v => { sink.runs++; if (v) sink.sel = i; });`
  }[kind];
  return `import { createMemo, createProjection, createRenderEffect, createRoot, createSignal, flush } from "@solidjs/signals";
export function make(n) {
  const sink = { runs: 0, sel: -1 };
  let dispose, setSelected, round = 0;
  return {
    mount() {
      dispose = createRoot(d => {
        const [selected, setSel] = createSignal(-1);
        setSelected = setSel;
        let prev = -1;
        const sel = ${kind === "R-projection" ? `createProjection(draft => { const s = selected(); if (prev !== -1) delete draft[prev]; if (s !== -1) draft[s] = true; prev = s; }, {})` : "null"};
        for (let i = 0; i < n; i++) {
          ${row}
        }
        return d;
      });
      flush();
    },
    sink,
    unmount() { dispose(); },
    ops: {
      select() {
        setSelected((++round * 7) % n);
        flush();
      }
    }
  };
}`;
}

/**
 * S4 — write-set-driven read elision. Store rows render \`row.id\` and
 * \`row.label\`; the program writes only \`label\` (no reconcile, no whole-row
 * replacement), so no writer can ever reach \`id\`.
 *
 *   baseline     both fields are tracked reads with their own effect
 *   S4-static    compiled output knowing the store's write set: \`id\` is read
 *                once, untracked, and written as static text (no store node,
 *                no link, no effect)
 */
function storeStatic(kind) {
  const idPart =
    kind === "baseline"
      ? `createRenderEffect(() => row.id, v => { sink.ids += v; });`
      : `sink.ids += untrack(() => row.id);`;
  return `import { createRenderEffect, createRoot, createStore, flush, untrack } from "@solidjs/signals";
export function make(n) {
  const sink = { runs: 0, text: "", ids: 0 };
  let dispose, setStore, round = 0;
  return {
    mount() {
      dispose = createRoot(d => {
        const [state, set] = createStore({ rows: Array.from({ length: n }, (_, i) => ({ id: i, label: "row " + i })) });
        setStore = set;
        for (let i = 0; i < n; i++) {
          const row = untrack(() => state.rows[i]);
          ${idPart}
          createRenderEffect(() => row.label, v => { sink.runs++; sink.text = v; });
        }
        return d;
      });
      flush();
    },
    sink,
    unmount() { dispose(); },
    ops: {
      update10th() {
        const r = ++round;
        setStore(s => { for (let i = 0; i < n; i += 10) s.rows[i].label = "row " + i + " #" + r; });
        flush();
      }
    }
  };
}`;
}

export const SCENARIOS3 = [
  {
    name: "async-rows",
    ops: ["mount", "refetch"],
    cells: [
      { label: "baseline@prod", source: asyncRows(), runtime: "prod" },
      { label: "control@oracle", source: asyncRows(), runtime: "oracle" },
      { label: "sync-source@prod", source: asyncRows({ sync: true }), runtime: "prod", bound: true },
      {
        label: "H9-statusless@oracle",
        source: asyncRows({ rowOpts: `{ oracle: ${ORACLE_STATUSLESS} }` }),
        runtime: "oracle"
      },
      { label: "H9-direct@prod", source: asyncRows({ fuse: true }), runtime: "prod" }
    ]
  },
  {
    name: "store-rows",
    ops: ["mount", "update10th", "select"],
    cells: [
      { label: "baseline@prod", source: storeRows("baseline"), runtime: "prod" },
      { label: "R-path@prod", source: storeRows("R-path"), runtime: "prod" },
      { label: "S1-handle@prod", source: storeRows("S1-handle"), runtime: "prod" },
      { label: "S2-scalar@prod", source: storeRows("S2-scalar"), runtime: "prod" }
    ]
  },
  {
    name: "store-static",
    ops: ["mount", "update10th"],
    cells: [
      { label: "baseline@prod", source: storeStatic("baseline"), runtime: "prod" },
      { label: "S4-static@prod", source: storeStatic("S4-static"), runtime: "prod" }
    ]
  },
  {
    name: "select",
    ops: ["mount", "select"],
    cells: [
      { label: "baseline@prod", source: select("baseline"), runtime: "prod" },
      { label: "H1-fuse@oracle", source: select("H1-fuse"), runtime: "oracle" },
      { label: "R-projection@prod", source: select("R-projection"), runtime: "prod" }
    ]
  },
  {
    name: "action",
    ops: ["write"],
    cells: [
      { label: "baseline@prod", source: syncAction("baseline"), runtime: "prod" },
      { label: "A1-batch@prod", source: syncAction("A1-batch"), runtime: "prod" }
    ]
  }
];
