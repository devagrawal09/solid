// @ts-check
/**
 * `transform(code, { filename, blocksModule })`: the rule applied to source
 * text. The source is parsed with Babel (TypeScript and JSX kept as written)
 * and only the rewritten spans are edited, so the output is the input plus
 * the edits — types, formatting and comments untouched — and the source map
 * is exact. `null` when nothing changed: a file with no `yield*` in JSX comes
 * back byte-identical because it does not come back at all.
 */
import babel from "@babel/core";
import MagicString from "magic-string";
import { BlocksRuleError, DEFAULT_BLOCKS_MODULE, blocksRule, performLocal } from "./rule.js";

/** @typedef {import("@babel/core").types.Program} Program */
/** @typedef {import("@babel/core").NodePath<Program>} ProgramPath */

/**
 * Babel parser plugins for a file name: TypeScript for `.ts`/`.tsx` (and their
 * `m`/`c` forms), JSX for everything but `.ts`, decorators everywhere (the
 * plugins `@solidjs/vite-plugin` parses with).
 * @param {string} filename
 * @returns {import("@babel/core").ParserOptions["plugins"]}
 */
export function parserPlugins(filename) {
  const ext = /\.([mc]?[jt]sx?)$/i.exec(filename)?.[1].toLowerCase().replace(/^[mc]/, "") ?? "js";
  /** @type {import("@babel/core").ParserOptions["plugins"]} */
  const plugins = ["decorators"];
  if (ext !== "ts") plugins.push("jsx");
  if (ext === "ts" || ext === "tsx") plugins.push("typescript");
  return plugins;
}

/**
 * @typedef {object} TransformOptions
 * @property {string} filename the module's file name (picks the parser dialect; names the map's source)
 * @property {string} [blocksModule] the module `perform` is imported from (default `@solidjs/blocks`)
 * @property {boolean} [sourceMap] produce a source map (default `true`)
 */

/**
 * @typedef {object} TransformResult
 * @property {string} code
 * @property {import("magic-string").SourceMap | null} map
 */

/**
 * Parse a module and hand back its program path.
 * @param {string} code
 * @param {string} filename
 * @returns {ProgramPath | null}
 */
export function parseProgram(code, filename) {
  const ast = babel.parseSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: "module",
    parserOpts: { plugins: parserPlugins(filename) }
  });
  if (!ast) return null;
  /** @type {ProgramPath | null} */
  let program = null;
  babel.traverse(ast, {
    Program(path) {
      program = path;
      path.stop();
    }
  });
  return program;
}

/**
 * Apply the rule to source text. Throws a `BlocksRuleError` (every refusal,
 * the compiler's format; `id` and `loc` set for Vite) on a refused position.
 * @param {string} code
 * @param {TransformOptions} options
 * @returns {TransformResult | null}
 */
export function transform(code, options) {
  const { filename } = options;
  if (!filename) throw new TypeError("transform: `filename` is required");
  const blocksModule = options.blocksModule ?? DEFAULT_BLOCKS_MODULE;
  // Cheap pre-check, as the compiler's: no `yield`, nothing to rewrite.
  if (!code.includes("yield")) return null;

  const program = parseProgram(code, filename);
  if (!program) return null;

  const { holes, refusals } = blocksRule(program);
  if (refusals.length) {
    const error = new BlocksRuleError(refusals);
    const first = error.refusals[0];
    Object.assign(error, {
      id: filename,
      loc: { file: filename, line: first.line, column: first.column }
    });
    throw error;
  }
  if (!holes.length) return null;

  const s = new MagicString(code);
  const local = performLocal(program);
  for (const { node } of holes) {
    const start = /** @type {number} */ (node.start);
    const end = /** @type {number} */ (node.end);
    // `yield*` and the whitespace after it become `_$perform(`; the
    // argument stays exactly as written (parentheses included), so a
    // sequence argument stays one argument.
    const keyword = /^yield\s*\*\s*/.exec(code.slice(start, end));
    if (!keyword) throw new Error(`unexpected yield text at ${start}`);
    s.overwrite(start, start + keyword[0].length, `${local}(`);
    s.appendLeft(end, ")");
  }
  // The first statement of the module, as the compiler's rule inserts it:
  // after a hashbang and the directive prologue (a directive must stay
  // first), on a line of its own. On the same line as what follows, a
  // first-line comment would become the import's trailing comment and the
  // compiled output would differ from the compiler's rule (D-043 parity);
  // the one-line shift is carried by the source map.
  const line = `import { perform as ${local} } from ${JSON.stringify(blocksModule)};`;
  const directives = program.node.directives;
  const after = directives.length
    ? directives[directives.length - 1].end
    : program.node.interpreter?.end;
  if (after != null) s.appendLeft(after, "\n" + line);
  else s.prependLeft(0, line + "\n");

  return {
    code: s.toString(),
    map:
      options.sourceMap === false
        ? null
        : s.generateMap({ source: filename, file: filename, includeContent: true, hires: true })
  };
}
