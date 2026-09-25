// solid-tsc --capabilities — the typed half of the Track A stage-2 capability
// summary.
//
// For every reactive host call (`createMemo`, `createSignal`, `createEffect`,
// `createRenderEffect`, `createStore`, `createProjection`, resolved through
// the checker to an import from solid-js / @solidjs/signals) this records
// TypeScript's verdict on the compute's RESULT type, and for every attribute
// of a JSX element whose tag is an import from solid-js / @solidjs/web, the
// verdict on the attribute VALUE type:
//
//   "sync"    — no constituent can be a thenable or an async iterable
//   "async"   — some constituent has a callable `then` or `[Symbol.asyncIterator]`
//   "unknown" — `any`, `unknown`, or an unconstrained type parameter
//
// Keys are UTF-16 offsets of the argument / attribute expression in the
// AUTHORED source (projected files are mapped back through the projection),
// matching the compiler's `summarizeCapabilities` positions, so the
// capability linker joins the two on (file, start).
//
// Trust: the verdicts are as sound as the program's types — a cast (`as any`
// is refused, but `as Todo[]` is believed) can lie. The async-free runtime's
// development build verifies every result at runtime
// ([ASYNC_IN_SYNC_GRAPH]).
import path from "node:path";
import ts from "typescript";
import { mapToSource } from "./index.js";

const RUNTIME_SOURCES = new Set(["solid-js", "@solidjs/signals"]);
const COMPONENT_SOURCES = new Set(["solid-js", "@solidjs/web"]);
const HOSTS = new Set([
  "createMemo",
  "createSignal",
  "createEffect",
  "createRenderEffect",
  "createStore",
  "createProjection"
]);

/** The import (module, imported name) an identifier resolves to, if any. */
function importOf(checker, identifier) {
  const symbol = checker.getSymbolAtLocation(identifier);
  const declaration = symbol?.declarations?.[0];
  if (!declaration || !ts.isImportSpecifier(declaration)) return null;
  const importDeclaration = declaration.parent.parent.parent;
  if (!ts.isImportDeclaration(importDeclaration)) return null;
  const specifier = importDeclaration.moduleSpecifier;
  if (!ts.isStringLiteral(specifier)) return null;
  return {
    source: specifier.text,
    name: (declaration.propertyName ?? declaration.name).text
  };
}

const SYNC_FLAGS =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.EnumLike |
  ts.TypeFlags.Void |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Null |
  ts.TypeFlags.Never;

/** Can a value of `type` be a thenable or an async iterable? */
export function asyncVerdict(checker, type, depth = 0) {
  if (depth > 8) return "unknown";
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "unknown";
  if (type.isUnion()) {
    let verdict = "sync";
    for (const member of type.types) {
      const v = asyncVerdict(checker, member, depth + 1);
      if (v === "async") return "async";
      if (v === "unknown") verdict = "unknown";
    }
    return verdict;
  }
  if (type.flags & SYNC_FLAGS) return "sync";
  if (type.flags & ts.TypeFlags.TypeParameter) {
    const constraint = checker.getBaseConstraintOfType(type);
    return constraint && constraint !== type
      ? asyncVerdict(checker, constraint, depth + 1)
      : "unknown";
  }
  if (type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection | ts.TypeFlags.NonPrimitive)) {
    const then = checker.getPropertyOfType(type, "then");
    if (then) {
      const thenType = checker.getTypeOfSymbol(then);
      if (thenType.flags & ts.TypeFlags.Any || thenType.getCallSignatures().length) return "async";
    }
    if (type.getProperties().some(p => String(p.escapedName).startsWith("__@asyncIterator")))
      return "async";
    // `object` itself (NonPrimitive) says nothing about its members.
    if (type.flags & ts.TypeFlags.NonPrimitive) return "unknown";
    return "sync";
  }
  return "unknown";
}

/** Verdict on the result of calling a compute argument. */
function computeVerdict(checker, argument) {
  const type = checker.getTypeAtLocation(argument);
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return "unknown";
  const signatures = type.getCallSignatures();
  // Not callable: `createSignal(value)` / `createStore(value)` — a value, not
  // a computation (a non-callable compute is a type error elsewhere).
  if (!signatures.length)
    return type.isUnion() && type.types.some(t => t.getCallSignatures().length)
      ? "unknown"
      : "sync";
  let verdict = "sync";
  for (const signature of signatures) {
    const v = asyncVerdict(checker, checker.getReturnTypeOfSignature(signature));
    if (v === "async") return "async";
    if (v === "unknown") verdict = "unknown";
  }
  return verdict;
}

/**
 * Build the typed capability summary for a checked program.
 * @param {ts.Program} program
 * @param {Map<string, {source: string, edits: any[]}>} projections
 */
export function summarizeProgram(program, projections) {
  const checker = program.getTypeChecker();
  const files = {};
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile || program.isSourceFileFromExternalLibrary(sourceFile))
      continue;
    if (sourceFile.fileName.includes("/node_modules/")) continue;
    const projection = projections.get(sourceFile.fileName);
    const authored = offset => (projection ? mapToSource(projection.edits, offset) : offset);
    const computes = {};
    const props = {};
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.arguments.length) {
        const imported = importOf(checker, node.expression);
        if (imported && RUNTIME_SOURCES.has(imported.source) && HOSTS.has(imported.name)) {
          const argument = node.arguments[0];
          computes[authored(argument.getStart(sourceFile))] = computeVerdict(checker, argument);
        }
      }
      if (
        (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
        ts.isIdentifier(node.tagName)
      ) {
        const imported = importOf(checker, node.tagName);
        if (imported && COMPONENT_SOURCES.has(imported.source)) {
          for (const attribute of node.attributes.properties) {
            if (!ts.isJsxAttribute(attribute) || !attribute.initializer) continue;
            if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression)
              continue;
            const expression = attribute.initializer.expression;
            props[authored(expression.getStart(sourceFile))] = asyncVerdict(
              checker,
              checker.getTypeAtLocation(expression)
            );
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    if (Object.keys(computes).length || Object.keys(props).length)
      files[path.resolve(sourceFile.fileName)] = { computes, props };
  }
  return { schema: 1, typescript: ts.version, files };
}
