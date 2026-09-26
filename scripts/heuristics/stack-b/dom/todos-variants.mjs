// Q4: the examples/todos port (todos-app.jsx), compiled by the real native
// compiler, plus every heuristic whose fact holds in that code. All edits are
// small named rewrites of the compiler output (or, for C1, of the source the
// compiler sees) and fail loudly if their pattern is missing.
//
// Facts audited in the app (see README, Q4):
//   H1  memo fusion        — the app has no createMemo; derivations are plain
//                            functions. Nothing to fuse.            NOT APPLIED
//   H8b detached nodes     — every per-row binding reads the shared todos
//                            store (a row's store node outlives the row: it
//                            survives filtering). Sources do not die with the
//                            node.                                  NOT APPLIED
//   H5  statusFree         — the real store is an async optimistic projection
//                            (reads can be pending).                NOT APPLIED
//   H8a ownerless          — client render has no ids; H8a alone is a loss
//                            there (round 2).                       NOT APPLIED
//   C1  inline TodoItem    — known component, one call site, same file, no
//                            escaping props.                        APPLIED
//   L1  single-element rows— TodoItem renders exactly one <li>.     APPLIED
//   H7  typed text         — `todo.title: string`, `remaining(): number`,
//                            `"item" | "items"`.                    APPLIED (types)
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT } from "../common.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
const compile = (src, name) => transform(src, { filename: `${name}.jsx`, generate: "dom" }).code;

function edit(code, from, to, what) {
  if (!code.includes(from)) throw new Error(`${what}: pattern not found`);
  const out = code.replace(from, to);
  return out;
}

const src = readFileSync(join(here, "todos-app.jsx"), "utf8");

// C1: TodoItem's body inlined at its only call site (props.todo → todo).
const itemStart = src.indexOf("function TodoItem(props) {");
const itemEnd = src.indexOf("\nfunction MainSection");
const itemBody = src
  .slice(itemStart + "function TodoItem(props) {".length, src.lastIndexOf("}", itemEnd))
  .replaceAll("props.todo", "todo");
const inlineSrc = edit(src, "{todo => <TodoItem todo={todo} />}", `{todo => {${itemBody}}}`, "C1 inline");

// L1: For over single-element rows → mapArray + DOM reconciler directly.
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
  const m = /_\$insert\((_el\$\d+), _\$createComponent\(For, \{/.exec(code);
  if (!m) throw new Error("L1: For insert not found");
  const start = m.index;
  const childrenAt = code.indexOf("children: ", start);
  const end = code.indexOf("\n\t\t\t}));", childrenAt);
  if (childrenAt < 0 || end < 0) throw new Error("L1: For children not found");
  const children = code.slice(childrenAt + "children: ".length, end).trimEnd();
  code = code.slice(0, start) + `__forNodes(${m[1]}, () => filtered(), ${children});` + code.slice(end + "\n\t\t\t}));".length);
  return edit(code, 'import { render } from "@solidjs/web";', 'import { render } from "@solidjs/web";' + FOR_NODES, "L1 import");
}

// H7: typed text children become text-node `.data` writes.
function sub(code, re, fn, what) {
  if (!re.test(code)) throw new Error(`${what}: pattern not found`);
  return code.replace(re, fn);
}
function typedText(code) {
  // <label>{todo.title}</label>: string.
  code = edit(code, "<label></label><button class=destroy>", "<label> </label><button class=destroy>", "H7 label template");
  code = sub(
    code,
    /_\$insert\((_el\$\d+), \(\) => \{\n\t*return ((?:props\.)?todo\.title);\n\t*\}\);/,
    (_, el, read) => `const _t$ = ${el}.firstChild;\n_$effect(() => ${read}, v => { _t$.data = v; });`,
    "H7 title insert"
  );
  // <strong>{remaining()}</strong>: number.
  code = edit(code, "<strong></strong>", "<strong> </strong>", "H7 strong template");
  code = sub(
    code,
    /_\$insert\((_el\$\d+), remaining\);/,
    (_, el) => `const _t2$ = ${el}.firstChild;\n_$effect(remaining, v => { _t2$.data = v; });`,
    "H7 remaining insert"
  );
  // {remaining() === 1 ? "item" : "items"}: "item" | "items", before the <!> marker.
  code = sub(
    code,
    /_\$insert\((_el\$\d+), \(\) => \{\n\t*return remaining\(\) === 1 \? "item" : "items";\n\t*\}, (_el\$\d+)\);/,
    (_, parent, marker) =>
      `const _t3$ = document.createTextNode("");\n${parent}.insertBefore(_t3$, ${marker});\n` +
      `_$effect(() => remaining() === 1 ? "item" : "items", v => { _t3$.data = v; });`,
    "H7 item(s) insert"
  );
  return code;
}

// Not a heuristic (an author change no compiler may make: it changes when
// the derivations run): memoize the O(n) store scans the app re-runs on
// every change. Measured only to size what the licensed heuristics leave.
let memoSrc = edit(src, "  createStore,\n", "  createStore,\n  createMemo,\n", "memo import");
memoSrc = edit(memoSrc, "const allCompleted = () => todos.length > 0 && todos.every(x => x.completed);",
  "const allCompleted = createMemo(() => todos.length > 0 && todos.every(x => x.completed));", "memo allCompleted");
memoSrc = edit(memoSrc, "const remaining = () => todos.filter(x => !x.completed).length;",
  "const remaining = createMemo(() => todos.filter(x => !x.completed).length);", "memo remaining");
memoSrc = edit(memoSrc, "const completed = () => todos.length - remaining();",
  "const completed = createMemo(() => todos.length - remaining());", "memo completed");

const baseline = compile(src, "todos-app");
const c1 = compile(inlineSrc, "todos-app-inline");

export const TODOS_VARIANTS = {
  baseline: { runtime: "prod", source: baseline },
  "C1-inline": { runtime: "prod", source: c1 },
  "L1-nodes": { runtime: "prod", source: nodesList(baseline) },
  "H7-text": { runtime: "prod", source: typedText(baseline) },
  "C1+L1": { runtime: "prod", source: nodesList(c1) },
  "C1+L1+H7": { runtime: "prod", source: typedText(nodesList(c1)) },
  "author-memo": { runtime: "prod", source: compile(memoSrc, "todos-app-memo"), extra: true }
};
// Proof each edit is in the module (checked by bench.mjs --check).
export const TODOS_FIRED = {
  baseline: [],
  "C1-inline": ["children: (todo) => {"],
  "L1-nodes": ["__forNodes(_el$"],
  "H7-text": ["_t$.data = v", "_t2$.data = v", "_t3$.data = v"],
  "C1+L1": ["__forNodes(_el$", "(todo) => {"],
  "C1+L1+H7": ["__forNodes(_el$", "(todo) => {", "_t$.data = v", "_t2$.data = v", "_t3$.data = v"],
  "author-memo": ["remaining = createMemo("]
};
