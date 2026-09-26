#!/usr/bin/env node
// Syntactic coverage census for the heuristic oracles: how often does each
// assumed fact hold in real Solid code? Parses .tsx/.jsx/.ts/.js with the
// TypeScript parser (no type checking) and classifies, per file:
//
//   memos   `const m = createMemo(…)`; references of `m` in the enclosing
//           function. H1-eligible = exactly one reference, a call `m()`,
//           inside a JSX expression or the first argument of a render
//           effect / effect / memo (one tracked reader), or `yield* m` in a
//           generator block consumed by one. Two or more call
//           references = shared; any non-call reference (passed, returned,
//           stored) = escaped.
//   signals `const [s, setS] = createSignal(…)`. H4-eligible = no setter
//           binding, or a setter with no reference. Setter passed as a value
//           counts as written (unknown).
//   JSX     elements with ≥2 dynamic parts (attributes or children holding a
//           call or member access, excluding on*/ref/use:/prop: handlers):
//           H6 candidates.
//
// A syntactic census over-approximates eligibility (it cannot see aliasing
// through helpers or cross-file readers) — a compiler proof would accept a
// subset. Name collisions across nested scopes are resolved to the nearest
// enclosing function.
//
//   node scripts/heuristics/census.mjs <dir>... [--out file.json]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const out = outIdx >= 0 ? argv.splice(outIdx, 2)[1] : null;
const roots = argv;

const SKIP = /node_modules|dist|\.git|\.output|\.vinxi|build|coverage|__tests__|\.test\.|\.spec\./;
function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p);
    else if (/\.(tsx|jsx)$/.test(name) || (/\.(ts|js)$/.test(name) && !/\.d\.ts$/.test(name)))
      yield p;
  }
}

const TRACKED_HOSTS = new Set([
  "createMemo",
  "createEffect",
  "createRenderEffect",
  "createComputed",
  "createSelector"
]);
const isFn = n =>
  ts.isFunctionDeclaration(n) ||
  ts.isFunctionExpression(n) ||
  ts.isArrowFunction(n) ||
  ts.isMethodDeclaration(n);
const calleeName = call =>
  ts.isIdentifier(call.expression)
    ? call.expression.text
    : ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name.text
      : null;

/** Classify a reference: where does the value flow? */
function readerOf(id) {
  const parent = id.parent;
  // A read is `m()`, or `yield* m` inside a generator `$` block.
  const isRead =
    (ts.isCallExpression(parent) && parent.expression === id) ||
    (ts.isYieldExpression(parent) && parent.asteriskToken && parent.expression === id);
  if (!isRead) return "escaped";
  // Find the closest tracked context. A `$(fn)` marker is transparent: its
  // consumer is the host.
  for (let n = parent.parent; n; n = n.parent) {
    if (isFn(n) && ts.isCallExpression(n.parent) && calleeName(n.parent) === "$") {
      const marker = n.parent;
      if (ts.isReturnStatement(marker.parent)) return "tracked"; // returned JSX block
      n = marker;
      continue;
    }
    if (ts.isJsxExpression(n)) {
      const attr = n.parent;
      if (ts.isJsxAttribute(attr) && /^on|^ref$|^use:|^prop:/.test(attr.name.getText()))
        return "untracked";
      return "tracked";
    }
    if (isFn(n)) {
      const host = n.parent;
      if (ts.isCallExpression(host) && host.arguments[0] === n) {
        const name = calleeName(host);
        if (TRACKED_HOSTS.has(name)) return "tracked";
      }
      if (ts.isJsxExpression(host)) {
        const attr = host.parent;
        if (ts.isJsxAttribute(attr) && /^on/.test(attr.name.getText())) return "untracked";
        return "tracked"; // render function / accessor child
      }
      return "unknown"; // a helper or callback: cannot tell when it runs
    }
  }
  return "untracked"; // component body: a one-shot setup read
}

function referencesIn(scope, name, decl) {
  const refs = [];
  const visit = n => {
    if (ts.isIdentifier(n) && n.text === name && n !== decl) {
      const p = n.parent;
      const isProp =
        (ts.isPropertyAccessExpression(p) && p.name === n) ||
        (ts.isPropertyAssignment(p) && p.name === n) ||
        (ts.isJsxAttribute(p) && p.name === n);
      if (!isProp) refs.push(n);
    }
    ts.forEachChild(n, visit);
  };
  visit(scope);
  return refs;
}

const isDynamic = expr => {
  let dyn = false;
  const visit = n => {
    if (dyn || isFn(n)) return;
    if (ts.isCallExpression(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n))
      dyn = true;
    else ts.forEachChild(n, visit);
  };
  visit(expr);
  return dyn;
};

const totals = {
  files: 0,
  memos: 0,
  memo: { single: 0, shared: 0, escaped: 0, untrackedOnly: 0, unknown: 0, unused: 0 },
  signals: 0,
  signal: { constant: 0, written: 0 },
  jsx: { elements: 0, dynamicParts: 0, multiElements: 0, partsInMulti: 0, attrParts: 0, childParts: 0 }
};
const perFile = [];

for (const root of roots)
  for (const file of files(root)) {
    const text = readFileSync(file, "utf8");
    if (!/solid-js|@solidjs|createSignal|createMemo/.test(text)) continue;
    const kind = file.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : file.endsWith(".ts")
        ? ts.ScriptKind.TS
        : ts.ScriptKind.JSX; // .js/.jsx: Solid apps often keep JSX in .js
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    totals.files++;
    const local = { file: relative(process.cwd(), file), memos: {}, signals: {}, multi: 0 };
    const scopeOf = n => {
      for (let p = n.parent; p; p = p.parent) if (isFn(p) || ts.isSourceFile(p)) return p;
      return sf;
    };
    const visit = n => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isCallExpression(n.initializer)) {
        const name = calleeName(n.initializer);
        if (name === "createMemo" && ts.isIdentifier(n.name)) {
          totals.memos++;
          const kinds = referencesIn(scopeOf(n), n.name.text, n.name).map(readerOf);
          let cls;
          if (kinds.length === 0) cls = "unused";
          else if (kinds.includes("escaped")) cls = "escaped";
          else if (kinds.includes("unknown")) cls = "unknown";
          else if (kinds.length === 1 && kinds[0] === "tracked") cls = "single";
          else if (!kinds.includes("tracked")) cls = "untrackedOnly";
          else cls = "shared";
          totals.memo[cls]++;
          if (process.env.CENSUS_SHOW === cls)
            console.log(`${cls}: ${relative(process.cwd(), file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1} ${n.name.text} [${kinds.join(",")}]`);
          local.memos[cls] = (local.memos[cls] ?? 0) + 1;
        }
        if (name === "createSignal" && ts.isArrayBindingPattern(n.name)) {
          totals.signals++;
          const setter = n.name.elements[1];
          const constant =
            !setter ||
            ts.isOmittedExpression(setter) ||
            (ts.isBindingElement(setter) &&
              ts.isIdentifier(setter.name) &&
              referencesIn(scopeOf(n), setter.name.text, setter.name).length === 0);
          totals.signal[constant ? "constant" : "written"]++;
          local.signals[constant ? "constant" : "written"] =
            (local.signals[constant ? "constant" : "written"] ?? 0) + 1;
        }
      }
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const opening = ts.isJsxElement(n) ? n.openingElement : n;
        // Components are not DOM bindings: their props are getters, not effects.
        if (/^[a-z]/.test(opening.tagName.getText())) {
          totals.jsx.elements++;
          let attrs = 0,
            kids = 0;
          for (const a of opening.attributes.properties)
            if (
              ts.isJsxAttribute(a) &&
              a.initializer &&
              ts.isJsxExpression(a.initializer) &&
              a.initializer.expression &&
              !/^on|^ref$|^use:|^prop:/.test(a.name.getText()) &&
              isDynamic(a.initializer.expression)
            )
              attrs++;
          if (ts.isJsxElement(n))
            for (const c of n.children)
              if (ts.isJsxExpression(c) && c.expression && !ts.isJsxElement(c.expression) && isDynamic(c.expression))
                kids++;
          const parts = attrs + kids;
          totals.jsx.dynamicParts += parts;
          totals.jsx.attrParts += attrs;
          totals.jsx.childParts += kids;
          if (parts >= 2) {
            totals.jsx.multiElements++;
            totals.jsx.partsInMulti += parts;
            local.multi++;
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    if (Object.keys(local.memos).length || Object.keys(local.signals).length || local.multi)
      perFile.push(local);
  }

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(0) + "%" : "-");
console.log(`files with Solid code: ${totals.files}`);
console.log(
  `memos: ${totals.memos}  H1 single tracked reader ${totals.memo.single} (${pct(totals.memo.single, totals.memos)})` +
    `  shared ${totals.memo.shared}  escaped ${totals.memo.escaped}  unknown ${totals.memo.unknown}` +
    `  untracked-only ${totals.memo.untrackedOnly}  unused ${totals.memo.unused}`
);
console.log(
  `signals: ${totals.signals}  H4 constant ${totals.signal.constant} (${pct(totals.signal.constant, totals.signals)})`
);
console.log(
  `DOM elements: ${totals.jsx.elements}  dynamic parts ${totals.jsx.dynamicParts} (attrs ${totals.jsx.attrParts}, children ${totals.jsx.childParts})` +
    `  H6 elements with ≥2 parts ${totals.jsx.multiElements}, holding ${totals.jsx.partsInMulti} parts (${pct(totals.jsx.partsInMulti, totals.jsx.dynamicParts)} of parts)`
);
if (out) writeFileSync(out, JSON.stringify({ roots, totals, perFile }, null, 2) + "\n");
