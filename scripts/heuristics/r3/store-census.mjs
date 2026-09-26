#!/usr/bin/env node
// Store census (round 3, S2/S4): for every `const [s, setS] = createStore(init)`
// (also `createMutable(init)` as a read-side store without a setter), classify
// its uses in the declaring file. Syntactic and file-local like ../census.mjs,
// so it over-approximates in one way (no aliasing through helpers) and
// under-approximates in another (a cross-file reader counts as an escape).
//
//   store-level
//     literalInit    init is an object/array literal (static top-level shape)
//     dynamicKey     some read `s[expr]` / `s.a[expr]` with a non-literal key
//     escapes        `s` or a sub-path passed as a call argument (other than
//                    a setter call), returned, assigned, spread, or used as a
//                    JSX attribute value — the store leaves compiled reads
//     listOnly       every escape is `<For each={s.path}>` / `<Index each=…>`
//     setterEscapes  the setter is referenced other than as a direct call
//     reconcile      `reconcile(` / `produce(` inside a setter call, or a
//                    whole-store replacement `setS(value)` with a non-function
//   verdicts
//     S2 full        literalInit ∧ ¬dynamicKey ∧ ¬escapes ∧ ¬setterEscapes ∧ ¬reconcile
//     S2 row-level   as S2 full, but list escapes allowed (rows become objects
//                    of signals inside an array signal)
//   S4 (per top-level key)  read through a static path and never written:
//     no setter call names it (path form `setS("k", …)` or an assignment
//     `d.k = …` in a function-form setter), no reconcile/replacement, no
//     setter escape.
//
//   node scripts/heuristics/r3/store-census.mjs <dir>... [--out file.json]
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const out = outIdx >= 0 ? argv.splice(outIdx, 2)[1] : null;

const SKIP = /node_modules|dist|\.git|\.output|\.vinxi|build|coverage|__tests__|\.test\.|\.spec\./;
function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (SKIP.test(p)) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* files(p);
    else if (/\.(tsx|jsx|ts|js)$/.test(name) && !/\.d\.ts$/.test(name)) yield p;
  }
}

const calleeName = call =>
  ts.isIdentifier(call.expression) ? call.expression.text : undefined;

function analyze(sf) {
  const stores = [];
  const visit = node => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ["createStore", "createMutable"].includes(calleeName(node.initializer))
    ) {
      const init = node.initializer.arguments[0];
      let get, set;
      if (ts.isArrayBindingPattern(node.name)) {
        const [g, s] = node.name.elements;
        if (g && ts.isBindingElement(g) && ts.isIdentifier(g.name)) get = g.name.text;
        if (s && ts.isBindingElement(s) && ts.isIdentifier(s.name)) set = s.name.text;
      } else if (ts.isIdentifier(node.name)) get = node.name.text;
      if (get)
        stores.push({
          get,
          set,
          kind: calleeName(node.initializer),
          literalInit: !!init && (ts.isObjectLiteralExpression(init) || ts.isArrayLiteralExpression(init)),
          // Top-level keys initialized to a primitive literal: passing such a
          // path passes a value, not the store.
          primKeys: new Set(
            init && ts.isObjectLiteralExpression(init)
              ? init.properties
                  .filter(
                    p =>
                      ts.isPropertyAssignment(p) &&
                      (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
                      (ts.isStringLiteral(p.initializer) ||
                        ts.isNumericLiteral(p.initializer) ||
                        ts.isNoSubstitutionTemplateLiteral(p.initializer) ||
                        p.initializer.kind === ts.SyntaxKind.TrueKeyword ||
                        p.initializer.kind === ts.SyntaxKind.FalseKeyword)
                  )
                  .map(p => p.name.text)
              : []
          ),
          decl: node
        });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const st of stores) {
    Object.assign(st, {
      dynamicKey: false,
      escapes: 0,
      listEscapes: 0,
      propEscapes: 0,
      setterEscapes: st.kind === "createMutable",
      reconcile: false,
      reads: 0,
      readKeys: new Set(),
      writtenKeys: new Set(),
      wholeWrite: st.kind === "createMutable"
    });
    const walk = node => {
      if (ts.isIdentifier(node) && node.text === st.get && node.parent !== st.decl && !isDeclName(node)) useOfStore(node, st);
      if (st.set && ts.isIdentifier(node) && node.text === st.set && !isDeclName(node)) useOfSetter(node, st);
      ts.forEachChild(node, walk);
    };
    walk(sf);
    delete st.decl;
  }
  return stores;
}

function isDeclName(id) {
  const p = id.parent;
  return (p && ts.isBindingElement(p) && p.name === id) || (p && ts.isVariableDeclaration(p) && p.name === id);
}

function useOfStore(id, st) {
  // Climb the static member chain s.a.b / s["a"].
  let node = id;
  let first = null;
  while (true) {
    const p = node.parent;
    if (ts.isPropertyAccessExpression(p) && p.expression === node) {
      if (first === null) first = p.name.text;
      node = p;
    } else if (ts.isElementAccessExpression(p) && p.expression === node) {
      const a = p.argumentExpression;
      if (ts.isStringLiteral(a) || ts.isNumericLiteral(a)) {
        if (first === null) first = a.text;
      } else st.dynamicKey = true;
      node = p;
    } else break;
  }
  if (first !== null) st.readKeys.add(first);
  st.reads++;
  const p = node.parent;
  // A read ending in a call (s.items.map(...), s.list.length) is a method /
  // property use on a value, still a read. Escapes:
  const jsxAttr = p && ts.isJsxExpression(p) && p.parent && ts.isJsxAttribute(p.parent);
  if (jsxAttr) {
    const attr = p.parent.name.getText();
    const tag = p.parent.parent?.parent?.tagName?.getText?.();
    if (attr === "each" && (tag === "For" || tag === "Index")) st.listEscapes++;
    else if (node !== id && first !== null && st.primKeys.has(first)) {
      // A primitive leaf passed as a prop: a read.
    } else if (/^[A-Z]/.test(tag ?? "")) {
      st.escapes++;
      st.propEscapes++;
    }
    else if (/^[a-z]/.test(tag ?? "") && node !== id) {
      // DOM attribute binding of a leaf value: a read.
    } else st.escapes++;
    return;
  }
  if (p && ts.isCallExpression(p) && p.arguments.includes(node)) {
    const callee = p.expression.getText();
    if (callee === st.set || /^(String|Number|Boolean|console\.\w+)$/.test(callee)) return;
    if (node !== id && first !== null && st.primKeys.has(first)) return; // a primitive leaf value
    st.escapes++;
    return;
  }
  if (p && (ts.isReturnStatement(p) || ts.isSpreadElement(p) || ts.isSpreadAssignment(p) || ts.isJsxSpreadAttribute(p))) {
    st.escapes++;
    return;
  }
  if (p && ts.isVariableDeclaration(p) && p.initializer === node && node === id) {
    st.escapes++;
    return;
  }
  if (p && ts.isBinaryExpression(p) && p.right === node && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    st.escapes++;
    return;
  }
  if (p && ts.isBinaryExpression(p) && p.left === node && p.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    // createMutable-style direct write.
    if (first !== null) st.writtenKeys.add(first);
    else st.wholeWrite = true;
    return;
  }
  if (p && (ts.isShorthandPropertyAssignment(p) || (ts.isPropertyAssignment(p) && p.initializer === node))) {
    st.escapes++;
    return;
  }
  if (p && ts.isArrayLiteralExpression(p)) st.escapes++;
}

function useOfSetter(id, st) {
  const p = id.parent;
  if (!(p && ts.isCallExpression(p) && p.expression === id)) {
    st.setterEscapes = true;
    return;
  }
  const args = p.arguments;
  const text = p.getText();
  if (/\breconcile\(|\bproduce\(/.test(text)) st.reconcile = true;
  if (!args.length) return;
  const a0 = args[0];
  if (ts.isStringLiteral(a0)) {
    st.writtenKeys.add(a0.text);
    return;
  }
  if (ts.isArrowFunction(a0) || ts.isFunctionExpression(a0)) {
    // Function form: record top-level assignment targets on the draft
    // parameter; returning a value replaces the store.
    const draft = a0.parameters[0]?.name;
    const dn = draft && ts.isIdentifier(draft) ? draft.text : null;
    let replaces = !ts.isBlock(a0.body);
    const w = n => {
      if (dn && ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
        let t = n.left;
        let key = null;
        while (ts.isPropertyAccessExpression(t) || ts.isElementAccessExpression(t)) {
          if (ts.isIdentifier(t.expression) && t.expression.text === dn)
            key = ts.isPropertyAccessExpression(t) ? t.name.text : t.argumentExpression.text ?? "*";
          t = t.expression;
        }
        if (key) st.writtenKeys.add(key);
      }
      if (dn && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)) {
        // d.items.push(...) and friends mutate `items`.
        let t = n.expression.expression;
        while (ts.isPropertyAccessExpression(t) && !(ts.isIdentifier(t.expression) && t.expression.text === dn)) t = t.expression;
        if (ts.isPropertyAccessExpression(t) && ts.isIdentifier(t.expression) && t.expression.text === dn) st.writtenKeys.add(t.name.text);
      }
      if (ts.isReturnStatement(n) && n.expression) replaces = true;
      ts.forEachChild(n, w);
    };
    w(a0.body);
    if (replaces) st.wholeWrite = true;
    return;
  }
  // setS(value) — whole or merge replacement.
  st.wholeWrite = true;
  if (ts.isObjectLiteralExpression(a0))
    for (const prop of a0.properties) if (prop.name) st.writtenKeys.add(prop.name.getText());
}

const roots = argv;
const perFile = [];
const all = [];
for (const root of roots)
  for (const file of files(root)) {
    const src = readFileSync(file, "utf8");
    if (!/createStore|createMutable/.test(src)) continue;
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, /x$/.test(file) || /\.js$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const stores = analyze(sf);
    if (!stores.length) continue;
    perFile.push({ file: relative(process.cwd(), file), stores: stores.length });
    all.push(...stores.map(s => ({ ...s, file: relative(process.cwd(), file) })));
  }

const verdict = s => {
  const base = s.literalInit && !s.dynamicKey && !s.setterEscapes && !s.reconcile;
  return {
    s2full: base && s.escapes === 0 && s.listEscapes === 0,
    s2row: base && s.escapes === 0
  };
};
let s4read = 0,
  s4static = 0;
const rows = all.map(s => {
  const v = verdict(s);
  const staticKeys =
    s.reconcile || s.setterEscapes || s.escapes || s.dynamicKey
      ? []
      : [...s.readKeys].filter(
          k => !(k in Array.prototype) && !s.writtenKeys.has(k) && !(s.wholeWrite && !s.writtenKeys.size)
        );
  s4read += s.readKeys.size;
  s4static += staticKeys.length;
  return {
    file: s.file,
    store: s.get,
    kind: s.kind,
    literalInit: s.literalInit,
    reads: s.reads,
    dynamicKey: s.dynamicKey,
    escapes: s.escapes,
    propEscapes: s.propEscapes,
    listEscapes: s.listEscapes,
    setterEscapes: s.setterEscapes,
    reconcile: s.reconcile,
    readKeys: [...s.readKeys],
    writtenKeys: [...s.writtenKeys],
    staticKeys,
    ...v
  };
});
const summary = {
  stores: rows.length,
  literalInit: rows.filter(r => r.literalInit).length,
  dynamicKey: rows.filter(r => r.dynamicKey).length,
  escaping: rows.filter(r => r.escapes).length,
  listOnly: rows.filter(r => !r.escapes && r.listEscapes).length,
  setterEscapes: rows.filter(r => r.setterEscapes).length,
  reconcile: rows.filter(r => r.reconcile).length,
  s2full: rows.filter(r => r.s2full).length,
  s2row: rows.filter(r => r.s2row).length,
  // Would pass the row-level verdict if every escape were a component prop
  // (recoverable by inlining the child, C2).
  s2rowWithInlining: rows.filter(
    r => r.literalInit && !r.dynamicKey && !r.setterEscapes && !r.reconcile && r.escapes === r.propEscapes
  ).length,
  s4: { readKeys: s4read, neverWritten: s4static }
};
console.log(JSON.stringify(summary, null, 2));
if (out) writeFileSync(out, JSON.stringify({ roots, summary, stores: rows }, null, 2) + "\n");
