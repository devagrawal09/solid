#!/usr/bin/env node
// Block-graph liveness classifier: the analysis half of the compiler-first
// SSR / hydration design (documentation/plans/ssr-hydration-redesign.md).
//
// For each app it builds, from source, the graph a strict compiler / linker
// would have:
//   cells     every signal / store / optimistic / projection / memo created
//             (in a component setup, a factory function or module scope);
//             `written` if its setter is referenced (events, actions, effects),
//             `refetched` if `refresh(cell)` appears — either makes it LIVE;
//             a memo is live if any cell it reads is live;
//   flows     which cells each binding depends on: component-local bindings,
//             props (joined over every call site, to a fixed point), context
//             values (joined over every provider), callback parameters of
//             <For each> / <Show when>;
//   per component: the cells its view reads, its event handlers (JSX on*),
//             the cells those handlers write (through called actions too),
//             and load-time effects (createEffect / $effect / onSettled /
//             onMount, directly or through a factory it calls).
// and classifies each component:
//   inert         view reads nothing live, no events, no load-time effects:
//                 plain server HTML; no code, no keys, no data on the client
//   event-island  events but a view that reads nothing live: only the
//                 handlers ship, loaded on the first event (no view re-run)
//   view-island   live reads, no load-time effects: activated before the
//                 first write that reaches it (hydrate-before-write), or lazily
//   hot-island    load-time effects: must activate at load
// and derives the handler → islands map (the hydrate-before-write sets).
// It then assigns each connected island group (islands that touch a common
// cell) a runtime tier, with the facts that forced it
// (documentation/plans/island-runtime-tiers.md; see assignTiers()):
//   tier 0        no reactive runtime (own cells, unconditional holes)
//   tier 1        the kernel (memos, dynamic reads/structure, effects, sharing)
//   tier 2        the full core (async, optimistic, stores, actions, boundaries)
//
// Scope: name-based resolution within an app (no shadowing analysis), the
// syntactic forms these examples use. Unknown calls that receive a live
// value are assumed to escape it (conservative: live stays live).
//
//   node scripts/ssr-redesign/analyze.mjs [--app hn|todos|sync|todos-local] [--json out.json]
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { ROOT } from "./lib.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export const APP_SOURCES = {
  hn: [
    "scripts/ssr-redesign/apps/hn/story.tsx",
    "examples/hackernews-spa/src/components/comment.tsx",
    "examples/hackernews-spa/src/components/toggle.tsx"
  ],
  todos: ["examples/todos-blocks/src/app.tsx", "examples/todos-blocks/src/todos.ts", "examples/todos-blocks/src/filter.ts"],
  sync: ["examples/sync-blocks/src/app.tsx"],
  "todos-local": ["scripts/ssr-redesign/apps/todos-local/app.tsx"]
};

const CREATE = new Set(["createSignal", "createStore", "createOptimistic", "createOptimisticStore", "createProjection", "$signal", "$store"]);
const MEMO = new Set(["createMemo", "$memo"]);
const EFFECT = new Set(["createEffect", "createRenderEffect", "$effect", "onSettled", "onMount", "createTrackedEffect"]);

const isCap = s => /^[A-Z]/.test(s);
const nameOf = n => (n && ts.isIdentifier(n) ? n.text : null);

function calleeName(call) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
}
/** Strip `yield*`, parens, `as`, non-null. */
function unwrap(e) {
  while (e) {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
    else if (ts.isYieldExpression(e) && e.asteriskToken && e.expression) e = e.expression;
    else break;
  }
  return e;
}
function walk(node, fn) {
  const visit = n => {
    if (fn(n) === false) return;
    ts.forEachChild(n, visit);
  };
  visit(node);
}
const isFn = n => ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isFunctionDeclaration(n);

export function analyze(appName, files = APP_SOURCES[appName]) {
  const sources = files.map(f => ({ file: f, sf: ts.createSourceFile(f, readFileSync(join(ROOT, f), "utf8"), ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS) }));

  // --- 1. declarations -------------------------------------------------------
  const cells = new Map(); // id -> { id, kind, setter, written, refetched, deps:Set, loc }
  const factories = new Map(); // fn name -> { node, cells:Set, effects:bool, returns:Set }
  const components = new Map(); // name -> { name, kind, node, setup, view, props, file }
  const contexts = new Set();
  const functions = new Map(); // any named function -> node (for write closure)
  const setterOf = new Map(); // setter name -> cell id
  const accessorOf = new Map(); // accessor/store/memo binding -> cell id
  const loc = n => `${n.getSourceFile().fileName.split("/").pop()}:${n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1}`;

  const componentFromCall = (name, init, file) => {
    // $component(function* (props) { setup; return function* () { view } })
    const fn = init.arguments[0];
    if (!fn || !isFn(fn)) return;
    let view = null;
    walk(fn.body, n => {
      if (n !== fn && isFn(n)) return false;
      if (ts.isReturnStatement(n) && n.expression && isFn(unwrap(n.expression))) view = unwrap(n.expression);
    });
    components.set(name, { name, kind: "$component", node: fn, view, props: nameOf(fn.parameters[0]?.name), file });
  };

  for (const { sf, file } of sources) {
    walk(sf, n => {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const init = unwrap(n.initializer);
        const nm = nameOf(n.name);
        if (nm && isCap(nm) && ts.isCallExpression(init) && calleeName(init) === "$component") componentFromCall(nm, init, file);
        else if (nm && isCap(nm) && isFn(init) && hasJsx(init)) components.set(nm, { name: nm, kind: "plain", node: init, view: init, props: nameOf(init.parameters[0]?.name), file });
        if (nm && ts.isCallExpression(init) && calleeName(init) === "createContext") contexts.add(nm);
        if (nm && isFn(init)) functions.set(nm, init);
      }
      if (ts.isFunctionDeclaration(n) && n.name) {
        const nm = n.name.text;
        functions.set(nm, n);
        if (isCap(nm) && hasJsx(n)) components.set(nm, { name: nm, kind: "plain", node: n, view: n, props: nameOf(n.parameters[0]?.name), file });
      }
    });
  }
  function hasJsx(node) {
    let found = false;
    walk(node, n => {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) found = true;
      return !found;
    });
    return found;
  }

  // Cells: every `[a, setA] = create*(...)` / `m = createMemo(...)` anywhere.
  for (const { sf } of sources) {
    walk(sf, n => {
      if (!ts.isVariableDeclaration(n) || !n.initializer) return;
      const init = unwrap(n.initializer);
      if (!ts.isCallExpression(init)) return;
      const callee = calleeName(init);
      if (CREATE.has(callee) && ts.isArrayBindingPattern(n.name)) {
        const [get, set] = n.name.elements.map(e => (ts.isBindingElement(e) ? nameOf(e.name) : null));
        const id = `${get || "?"}@${loc(n)}`;
        const arg = init.arguments[0];
        cells.set(id, { id, kind: callee, getter: get, setter: set, written: false, refetched: false, async: !!arg && isFn(arg) && !!(arg.modifiers || []).some(m => m.kind === ts.SyntaxKind.AsyncKeyword), deps: new Set(), loc: loc(n) });
        if (get) accessorOf.set(get, id);
        if (set) setterOf.set(set, id);
      } else if (MEMO.has(callee) && nameOf(n.name)) {
        const nm = nameOf(n.name);
        const id = `${nm}@${loc(n)}`;
        cells.set(id, { id, kind: callee, getter: nm, memo: init.arguments[0], deps: new Set(), loc: loc(n) });
        accessorOf.set(nm, id);
      }
    });
  }

  // --- 2. writes: a setter referenced anywhere but its own declaration ----------
  for (const { sf } of sources) {
    walk(sf, n => {
      if (ts.isIdentifier(n) && setterOf.has(n.text) && !(ts.isBindingElement(n.parent) && n.parent.name === n)) cells.get(setterOf.get(n.text)).written = true;
      if (ts.isCallExpression(n) && calleeName(n) === "refresh" && n.arguments[0]) {
        const a = nameOf(unwrap(n.arguments[0]));
        if (a && accessorOf.has(a)) cells.get(accessorOf.get(a)).refetched = true;
      }
    });
  }

  // --- 3. flows: identifier -> Set<cell id> (to a fixed point) -----------------
  const env = new Map(); // binding name -> Set<cellId>
  const propFlows = new Map(); // `Comp.prop` -> Set<cellId>
  const ctxFlows = new Map(); // context name -> Set<cellId>
  const get = (m, k) => m.get(k) || new Set();
  const addAll = (m, k, s) => {
    const cur = m.get(k) || new Set();
    const before = cur.size;
    for (const x of s) cur.add(x);
    m.set(k, cur);
    return cur.size !== before;
  };
  for (const [nm, id] of accessorOf) env.set(nm, new Set([id]));

  /** Cells an expression depends on (reads or carries). */
  function flowOf(expr, scope) {
    const out = new Set();
    if (!expr) return out;
    // Names bound inside the expression (parameters, locals of nested
    // functions) shadow outer bindings of the same name.
    const local = new Set();
    walk(expr, n => {
      if ((ts.isParameter(n) || ts.isVariableDeclaration(n)) && n !== expr) for (const nm of bindingNames(n.name)) local.add(nm);
    });
    walk(expr, n => {
      if (ts.isIdentifier(n) && local.has(n.text)) return false;
      if (ts.isJsxAttribute(n) && /^on[A-Z:]/.test(n.name.getText())) return false; // handlers are not reads
      if (ts.isPropertyAccessExpression(n) && scope.props && rootName(n) === scope.props) {
        const first = firstProp(n);
        for (const c of get(propFlows, `${scope.component}.${first}`)) out.add(c);
        return false;
      }
      if (ts.isIdentifier(n) && !isNamePosition(n)) {
        if (scope.props && n.text === scope.props) for (const [k, s] of propFlows) if (k.startsWith(scope.component + ".")) for (const c of s) out.add(c);
        for (const c of get(env, n.text)) out.add(c);
        const f = factories.get(n.text);
        if (f && ts.isCallExpression(n.parent) && n.parent.expression === n) for (const c of f.returns) out.add(c);
      }
    });
    return out;
  }
  /** Identifiers that name a property, key, attribute or tag — not a binding. */
  const isNamePosition = n => {
    const p = n.parent;
    return (
      (ts.isPropertyAccessExpression(p) && p.name === n) ||
      (ts.isPropertyAssignment(p) && p.name === n) ||
      (ts.isJsxAttribute(p) && p.name === n) ||
      ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxClosingElement(p)) && p.tagName === n) ||
      (ts.isBindingElement(p) && p.propertyName === n) ||
      (ts.isMethodDeclaration(p) && p.name === n)
    );
  };
  const rootName = n => {
    while (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) n = n.expression;
    return ts.isIdentifier(n) ? n.text : null;
  };
  const firstProp = n => {
    let last = null;
    while (ts.isPropertyAccessExpression(n)) {
      last = n.name.text;
      n = n.expression;
    }
    return last;
  };

  // Factories: non-component functions that create cells or effects.
  for (const [nm, node] of functions) {
    if (components.has(nm)) continue;
    const f = { node, cells: new Set(), effects: [], returns: new Set() };
    walk(node, n => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(unwrap(n.initializer))) {
        const g = ts.isArrayBindingPattern(n.name) ? n.name.elements[0] && nameOf(n.name.elements[0].name) : nameOf(n.name);
        if (g && accessorOf.has(g)) f.cells.add(accessorOf.get(g));
      }
      if (ts.isCallExpression(n) && EFFECT.has(calleeName(n))) f.effects.push(`${calleeName(n)} @${loc(n)}`);
    });
    if (f.cells.size || f.effects.length) factories.set(nm, f);
  }
  const live = c => {
    const cell = cells.get(c);
    return !!cell && cell.live;
  };

  let changed = true;
  for (let round = 0; changed && round < 20; round++) {
    changed = false;
    // factory returns
    for (const [, f] of factories)
      walk(f.node, n => {
        if (ts.isReturnStatement(n) && n.expression) for (const c of flowOf(n.expression, {})) if (!f.returns.has(c)) (f.returns.add(c), (changed = true));
      });
    // memo deps
    for (const cell of cells.values())
      if (cell.memo) {
        const owner = componentOf(cell.memo);
        for (const c of flowOf(cell.memo, owner ? { props: owner.props, component: owner.name } : {})) if (c !== cell.id && !cell.deps.has(c)) (cell.deps.add(c), (changed = true));
      }
    // local bindings (destructuring, context reads, derived consts)
    for (const { sf } of sources)
      walk(sf, n => {
        if (!ts.isVariableDeclaration(n) || !n.initializer) return;
        const owner = componentOf(n);
        const scope = owner ? { props: owner.props, component: owner.name } : {};
        const init = unwrap(n.initializer);
        let flow = flowOf(init, scope);
        // `yield* Ctx` / `useContext(Ctx)` / a helper that reads a context
        const ctx = contextRead(init);
        if (ctx) flow = new Set([...flow, ...get(ctxFlows, ctx)]);
        const names = bindingNames(n.name);
        for (const nm of names) if (!accessorOf.has(nm) && addAll(env, nm, flow)) changed = true;
      });
    // JSX: props at call sites, context providers, For/Show callback params
    for (const { sf } of sources)
      walk(sf, n => {
        if (!(ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n))) return;
        const open = ts.isJsxElement(n) ? n.openingElement : n;
        const tag = open.tagName.getText();
        const owner = componentOf(n);
        const scope = owner ? { props: owner.props, component: owner.name } : {};
        const attrs = open.attributes.properties.filter(ts.isJsxAttribute);
        const attrFlow = a => (a.initializer && ts.isJsxExpression(a.initializer) ? flowOf(a.initializer.expression, scope) : new Set());
        if (contexts.has(tag)) {
          const v = attrs.find(a => a.name.getText() === "value");
          if (v && addAll(ctxFlows, tag, attrFlow(v))) changed = true;
        }
        if (components.has(tag)) for (const a of attrs) if (addAll(propFlows, `${tag}.${a.name.getText()}`, attrFlow(a))) changed = true;
        if ((tag === "For" || tag === "Show") && ts.isJsxElement(n)) {
          const src = attrs.find(a => ["each", "when"].includes(a.name.getText()));
          const flow = src ? attrFlow(src) : new Set();
          for (const child of n.children)
            if (ts.isJsxExpression(child) && child.expression && isFn(child.expression)) for (const p of child.expression.parameters) for (const nm of bindingNames(p.name)) if (addAll(env, nm, flow)) changed = true;
        }
      });
    // liveness
    for (const cell of cells.values()) {
      const was = cell.live;
      cell.live = !!(cell.written || cell.refetched || [...cell.deps].some(live));
      if (cell.live !== was) changed = true;
    }
  }

  function bindingNames(name) {
    if (ts.isIdentifier(name)) return [name.text];
    const out = [];
    walk(name, n => {
      if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) out.push(n.name.text);
    });
    return out;
  }
  function contextRead(expr) {
    let found = null;
    walk(expr, n => {
      if (ts.isIdentifier(n) && contexts.has(n.text)) found = n.text;
      if (ts.isCallExpression(n)) {
        const f = functions.get(calleeName(n));
        if (f && !components.has(calleeName(n))) walk(f, m => (ts.isIdentifier(m) && contexts.has(m.text) ? (found = m.text) : undefined));
      }
    });
    return found;
  }
  function componentOf(node) {
    for (let n = node; n; n = n.parent) for (const c of components.values()) if (c.node === n) return c;
    return null;
  }

  // --- 4. per-component facts ---------------------------------------------------
  const writesOf = (node, seen = new Set()) => {
    const out = new Set();
    walk(node, n => {
      if (ts.isIdentifier(n) && !isNamePosition(n)) {
        if (setterOf.has(n.text)) out.add(setterOf.get(n.text));
        // calls into actions / helpers: close over their writes
        const fnNode = functions.get(n.text);
        if (fnNode && !seen.has(n.text) && !components.has(n.text)) {
          seen.add(n.text);
          for (const c of writesOf(fnNode, seen)) out.add(c);
        }
        // action members destructured from a context / factory value
        for (const c of get(env, n.text)) if (actionWrites.has(n.text)) for (const w of actionWrites.get(n.text)) out.add(w);
      }
    });
    return out;
  };
  // actions returned by factories: `const actions = { addTodo: action(function* …) }`
  // (also plain function members: `{ addTodo: title => setTodos(…) }`)
  const actionWrites = new Map();
  const actionNames = new Set();
  for (const { sf } of sources)
    walk(sf, n => {
      const isAction = ts.isPropertyAssignment(n) && ts.isCallExpression(unwrap(n.initializer)) && calleeName(unwrap(n.initializer)) === "action";
      if (isAction) actionNames.add(n.name.getText());
      if (isAction || (ts.isPropertyAssignment(n) && isFn(unwrap(n.initializer)))) {
        const s = new Set();
        walk(n.initializer, m => (ts.isIdentifier(m) && setterOf.has(m.text) ? s.add(setterOf.get(m.text)) : undefined));
        walk(n.initializer, m => {
          if (ts.isCallExpression(m) && calleeName(m) === "refresh" && m.arguments[0]) {
            const a = nameOf(unwrap(m.arguments[0]));
            if (a && accessorOf.has(a)) s.add(accessorOf.get(a));
          }
        });
        actionWrites.set(n.name.getText(), s);
      }
    });

  const report = [];
  for (const c of components.values()) {
    const scope = { props: c.props, component: c.name };
    const viewReads = new Set();
    const events = [];
    const writes = new Set();
    const effects = [];
    const children = new Set();
    let slot = false;
    const viewNode = c.view || c.node;
    walk(viewNode, n => {
      if (ts.isJsxAttribute(n) && /^on[A-Z:]/.test(n.name.getText())) {
        events.push(n.name.getText());
        const h = n.initializer && ts.isJsxExpression(n.initializer) ? n.initializer.expression : null;
        if (h) {
          const hn = nameOf(unwrap(h));
          const target = hn && findLocal(c.node, hn);
          for (const w of writesOf(target || h)) writes.add(w);
        }
        return false;
      }
      if (ts.isJsxExpression(n) && n.expression) {
        const e = n.expression;
        if (ts.isPropertyAccessExpression(e) && rootName(e) === c.props && firstProp(e) === "children") slot = true;
        for (const x of flowOf(e, scope)) viewReads.add(x);
      }
      if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && components.has(n.tagName.getText())) children.add(n.tagName.getText());
    });
    // load-time effects in setup (or in the view's owner body for plain components)
    walk(c.node, n => {
      if (n !== c.node && c.view && n === c.view) return false;
      if (ts.isCallExpression(n)) {
        const nm = calleeName(n);
        if (EFFECT.has(nm)) effects.push(`${nm} @${loc(n)}`);
        const f = factories.get(nm);
        if (f && f.effects.length) effects.push(...f.effects.map(e => `${e} (via ${nm}())`));
      }
    });
    // `autofocus` and similar are native: not effects.
    const liveReads = [...viewReads].filter(live);
    const verdict = effects.length ? "hot-island" : liveReads.length ? "view-island" : events.length ? "event-island" : "inert";
    report.push({
      component: c.name,
      kind: c.kind,
      file: c.file,
      verdict,
      liveViewReads: liveReads.map(shortCell),
      staticViewReads: [...viewReads].filter(x => !live(x)).map(shortCell),
      events,
      writes: [...writes].map(shortCell),
      loadTimeEffects: effects,
      renders: [...children],
      slot,
      _c: c,
      _reads: liveReads,
      _writes: [...writes]
    });
  }
  function findLocal(scopeNode, name) {
    let found = null;
    walk(scopeNode, n => {
      if (ts.isVariableDeclaration(n) && nameOf(n.name) === name && n.initializer) found = n.initializer;
    });
    return found;
  }
  function shortCell(id) {
    const c = cells.get(id);
    return c ? `${c.getter}(${c.kind}${c.async ? ", async" : ""})` : id;
  }

  // --- 5. handler -> islands (hydrate-before-write) -----------------------------
  const readersOf = cellId => report.filter(r => r.liveViewReads.includes(shortCell(cellId)) || [...cells.values()].some(m => m.memo && m.deps.has(cellId) && r.liveViewReads.includes(shortCell(m.id)))).map(r => r.component);
  const handlerMap = [];
  for (const r of report)
    if (r.events.length) {
      const affected = new Set([r.component]);
      for (const w of r.writes) {
        const id = [...cells.values()].find(c => shortCell(c.id) === w)?.id;
        if (id) for (const x of readersOf(id)) affected.add(x);
      }
      handlerMap.push({ island: r.component, events: r.events, writes: r.writes, hydrateBeforeWrite: [...affected] });
    }

  const cellsOut = [...cells.values()].map(c => ({ cell: shortCell(c.id), at: c.loc, live: !!c.live, why: c.written ? "setter used" : c.refetched ? "refresh()" : c.live ? "reads a live cell" : c.async ? "server-authoritative (async, never written or refetched)" : "never written" }));
  const tiers = assignTiers();
  for (const r of report) {
    delete r._c;
    delete r._reads;
    delete r._writes;
  }
  return { app: appName, files, cells: cellsOut, components: report, handlerMap, groups: tiers };

  // --- 6. runtime tiers (documentation/plans/island-runtime-tiers.md) ----------------
  // Each island's client code gets the smallest runtime its graph allows:
  //   tier 0  no reactive runtime: every live cell it touches is written only
  //           by its own handlers, every view hole reads cells unconditionally,
  //           no memo, effect, cleanup, dynamic structure, async or sharing;
  //   tier 1  the kernel (signal / memo / effect / cleanup / root): memos,
  //           conditional (dynamic) reads, Show / For over live inputs,
  //           load-time effects, cleanups, cells shared with other islands;
  //   tier 2  the full core: async or optimistic cells, stores, projections,
  //           actions / attempt / refresh / transitions, Loading / Errored.
  // Islands that share a cell form a connected group (they share one runtime
  // instance); the linker gives the group the highest tier of its members.
  function assignTiers() {
    const STRUCTURE = new Set(["Show", "For", "Index", "Repeat", "Switch", "Match", "Dynamic"]);
    const ASYNC_KIND = new Set(["createOptimistic", "createOptimisticStore", "createProjection"]);
    const STORE_KIND = new Set(["createStore", "$store"]);
    const TIER2_CALLS = new Set(["attempt", "action", "refresh", "startTransition", "createAsync"]);
    const TIER2_TAGS = new Set(["Loading", "Errored", "Suspense", "ErrorBoundary"]);
    // base cells behind a cell (a memo stands for the cells it reads)
    const baseOf = (id, seen = new Set()) => {
      if (seen.has(id)) return seen;
      seen.add(id);
      for (const d of cells.get(id)?.deps || []) if (live(d)) baseOf(d, seen);
      return seen;
    };
    const isRead = n => ts.isIdentifier(n) && !isNamePosition(n);
    const facts = new Map();
    for (const r of report) {
      if (r.verdict === "inert") continue;
      const c = r._c;
      const scope = { props: c.props, component: c.name };
      const touched = new Set();
      for (const id of [...r._reads, ...r._writes]) for (const b of baseOf(id)) touched.add(b);
      const t2 = [],
        t1 = [];
      for (const id of touched) {
        const cell = cells.get(id);
        if (!cell) continue;
        if (cell.async || ASYNC_KIND.has(cell.kind)) t2.push(`async/optimistic cell ${shortCell(id)}`);
        else if (STORE_KIND.has(cell.kind)) t2.push(`store ${shortCell(id)} (the kernel has no stores)`);
        else if (cell.memo) t1.push(`memo ${cell.getter}`);
      }
      walk(c.node, n => {
        if (ts.isCallExpression(n) && TIER2_CALLS.has(calleeName(n))) t2.push(`${calleeName(n)}() @${loc(n)}`);
        if (ts.isCallExpression(n) && calleeName(n) === "onCleanup") t1.push(`onCleanup @${loc(n)}`);
        if (ts.isIdentifier(n) && actionNames.has(n.text) && !isNamePosition(n)) t2.push(`calls action ${n.text}`);
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && TIER2_TAGS.has(n.tagName.getText())) t2.push(`<${n.tagName.getText()}>`);
      });
      for (const e of r.loadTimeEffects) t1.push(`load-time effect ${e}`);
      // Holes: dynamic structure and conditional reads in the view.
      let holes = 0;
      walk(c.view || c.node, n => {
        if (ts.isJsxAttribute(n) && /^on[A-Z:]/.test(n.name.getText())) return false;
        if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && STRUCTURE.has(n.tagName.getText())) {
          for (const a of n.attributes.properties)
            if (ts.isJsxAttribute(a) && a.initializer && ts.isJsxExpression(a.initializer) && [...flowOf(a.initializer.expression, scope)].some(live))
              t1.push(`<${n.tagName.getText()} ${a.name.getText()}> over live input (dynamic structure)`);
        }
        if (ts.isJsxExpression(n) && n.expression && !(ts.isJsxAttribute(n.parent) && STRUCTURE.has(n.parent.parent.parent.tagName?.getText?.()))) {
          const liveHere = [...flowOf(n.expression, scope)].filter(live);
          if (!liveHere.length) return;
          holes++;
          walk(n.expression, m => {
            if (m !== n.expression && ts.isJsxExpression(m)) return false; // its own hole
            if (!isRead(m)) return;
            const flows = [...flowOf(m, scope)].filter(live);
            if (!flows.length) return;
            const why = conditionalContext(m, n.expression);
            if (why) t1.push(`conditional read of ${m.text} (${why}) @${loc(m)}`);
          });
        }
      });
      facts.set(r.component, { r, touched, t2: [...new Set(t2)], t1: [...new Set(t1)], holes });
    }
    // connected groups: components that touch a common base cell
    const parent = new Map([...facts.keys()].map(k => [k, k]));
    const find = k => (parent.get(k) === k ? k : find(parent.get(k)));
    const byCell = new Map();
    for (const [name, f] of facts)
      for (const id of f.touched) {
        if (byCell.has(id)) parent.set(find(name), find(byCell.get(id)));
        else byCell.set(id, name);
      }
    const groups = new Map();
    for (const name of facts.keys()) {
      const root = find(name);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(name);
    }
    const out = [];
    for (const members of groups.values()) {
      const fs = members.map(m => facts.get(m));
      const shared = [...new Set(fs.flatMap(f => [...f.touched]))].filter(id => fs.filter(f => f.touched.has(id)).length > 1);
      const own = f => (f.t2.length ? 2 : f.t1.length ? 1 : 0);
      const reasons = { 2: fs.flatMap(f => f.t2.map(x => `${f.r.component}: ${x}`)), 1: fs.flatMap(f => f.t1.map(x => `${f.r.component}: ${x}`)) };
      if (members.length > 1) reasons[1].push(`cells shared across islands: ${shared.map(shortCell).join(", ")}`);
      const tier = reasons[2].length ? 2 : reasons[1].length ? 1 : 0;
      const t0why = `cells [${[...new Set(fs.flatMap(f => [...f.touched]))].map(shortCell).join(", ")}] written only by the island's own handlers; ${fs.reduce((n, f) => n + f.holes, 0)} live hole(s), all reading unconditionally; no memo, effect, cleanup, dynamic structure, async or sharing`;
      for (const f of fs) f.r.tier = { own: own(f), group: tier, members };
      // Only memos keep this group off tier 0: a compiler that folds a memo
      // with unconditional reads into a derived slot (recomputed before the
      // holes, with its equality cut-off) could emit it at tier 0.
      const note = tier === 1 && reasons[1].every(x => / memo /.test(` ${x.split(": ")[1]} `)) ? "memo folding candidate: only memos keep this group off tier 0" : undefined;
      out.push({ members, tier, why: tier === 0 ? [t0why] : reasons[tier], alsoTier1: tier === 2 ? reasons[1] : [], ...(note ? { note } : {}) });
    }
    return out;
  }
  /** Why a read under `root` runs only on some evaluations, or null. */
  function conditionalContext(node, root) {
    for (let n = node; n && n !== root; n = n.parent) {
      const p = n.parent;
      if (!p) break;
      if (ts.isConditionalExpression(p) && n !== p.condition) return "ternary branch";
      if (ts.isBinaryExpression(p) && n === p.right && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) return "short-circuit operand";
      if (isFn(p) && p !== root) return "inside a callback";
      if (ts.isIfStatement(p) && n !== p.expression) return "if branch";
    }
    return null;
  }
}

// --- CLI -----------------------------------------------------------------------
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const only = args.includes("--app") ? args[args.indexOf("--app") + 1] : null;
  const out = {};
  for (const app of Object.keys(APP_SOURCES)) {
    if (only && app !== only) continue;
    const r = (out[app] = analyze(app));
    console.log(`\n=== ${app}`);
    console.log("cells:");
    for (const c of r.cells) console.log(`  ${c.live ? "LIVE  " : "static"} ${c.cell.padEnd(40)} ${c.why}`);
    console.log("components:");
    for (const c of r.components)
      console.log(
        `  ${c.component.padEnd(12)} ${c.verdict.padEnd(13)} live reads [${c.liveViewReads.join(", ")}] events [${c.events.join(", ")}] writes [${c.writes.join(", ")}]` +
          (c.loadTimeEffects.length ? ` load-time [${c.loadTimeEffects.join("; ")}]` : "") +
          (c.slot ? " slot" : "")
      );
    console.log("handler -> hydrate-before-write:");
    for (const h of r.handlerMap) console.log(`  ${h.island} (${h.events.join(", ")}) -> ${h.hydrateBeforeWrite.join(", ")}`);
    console.log("runtime tiers (per connected island group):");
    for (const g of r.groups) {
      console.log(`  tier ${g.tier}  [${g.members.join(", ")}]`);
      for (const w of g.why) console.log(`           - ${w}`);
      if (g.alsoTier1.length) console.log(`           (tier-1 needs too: ${g.alsoTier1.length})`);
      if (g.note) console.log(`           note: ${g.note}`);
    }
  }
  if (args.includes("--json")) writeFileSync(args[args.indexOf("--json") + 1], JSON.stringify(out, null, 2) + "\n");
}
