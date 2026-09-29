/**
 * @solidjs/blocks-linker — the type linker for @solidjs/blocks.
 *
 * One analysis, several consumers: every module is summarized by the Rust
 * analysis in @solidjs/compiler (`summarizeBlocks`, a versioned JSON
 * summary, cached here by content hash), the graph is solved in JS
 * (`solve.js`), and the result is written as a declaration file
 * (`emit.js`) that TypedProps reads. A future blocks compiler reads the same
 * summaries and facts.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { solve } from "./solve.js";
import { emit } from "./emit.js";

const require = createRequire(import.meta.url);
const SOURCE = /\.(tsx|ts|jsx|js|mts|mjs)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "coverage"]);

function hashOf(text) {
  return createHash("sha1").update(text).digest("hex");
}

/**
 * Module prefixes from the project's tsconfig.json `compilerOptions.paths`
 * (`"~/*": ["./src/*"]` → `{ "~": "<root>/src" }`): the aliases the code
 * imports through, so a render site `<Story />` imported from
 * `~/components/story` reaches its component. Only `prefix/*` → `dir/*`
 * entries (the first target) are used; tsconfig's comments and trailing
 * commas are tolerated.
 */
export function tsconfigAliases(root) {
  let text;
  try {
    text = readFileSync(path.join(root, "tsconfig.json"), "utf8");
  } catch {
    return {};
  }
  let config;
  try {
    config = JSON.parse(
      text
        .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || "")
        .replace(/,(\s*[}\]])/g, "$1")
    );
  } catch {
    return {};
  }
  const options = (config && config.compilerOptions) || {};
  const base = path.resolve(root, options.baseUrl || ".");
  const out = {};
  for (const [pattern, targets] of Object.entries(options.paths || {})) {
    if (!pattern.endsWith("/*") || !Array.isArray(targets) || !targets[0]) continue;
    const target = targets[0];
    if (!target.endsWith("/*")) continue;
    out[pattern.slice(0, -2)] = path.resolve(base, target.slice(0, -2));
  }
  return out;
}

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(path.join(dir, e.name), out);
    } else if (SOURCE.test(e.name) && !e.name.endsWith(".d.ts")) out.push(path.join(dir, e.name));
  }
  return out;
}

/**
 * @param {{
 *   root?: string,           project root (default: cwd)
 *   dirs?: string[],         source directories under root (default ["src"])
 *   out?: string,            generated file (default "src/solid-props.gen.d.ts")
 *   alias?: Record<string,string>, module prefixes resolved to directories (e.g. { "~": "src" });
 *                            default: the tsconfig.json `paths` of root
 *   publicModules?: string[],  modules whose exports have callers beyond the project
 *   summarize?: (code: string, filename: string) => object
 * }} options
 */
export function createLinker(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const dirs = (options.dirs || ["src"]).map(d => path.resolve(root, d));
  const out = path.resolve(root, options.out || "src/solid-props.gen.d.ts");
  const alias = options.alias
    ? Object.fromEntries(Object.entries(options.alias).map(([k, v]) => [k, path.resolve(root, v)]))
    : tsconfigAliases(root);
  const publicModules = new Set((options.publicModules || []).map(p => path.resolve(root, p)));
  const summarize =
    options.summarize ||
    ((code, filename) => require("@solidjs/compiler").summarizeBlocks(code, { filename }));

  /** module id → { hash, summary } */
  const cache = new Map();
  const modules = new Map();
  let schemaVersion = 1;
  let lastErrors = [];

  function load(file) {
    if (path.resolve(file) === out) return false;
    let code;
    try {
      code = readFileSync(file, "utf8");
    } catch {
      return remove(file);
    }
    const hash = hashOf(code);
    const cached = cache.get(file);
    if (cached && cached.hash === hash) return false;
    let summary;
    try {
      summary = summarize(code, file);
    } catch (error) {
      lastErrors.push({ file, message: String(error && error.message ? error.message : error) });
      return false;
    }
    schemaVersion = summary.version;
    cache.set(file, { hash, summary });
    modules.set(file, summary);
    return true;
  }
  function remove(file) {
    const had = modules.delete(file);
    cache.delete(file);
    return had;
  }
  function inScope(file) {
    return (
      SOURCE.test(file) && !file.endsWith(".d.ts") && dirs.some(d => file.startsWith(d + path.sep))
    );
  }

  const linker = {
    root,
    out,
    /** Summarize every source module (cached by content hash). */
    scan() {
      lastErrors = [];
      const seen = new Set();
      for (const dir of dirs)
        for (const f of walk(dir, [])) {
          seen.add(f);
          load(f);
        }
      for (const f of [...modules.keys()]) if (!seen.has(f)) remove(f);
      return linker;
    },
    /** A file changed / was added / removed: re-summarize it. Returns whether facts may have changed. */
    update(file) {
      file = path.resolve(file);
      if (!inScope(file)) return false;
      if (!existsSync(file)) return remove(file);
      return load(file);
    },
    /** Solve the graph and render the generated file (no write). */
    generate() {
      const solved = solve(modules, { root, alias, isPublic: id => publicModules.has(id) });
      return {
        text: emit(solved, out, { root, schemaVersion }),
        diagnostics: [
          ...solved.diagnostics,
          ...lastErrors.map(e => ({
            level: "error",
            code: "LINK_PARSE",
            message: `${e.file}: ${e.message}`
          }))
        ],
        solved
      };
    },
    /** Regenerate and write when the content changed. Returns { changed, text }. */
    write() {
      const { text, diagnostics } = linker.generate();
      const current = existsSync(out) ? readFileSync(out, "utf8") : null;
      if (current === text) return { changed: false, text, diagnostics };
      writeFileSync(out, text);
      return { changed: true, text, diagnostics };
    },
    /** Compare the committed file with a fresh generation. */
    check() {
      const { text, diagnostics } = linker.generate();
      const current = existsSync(out) ? readFileSync(out, "utf8") : null;
      return { stale: current !== text, expected: text, current, diagnostics };
    },
    modules,
    inScope
  };
  return linker;
}

export { solve } from "./solve.js";
export { emit } from "./emit.js";
