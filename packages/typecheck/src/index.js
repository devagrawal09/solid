// solid-tsc — `tsc` over the block typecheck projection.
//
// Stock TypeScript cannot type `yield* store.user.name` inside a `$` block
// (it sees a string, iterated as characters). This program builds an
// ordinary TypeScript `Program` whose compiler host hands the checker the
// *projected* text of every module that imports `$` from solid-js /
// @solidjs/signals — `yield* store.user.name` becomes
// `yield* readPath(store, ["user", "name"])`, typed `StoreRead<…>` — and maps
// every diagnostic back to authored positions through the projection's edit
// list. Declarations are emitted from the projected program, so downstream
// consumers see ordinary types and need no projection.
//
// Scope: `-p/--project`, `--noEmit`, and the other compiler options of a
// single project (what the repo's `typecheck` scripts run). `tsc -b`
// (project references in build mode) and `--watch` are not wrapped: run each
// project through solid-tsc, consumers after their dependencies have emitted
// declarations. Editors: no language-service plugin ships yet, so an editor
// still reports the authored `yield*` as an error (see README).
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const require = createRequire(import.meta.url);

function loadCompiler() {
  try {
    return require("@solidjs/compiler");
  } catch {
    // Workspace layout fallback (the package is a sibling of the compiler).
    return require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../compiler"));
  }
}

const RUNTIME_IMPORT = /from\s+["'](solid-js|@solidjs\/signals)["']/;

/** Cheap gate: only modules that import `$` from a runtime source are projected. */
export function shouldProject(text) {
  return /\byield\s*\*/.test(text) && RUNTIME_IMPORT.test(text);
}

/** Cheap gate: only modules that may hold a strict `$(fn)` marker are analyzed. */
export function shouldAnalyzeStrict(text) {
  return /\$\s*\(/.test(text) && RUNTIME_IMPORT.test(text);
}

/**
 * Stable numeric codes for the compiler's strict diagnostics, so they print
 * as `error SOLID9000x:` next to TypeScript's `TS` codes.
 */
export const STRICT_DIAGNOSTIC_CODES = {
  STRICT_HOST_UNKNOWN: 90001,
  STRICT_HOST_AMBIGUOUS: 90002,
  STRICT_CAPABILITY_ESCAPE: 90003,
  STRICT_OPAQUE_ARGUMENT: 90004,
  STRICT_WRITE_IN_REACTIVE_HOST: 90005,
  STRICT_READ_AFTER_AWAIT: 90006,
  STRICT_CREATION_AFTER_AWAIT: 90007,
  STRICT_CONTEXT_IN_BLOCK: 90008,
  STRICT_STORE_ASSIGNMENT: 90009,
  STRICT_ASSIGNMENT_TO_CAPABILITY: 90010,
  STRICT_UNSUPPORTED_SYNTAX: 90011
};

/**
 * Analyze one authored module for strict `$(fn)` callbacks: the compiler's
 * graph summaries (`blocks`) plus its diagnostics as TypeScript-shaped
 * diagnostics anchored on the authored text (`file`, `start`, `length` in
 * UTF-16 units, `source: "solid-strict"`). This is the boundary an editor
 * language service consumes per file: every site in a summary is an
 * authored offset, so hovers, code lenses and diagnostics need no mapping.
 */
export function analyzeStrictFile(fileName, text, compiler = loadCompiler()) {
  const analysis = compiler.analyzeStrictBlocks(text, { filename: path.basename(fileName) });
  const file = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const diagnostics = analysis.diagnostics.map(diagnostic => ({
    file,
    start: diagnostic.site.start,
    length: Math.max(0, diagnostic.site.end - diagnostic.site.start),
    messageText: `[${diagnostic.code}] ${diagnostic.message}`,
    category: ts.DiagnosticCategory.Error,
    code: STRICT_DIAGNOSTIC_CODES[diagnostic.code] ?? 90000,
    source: "solid-strict"
  }));
  return { blocks: analysis.blocks, diagnostics };
}

/**
 * Wrap a TypeScript compiler host so projected modules reach the checker.
 * `projections` collects `{ source, edits }` per projected file name.
 */
export function createProjectedHost(options, projections, compiler = loadCompiler()) {
  const host = ts.createCompilerHost(options, true);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    if (!/\.[cm]?[jt]sx?$/.test(fileName) || fileName.endsWith(".d.ts")) {
      return getSourceFile.call(
        host,
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile
      );
    }
    const text = host.readFile(fileName);
    if (text === undefined) return undefined;
    if (!shouldProject(text)) {
      return ts.createSourceFile(fileName, text, languageVersionOrOptions, true);
    }
    const projected = compiler.projectBlocksForTypecheck(text, {
      filename: path.basename(fileName)
    });
    if (projected.rewrites > 0) projections.set(fileName, { source: text, edits: projected.edits });
    return ts.createSourceFile(fileName, projected.code, languageVersionOrOptions, true);
  };
  return host;
}

/** Map a generated offset back to the authored offset (UTF-16 units). */
export function mapToSource(edits, position) {
  let delta = 0;
  for (const edit of edits) {
    if (position < edit.generatedStart) break;
    if (position < edit.generatedEnd) {
      // Inside a rewrite: report at the start of the authored operand.
      return edit.sourceStart;
    }
    delta += edit.generatedEnd - edit.generatedStart - (edit.sourceEnd - edit.sourceStart);
  }
  return position - delta;
}

/** Diagnostics re-anchored to authored positions (file, start, length). */
export function remapDiagnostics(diagnostics, projections) {
  return diagnostics.map(diagnostic => {
    const file = diagnostic.file;
    if (!file || diagnostic.start === undefined) return diagnostic;
    const projection = projections.get(file.fileName);
    if (!projection) return diagnostic;
    const start = mapToSource(projection.edits, diagnostic.start);
    const end = mapToSource(projection.edits, diagnostic.start + (diagnostic.length ?? 0));
    const authored = ts.createSourceFile(
      file.fileName,
      projection.source,
      file.languageVersion,
      true
    );
    return { ...diagnostic, file: authored, start, length: Math.max(0, end - start) };
  });
}

export function formatDiagnostics(diagnostics, cwd = process.cwd()) {
  return diagnostics
    .map(diagnostic => {
      const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
      const category = ts.DiagnosticCategory[diagnostic.category].toLowerCase();
      const prefix = diagnostic.source === "solid-strict" ? "SOLID" : "TS";
      if (!diagnostic.file || diagnostic.start === undefined) {
        return `${category} ${prefix}${diagnostic.code}: ${message}`;
      }
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const fileName = path.relative(cwd, diagnostic.file.fileName);
      return `${fileName}(${line + 1},${character + 1}): ${category} ${prefix}${diagnostic.code}: ${message}`;
    })
    .join("\n");
}

/**
 * Check (and emit, unless `noEmit`) one project. Returns the authored-position
 * diagnostics (TypeScript's, then the compiler's strict `$(fn)` diagnostics)
 * and the emit result, plus `strictBlocks`: the graph summary of every strict
 * callback per file name.
 */
export function check({ project, options: overrides = {}, files, cwd = process.cwd() }) {
  let options;
  let fileNames;
  if (project) {
    const configPath = path.resolve(cwd, project);
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      return { diagnostics: [configFile.error], emitSkipped: true };
    }
    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      path.dirname(configPath),
      overrides,
      configPath
    );
    options = parsed.options;
    fileNames = parsed.fileNames;
    if (parsed.errors.length) return { diagnostics: parsed.errors, emitSkipped: true };
  } else {
    options = overrides;
    fileNames = (files ?? []).map(file => path.resolve(cwd, file));
  }
  const projections = new Map();
  const compiler = loadCompiler();
  const host = createProjectedHost(options, projections, compiler);
  const program = ts.createProgram({ rootNames: fileNames, options, host });
  const diagnostics = [...ts.getPreEmitDiagnostics(program)];
  let emitSkipped = true;
  if (!options.noEmit) {
    const result = program.emit();
    diagnostics.push(...result.diagnostics);
    emitSkipped = result.emitSkipped;
  }
  // Strict `$(fn)` callbacks: the compiler's analysis runs over the authored
  // text of every project file (declarations excluded), so its sites need no
  // remapping. A parse error here is TypeScript's to report, not ours.
  const strictBlocks = new Map();
  const strictDiagnostics = [];
  for (const fileName of fileNames) {
    if (!/\.[cm]?[jt]sx?$/.test(fileName) || fileName.endsWith(".d.ts")) continue;
    const text = host.readFile(fileName);
    if (text === undefined || !shouldAnalyzeStrict(text)) continue;
    let analysis;
    try {
      analysis = analyzeStrictFile(fileName, text, compiler);
    } catch {
      continue;
    }
    if (analysis.blocks.length) strictBlocks.set(fileName, analysis.blocks);
    strictDiagnostics.push(...analysis.diagnostics);
  }
  return {
    diagnostics: [...remapDiagnostics(diagnostics, projections), ...strictDiagnostics],
    emitSkipped,
    projections,
    strictBlocks
  };
}

/** CLI entry: a `tsc`-shaped argument list; returns the exit code. */
export function run(argv, { log = console.log, cwd = process.cwd() } = {}) {
  // `tsc` parses `-b` with a separate build-mode parser; refuse both modes
  // before the single-project parser reports them as unknown options.
  if (argv.some(arg => /^(-b|--build|-w|--watch)$/.test(arg))) {
    log("solid-tsc: --build and --watch are not supported; run each project with -p");
    return 1;
  }
  const parsed = ts.parseCommandLine(argv);
  if (parsed.errors.length) {
    log(formatDiagnostics(parsed.errors, cwd));
    return 1;
  }
  const { project, ...options } = parsed.options;
  const result = check({ project, options, files: parsed.fileNames, cwd });
  const errors = result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
  if (result.diagnostics.length) log(formatDiagnostics(result.diagnostics, cwd));
  return errors.length ? 1 : 0;
}
