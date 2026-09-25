// Typed module summaries — the TypeScript half of the strict multi-module
// pipeline (Track C).
//
// For every authored module of a `solid-tsc` program this joins the
// compiler's behavioral summary (`summarizeModule`, schema
// `solid-behavior-summary`) with facts only the checker knows:
//
// - resolved symbol identity for every import and export, followed through
//   re-exports and `export *` to the declaring file and position (the
//   linker cross-checks its own re-export resolution against these);
// - each `$` block's instantiated `Block<Value, Reads, Tasks, Failures,
//   Writes, Input>` arguments, its brand, and a consistency check against
//   the behavioral operations (a disagreement is recorded, and the linker
//   treats the block as unknown);
// - the instantiated type of every capture, with validated brands (block,
//   accessor, setter, store, action, DOM node, function, serializable);
// - every direct path read's root type, path tuple and selected value type;
// - every component's props with their types and brands, and the
//   instantiated (contextual) prop type at each JSX event/prop site;
// - the number of type errors in the module (a module with errors is not
//   trusted by strict analysis).
//
// Positions are authored UTF-16 offsets: the checker sees the projected text
// (see `index.js`), so every lookup maps authored → generated through the
// projection's insertion edits, and every reported position maps back.
//
// Output is deterministic: modules sorted by root-relative path, fixed key
// order, no timestamps, and a content hash (`sha256`) of the authored text
// so consumers can reject stale summaries.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

export const MODULE_SCHEMA = "solid-module-summary";
export const INDEX_SCHEMA = "solid-summary-index";
export const SUMMARY_VERSION = 1;

const TYPE_FORMAT = ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.WriteArrayAsGenericType;

/** Root-relative `import("…")` paths, so type strings do not depend on the checkout location. */
let typeRoot = process.cwd();
function normalizeTypeText(text) {
  return text.replace(/import\("([^"]+)"\)/g, (_, file) =>
    path.isAbsolute(file)
      ? `import("${/[\\/]node_modules[\\/]/.test(file) ? externalName(file) : relative(typeRoot, file)}")`
      : `import("${file}")`
  );
}

export function sourceHash(text) {
  return "sha256:" + crypto.createHash("sha256").update(text).digest("hex");
}

/** Authored offset → generated offset through insertion-only edits. */
export function mapToGenerated(edits, position) {
  let delta = 0;
  for (const edit of edits) {
    if (edit.sourceStart > position) break;
    if (edit.sourceStart === edit.sourceEnd) {
      // An insertion at or before the position shifts it.
      delta += edit.generatedEnd - edit.generatedStart;
    } else if (position < edit.sourceEnd) {
      return edit.generatedStart;
    } else {
      delta += edit.generatedEnd - edit.generatedStart - (edit.sourceEnd - edit.sourceStart);
    }
  }
  return position + delta;
}

/** Deepest node starting exactly at `position` that satisfies `accept`. */
function findNodeAt(sourceFile, position, accept) {
  let found;
  const visit = node => {
    if (position < node.pos || position >= node.end) return;
    if (node.getStart(sourceFile) === position && accept(node)) found = node;
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

/**
 * Build the typed summaries of every authored module in `program`.
 * `projections` is the map `createProjectedHost` filled; `compiler` provides
 * `summarizeModule`. Returns `{ index, modules }` where `modules` maps the
 * root-relative module path to its summary object.
 */
export function buildSummaries({ program, projections, compiler, rootDir, diagnostics = [] }) {
  const checker = program.getTypeChecker();
  typeRoot = rootDir;
  const brands = createBrandInspector(program, checker);
  const errorsByFile = new Map();
  for (const diagnostic of diagnostics) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error || !diagnostic.file) continue;
    const name = diagnostic.file.fileName;
    errorsByFile.set(name, (errorsByFile.get(name) ?? 0) + 1);
  }
  const modules = new Map();
  const files = program
    .getSourceFiles()
    .filter(
      file =>
        !file.isDeclarationFile &&
        !program.isSourceFileFromExternalLibrary(file) &&
        !/[\\/]node_modules[\\/]/.test(file.fileName)
    )
    .sort((a, b) => (a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0));
  for (const sourceFile of files) {
    const projection = projections.get(sourceFile.fileName);
    const authored = projection ? projection.source : sourceFile.text;
    const edits = projection ? projection.edits : [];
    const module = relative(rootDir, sourceFile.fileName);
    let behavior;
    try {
      behavior = compiler.summarizeModule(authored, {
        filename: path.basename(sourceFile.fileName)
      });
    } catch (error) {
      behavior = null;
      modules.set(module, {
        schema: MODULE_SCHEMA,
        version: SUMMARY_VERSION,
        module,
        sourceHash: sourceHash(authored),
        behavior: null,
        types: null,
        error: String(error.message ?? error)
      });
      continue;
    }
    const context = {
      program,
      checker,
      brands,
      sourceFile,
      edits,
      rootDir,
      projections,
      toGenerated: position => mapToGenerated(edits, position)
    };
    modules.set(module, {
      schema: MODULE_SCHEMA,
      version: SUMMARY_VERSION,
      module,
      sourceHash: sourceHash(authored),
      behavior,
      types: typedFacts(context, behavior, errorsByFile.get(sourceFile.fileName) ?? 0)
    });
  }
  const index = {
    schema: INDEX_SCHEMA,
    version: SUMMARY_VERSION,
    typescript: ts.version,
    modules: [...modules.values()].map(summary => ({
      module: summary.module,
      file: `${summary.module}.summary.json`,
      sourceHash: summary.sourceHash
    }))
  };
  return { index, modules };
}

/** Write `index.json` and one `<module>.summary.json` per module under `outDir`. */
export function writeSummaries({ index, modules }, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const summary of modules.values()) {
    const file = path.join(outDir, `${summary.module}.summary.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(summary, null, 2) + "\n");
  }
  fs.writeFileSync(path.join(outDir, "index.json"), JSON.stringify(index, null, 2) + "\n");
}

// ---------------------------------------------------------------------------

function typedFacts(context, behavior, typeErrors) {
  return {
    typeErrors,
    imports: importFacts(context, behavior),
    exports: exportFacts(context),
    blocks: behavior.blocks.map(block => blockFacts(context, block)),
    components: behavior.components.map(component => componentFacts(context, component)),
    jsxSites: jsxSiteFacts(context, behavior)
  };
}

/** A stable identity for a declaration: file, name, authored position. */
function declarationIdentity(context, symbol) {
  if (!symbol) return null;
  const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (!declaration) return { file: null, name: symbol.getName(), position: null, kind: null };
  const sourceFile = declaration.getSourceFile();
  const nameNode = ts.getNameOfDeclaration(declaration) ?? declaration;
  let position = nameNode.getStart(sourceFile);
  const projection = context.projections.get(sourceFile.fileName);
  if (projection) position = generatedToAuthored(projection.edits, position);
  return {
    file: /[\\/]node_modules[\\/]/.test(sourceFile.fileName)
      ? externalName(sourceFile.fileName)
      : relative(context.rootDir, sourceFile.fileName),
    external:
      sourceFile.isDeclarationFile || context.program.isSourceFileFromExternalLibrary(sourceFile),
    name: symbol.getName(),
    position,
    kind: ts.SyntaxKind[declaration.kind]
  };
}

function externalName(fileName) {
  const parts = fileName.split(/[\\/]node_modules[\\/]/);
  return "node_modules/" + parts[parts.length - 1].split(path.sep).join("/");
}

function generatedToAuthored(edits, position) {
  let delta = 0;
  for (const edit of edits) {
    if (position < edit.generatedStart) break;
    if (position < edit.generatedEnd) return edit.sourceStart;
    delta += edit.generatedEnd - edit.generatedStart - (edit.sourceEnd - edit.sourceStart);
  }
  return position - delta;
}

function resolveAlias(checker, symbol) {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) {
    try {
      return checker.getAliasedSymbol(symbol);
    } catch {
      return undefined;
    }
  }
  return symbol;
}

function importFacts(context, behavior) {
  const { checker, sourceFile } = context;
  const out = [];
  for (const declaration of behavior.imports) {
    const node = findNodeAt(
      sourceFile,
      context.toGenerated(declaration.span.start),
      ts.isImportDeclaration
    );
    const moduleSymbol = node && checker.getSymbolAtLocation(node.moduleSpecifier);
    const resolvedFile = moduleSymbol?.declarations?.[0]?.getSourceFile();
    const specifiers = declaration.specifiers.map(specifier => {
      const local = findNodeAt(
        sourceFile,
        context.toGenerated(specifier.span.start),
        n => ts.isImportSpecifier(n) || ts.isImportClause(n) || ts.isNamespaceImport(n)
      );
      const nameNode = local && (local.name ?? local);
      const symbol = nameNode && checker.getSymbolAtLocation(nameNode);
      const target = resolveAlias(checker, symbol);
      const resolved = target && target !== symbol ? declarationIdentity(context, target) : null;
      const type = target && checker.getTypeOfSymbolAtLocation(target, nameNode);
      return {
        local: specifier.local,
        imported: specifier.imported,
        resolved,
        // Runtime/library declarations are identified, not re-described.
        type: type && resolved && !resolved.external ? typeString(checker, type) : null,
        brands: type ? context.brands.of(type) : []
      };
    });
    out.push({
      source: declaration.source,
      resolvedFile: resolvedFile
        ? /[\\/]node_modules[\\/]/.test(resolvedFile.fileName)
          ? externalName(resolvedFile.fileName)
          : relative(context.rootDir, resolvedFile.fileName)
        : null,
      external: resolvedFile
        ? resolvedFile.isDeclarationFile ||
          context.program.isSourceFileFromExternalLibrary(resolvedFile)
        : null,
      specifiers
    });
  }
  return out;
}

function exportFacts(context) {
  const { checker, sourceFile } = context;
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];
  return checker
    .getExportsOfModule(moduleSymbol)
    .map(symbol => {
      const target = resolveAlias(checker, symbol);
      const isValue = !!(target && target.flags & ts.SymbolFlags.Value);
      return {
        name: symbol.getName(),
        value: isValue,
        resolved: declarationIdentity(context, target),
        reexport: target !== symbol
      };
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function typeString(checker, type) {
  return normalizeTypeText(checker.typeToString(type, undefined, TYPE_FORMAT));
}

function isNever(type) {
  return !!(type.flags & ts.TypeFlags.Never);
}

function blockFacts(context, block) {
  const { checker, sourceFile } = context;
  const call = findNodeAt(sourceFile, context.toGenerated(block.span.start), ts.isCallExpression);
  if (!call) return { id: block.id, resolved: false };
  const type = checker.getTypeAtLocation(call);
  const brands = context.brands.of(type);
  const args = typeArgumentsOfBlock(checker, type);
  const facts = {
    id: block.id,
    resolved: true,
    type: typeString(checker, type),
    brands,
    block: brands.includes("block"),
    value: args ? typeString(checker, args[0]) : null,
    reads: args ? typeString(checker, args[1]) : null,
    tasks: args ? typeString(checker, args[2]) : null,
    failures: args ? typeString(checker, args[3]) : null,
    writes: args ? typeString(checker, args[4]) : null,
    input: args ? typeString(checker, args[5]) : null,
    inputIsEvent: args ? context.brands.isEvent(args[5]) : null,
    hasTasks: args ? !isNever(args[2]) : null,
    hasFailures: args ? !isNever(args[3]) : null,
    hasWrites: args ? !isNever(args[4]) : null
  };
  facts.mismatches = args ? blockMismatches(block, facts) : ["unresolvedBlockType"];
  facts.consistent = facts.mismatches.length === 0;
  facts.captures = (block.body?.captures ?? []).map(capture => captureFacts(context, capture));
  facts.paths = (block.body?.ops.paths ?? []).map(read => pathFacts(context, read));
  return facts;
}

/** `Block<V, R, T, F, W, I>` type arguments, when the type is a Block reference. */
function typeArgumentsOfBlock(checker, type) {
  if (!(type.flags & ts.TypeFlags.Object)) return null;
  const target = type.target ?? type;
  if (target.symbol?.getName() !== "Block") return null;
  const args = checker.getTypeArguments(type);
  return args.length === 6 ? args : null;
}

/**
 * Behavior ⇒ type obligations. The compiler sees direct operations; the
 * checker sees them plus everything inherited through delegation, so only
 * the direct → typed direction is an obligation.
 */
export function blockMismatches(block, facts) {
  const ops = block.body?.ops;
  if (!ops) return [];
  const mismatches = [];
  if (ops.writes.length && !facts.hasWrites) mismatches.push("writesNotTyped");
  if (ops.waits.length && !facts.hasTasks) mismatches.push("tasksNotTyped");
  if ((ops.raises.length || ops.attempts.length) && !facts.hasFailures) {
    // `attempt(fn)` without declared error classes types `unknown` failures;
    // `never` here means the checker lost the operation.
    mismatches.push("failuresNotTyped");
  }
  if (!facts.block) mismatches.push("missingBlockBrand");
  return mismatches;
}

function captureFacts(context, capture) {
  const { checker, sourceFile } = context;
  if (capture.scope === "global" || !capture.declaration) {
    return { name: capture.name, type: null, brands: ["global"] };
  }
  const node = findNodeAt(
    sourceFile,
    context.toGenerated(capture.declaration.start),
    ts.isIdentifier
  );
  const symbol = node && checker.getSymbolAtLocation(node);
  if (!symbol) return { name: capture.name, type: null, brands: [] };
  const target = resolveAlias(checker, symbol) ?? symbol;
  const type = checker.getTypeOfSymbolAtLocation(target, node);
  const brands = context.brands.of(type);
  // The behavioral summary proves the props parameter; types cannot.
  if (capture.props) brands.push("props");
  return {
    name: capture.name,
    type: typeString(checker, type),
    brands,
    serializable: context.brands.serializable(type)
  };
}

function pathFacts(context, read) {
  const { checker, sourceFile } = context;
  const node = findNodeAt(sourceFile, context.toGenerated(read.span.start), ts.isYieldExpression);
  if (!node || !node.expression) return { root: read.root, keys: read.keys, resolved: false };
  const operand = node.expression;
  const opType = checker.getTypeAtLocation(operand);
  const args =
    opType.aliasTypeArguments ??
    (opType.flags & ts.TypeFlags.Object ? checker.getTypeArguments(opType) : []);
  return {
    root: read.root,
    keys: read.keys,
    resolved: true,
    kind: opType.symbol?.getName() ?? null,
    rootType: args[0] ? typeString(checker, args[0]) : null,
    pathType: args[1] ? typeString(checker, args[1]) : null,
    valueType: typeString(checker, checker.getTypeAtLocation(node))
  };
}

function componentFacts(context, component) {
  const { checker, sourceFile } = context;
  // Top-level declarations by name (the behavioral span starts at
  // `function`, TypeScript's node at its `export` modifier).
  let parameter;
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === component.name) {
      parameter = statement.parameters[0];
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          declaration.name.text === component.name &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          parameter = init.parameters[0];
        }
      }
    }
  }
  if (!parameter) return { name: component.name, props: [] };
  const type = checker.getTypeAtLocation(parameter);
  return {
    name: component.name,
    propsType: typeString(checker, type),
    props: checker
      .getPropertiesOfType(type)
      .map(property => {
        const propertyType = checker.getTypeOfSymbolAtLocation(property, parameter);
        return {
          name: property.getName(),
          type: typeString(checker, propertyType),
          optional: !!(property.flags & ts.SymbolFlags.Optional),
          brands: context.brands.of(propertyType)
        };
      })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  };
}

/** Instantiated (contextual) types at JSX event bindings and component-prop sites. */
function jsxSiteFacts(context, behavior) {
  const { checker, sourceFile } = context;
  return behavior.eventBindings.map(binding => {
    const node = findNodeAt(
      sourceFile,
      context.toGenerated(binding.span.start),
      n => ts.isJsxAttribute(n) || ts.isJsxSpreadAttribute(n)
    );
    if (!node || !ts.isJsxAttribute(node) || !node.initializer) {
      return { attribute: binding.attribute, resolved: false };
    }
    const expression = ts.isJsxExpression(node.initializer)
      ? node.initializer.expression
      : node.initializer;
    if (!expression) return { attribute: binding.attribute, resolved: false };
    const contextual = checker.getContextualType(expression);
    const actual = checker.getTypeAtLocation(expression);
    return {
      element: binding.element,
      attribute: binding.attribute,
      resolved: true,
      expected: contextual ? typeString(checker, contextual) : null,
      actual: typeString(checker, actual),
      brands: context.brands.of(actual)
    };
  });
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------

/**
 * Validated brands: structural facts about a type the linker can rely on.
 *
 * - `block`: carries the unique `BLOCK` symbol property (`$()` value);
 * - `accessor`: callable with no required parameters and iterable through
 *   the signal read protocol (`SourceAccessor`), and not a block;
 * - `setter` / `store` / `action`: the runtime's own alias names;
 * - `function`: any other callable; `domNode`: assignable to DOM `Node`;
 * - `primitive`; `global` (captures of globals).
 */
function createBrandInspector(program, checker) {
  let eventType;
  let nodeType;
  const globalType = name => {
    for (const file of program.getSourceFiles()) {
      if (!file.isDeclarationFile || !/lib\.dom\.d\.ts$/.test(file.fileName)) continue;
      const symbol = checker
        .getSymbolsInScope(file, ts.SymbolFlags.Type)
        .find(s => s.getName() === name);
      if (symbol) return checker.getDeclaredTypeOfSymbol(symbol);
    }
    return undefined;
  };
  const symbolKeyed = (type, prefix) =>
    checker
      .getPropertiesOfType(type)
      .some(property => String(property.escapedName).startsWith(prefix));
  const aliasName = type => type.aliasSymbol?.getName() ?? null;
  const of = type => {
    const brands = [];
    if (!type) return brands;
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return ["unknown"];
    if (
      type.flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.BigIntLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined |
        ts.TypeFlags.Void |
        ts.TypeFlags.EnumLike)
    ) {
      return ["primitive"];
    }
    const isBlock = symbolKeyed(type, "__@BLOCK@");
    if (isBlock) brands.push("block");
    const signatures = type.getCallSignatures();
    const alias = aliasName(type);
    if (!isBlock && signatures.length) {
      const nullary = signatures.some(
        signature =>
          signature.getParameters().every(p => {
            const declaration = p.valueDeclaration;
            return (
              declaration &&
              ts.isParameter(declaration) &&
              (declaration.questionToken || declaration.initializer || declaration.dotDotDotToken)
            );
          }) || signature.getParameters().length === 0
      );
      if (nullary && symbolKeyed(type, "__@iterator@")) brands.push("accessor");
    }
    if (alias === "Setter" || alias === "SetStoreFunction" || alias === "StoreSetter")
      brands.push("setter");
    if (alias === "Store" || alias === "BlockStore") brands.push("store");
    if (alias === "Action" || symbolKeyed(type, "__@ACTION@")) brands.push("action");
    if (signatures.length && !brands.length) brands.push("function");
    nodeType ??= globalType("Node");
    if (nodeType && !signatures.length && checker.isTypeAssignableTo(type, nodeType))
      brands.push("domNode");
    return brands;
  };
  const isEvent = type => {
    eventType ??= globalType("Event");
    return (
      !!eventType &&
      !(type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) &&
      checker.isTypeAssignableTo(type, eventType)
    );
  };
  /** Shallow serializability: primitives, and objects/arrays of them (depth 3). */
  const serializable = (type, depth = 0) => {
    if (depth > 3) return false;
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return false;
    if (type.isUnion()) return type.types.every(member => serializable(member, depth + 1));
    if (
      type.flags &
      (ts.TypeFlags.StringLike |
        ts.TypeFlags.NumberLike |
        ts.TypeFlags.BooleanLike |
        ts.TypeFlags.Null |
        ts.TypeFlags.Undefined)
    ) {
      return true;
    }
    if (!(type.flags & ts.TypeFlags.Object) || type.getCallSignatures().length) return false;
    if (checker.isArrayType?.(type)) {
      return checker.getTypeArguments(type).every(member => serializable(member, depth + 1));
    }
    return checker
      .getPropertiesOfType(type)
      .every(
        property =>
          !String(property.escapedName).startsWith("__@") &&
          property.valueDeclaration &&
          serializable(
            checker.getTypeOfSymbolAtLocation(property, property.valueDeclaration),
            depth + 1
          )
      );
  };
  return { of, isEvent, serializable };
}
