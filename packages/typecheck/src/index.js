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
import { buildSummaries, writeSummaries } from "./summary.js";

export {
  buildSummaries,
  writeSummaries,
  mapToGenerated,
  sourceHash,
  MODULE_SCHEMA,
  INDEX_SCHEMA,
  SUMMARY_VERSION
} from "./summary.js";

const require = createRequire(import.meta.url);

function loadCompiler() {
  try {
    return require("@solidjs/compiler");
  } catch {
    // Workspace layout fallback (the package is a sibling of the compiler).
    return require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../compiler"));
  }
}

/** Cheap gate: only modules that import `$` from a runtime source are projected. */
export function shouldProject(text) {
  return /\byield\s*\*/.test(text) && /from\s+["'](solid-js|@solidjs\/signals)["']/.test(text);
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
      if (!diagnostic.file || diagnostic.start === undefined) {
        return `${category} TS${diagnostic.code}: ${message}`;
      }
      const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      const fileName = path.relative(cwd, diagnostic.file.fileName);
      return `${fileName}(${line + 1},${character + 1}): ${category} TS${diagnostic.code}: ${message}`;
    })
    .join("\n");
}

/**
 * Check (and emit, unless `noEmit`) one project. Returns the authored-position
 * diagnostics and the emit result.
 *
 * `summaries` (Track C): `true` builds the typed module summaries
 * (`result.summaries = { index, modules }`); `{ outDir }` also writes them
 * (`<outDir>/index.json`, `<outDir>/<module>.summary.json`); `rootDir`
 * (default: the tsconfig's directory, else `cwd`) is what module paths are
 * relative to.
 */
export function check({
  project,
  options: overrides = {},
  files,
  cwd = process.cwd(),
  summaries,
  compiler = loadCompiler()
}) {
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
  const host = createProjectedHost(options, projections, compiler);
  const program = ts.createProgram({ rootNames: fileNames, options, host });
  const diagnostics = [...ts.getPreEmitDiagnostics(program)];
  let emitSkipped = true;
  if (!options.noEmit) {
    const result = program.emit();
    diagnostics.push(...result.diagnostics);
    emitSkipped = result.emitSkipped;
  }
  const result = {
    diagnostics: remapDiagnostics(diagnostics, projections),
    emitSkipped,
    projections
  };
  if (summaries) {
    const rootDir =
      (typeof summaries === "object" && summaries.rootDir) ||
      (project ? path.dirname(path.resolve(cwd, project)) : cwd);
    const started = performance.now();
    result.summaries = buildSummaries({ program, projections, compiler, rootDir, diagnostics });
    if (typeof summaries === "object" && summaries.outDir) {
      writeSummaries(result.summaries, path.resolve(cwd, summaries.outDir));
    }
    result.summaryTime = performance.now() - started;
  }
  return result;
}

/** CLI entry: a `tsc`-shaped argument list; returns the exit code. */
export function run(argv, { log = console.log, cwd = process.cwd() } = {}) {
  // `tsc` parses `-b` with a separate build-mode parser; refuse both modes
  // before the single-project parser reports them as unknown options.
  if (argv.some(arg => /^(-b|--build|-w|--watch)$/.test(arg))) {
    log("solid-tsc: --build and --watch are not supported; run each project with -p");
    return 1;
  }
  // `--solidSummaries <dir>`: emit typed module summaries (not a tsc option,
  // so it is taken out before tsc parses the rest).
  let summaries;
  const summaryIndex = argv.indexOf("--solidSummaries");
  if (summaryIndex !== -1) {
    const outDir = argv[summaryIndex + 1];
    if (!outDir || outDir.startsWith("-")) {
      log("solid-tsc: --solidSummaries requires an output directory");
      return 1;
    }
    summaries = { outDir };
    argv = [...argv.slice(0, summaryIndex), ...argv.slice(summaryIndex + 2)];
  }
  const parsed = ts.parseCommandLine(argv);
  if (parsed.errors.length) {
    log(formatDiagnostics(parsed.errors, cwd));
    return 1;
  }
  const { project, ...options } = parsed.options;
  const result = check({ project, options, files: parsed.fileNames, cwd, summaries });
  const errors = result.diagnostics.filter(d => d.category === ts.DiagnosticCategory.Error);
  if (result.diagnostics.length) log(formatDiagnostics(result.diagnostics, cwd));
  return errors.length ? 1 : 0;
}
