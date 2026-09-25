/**
 * Compile a scenario source with the real native compiler and evaluate the
 * emitted module with explicitly injected dependencies.
 *
 * The harness never hand-writes "what the compiler would emit": every
 * generator mode runs `transform()` output. Evaluation rewrites only the
 * module syntax the compiler emits (single-line `import { … } from "…"` and
 * `export function|const|let|class`) into bindings over an injected module
 * table, so the same compiled code runs against whichever `solid-js` /
 * `@solidjs/web` build the current vitest project resolves (client, server,
 * or hydrating client). Anything outside that grammar fails loudly rather
 * than being approximated.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// The workspace compiler (built compiler.node), the same one the vite
// plugin uses for the rest of this package's tests.
const compiler = require("../../../../compiler/index.js") as {
  transform(code: string, options: Record<string, unknown>): { code: string; resumable?: any };
};

export type CompileOptions = Record<string, unknown>;

export interface CompiledModule {
  code: string;
  /** Static facts about the emitted code, reported in the coverage matrix. */
  stats: LoweringStats;
  /** The resumable-events manifest (with the event module) when the compile asked for it. */
  resumable?: any;
}

export interface LoweringStats {
  /** `$(` block constructions left in the output. */
  blocks: number;
  /** `function*` bodies left in the output (runtime-driver blocks). */
  generators: number;
  /** `_$perform(` call-form operations emitted by lowering. */
  performs: number;
}

export function lowering(code: string): LoweringStats {
  const count = (re: RegExp) => code.match(re)?.length ?? 0;
  return {
    blocks: count(/(?<![\w$])\$\(/g),
    generators: count(/function\s*\*/g),
    performs: count(/_\$perform\(/g)
  };
}

export function compile(
  source: string,
  options: CompileOptions,
  filename = "scenario.jsx"
): CompiledModule {
  const { code, resumable } = compiler.transform(source, { filename, ...options });
  return { code, stats: lowering(code), resumable };
}

const IMPORT = /^import\s+(.+?)\s+from\s+"([^"]+)";?\s*$/;
const EXPORT_DECL = /^export\s+(?:async\s+)?(function\*?|const|let|class)\s+([\w$]+)/;
/** `export let a, b, c;` — declarations without initializers. */
const EXPORT_LIST = /^export\s+(?:let|var)\s+([\w$]+(?:\s*,\s*[\w$]+)*)\s*;\s*$/;

function bindings(clause: string, spec: string): string {
  clause = clause.trim();
  const named = clause.match(/^\{([^}]*)\}$/);
  if (named) {
    const parts = named[1]
      .split(",")
      .map(part => part.trim())
      .filter(Boolean)
      .map(part => {
        const [imported, local] = part.split(/\s+as\s+/);
        return local ? `${imported}: ${local}` : imported;
      });
    return `const { ${parts.join(", ")} } = __import(${JSON.stringify(spec)});`;
  }
  const ns = clause.match(/^\*\s+as\s+([\w$]+)$/);
  if (ns) return `const ${ns[1]} = __import(${JSON.stringify(spec)});`;
  throw new Error(`[conformance] unsupported import clause \`${clause}\` from "${spec}"`);
}

/**
 * Evaluate compiled ESM against `modules`. Returns the module's exports.
 */
export function evaluate(code: string, modules: Record<string, unknown>): Record<string, any> {
  const exported: string[] = [];
  const lines = code.split("\n").map(line => {
    const imp = line.match(IMPORT);
    if (imp) return bindings(imp[1], imp[2]);
    const list = line.match(EXPORT_LIST);
    if (list) {
      exported.push(...list[1].split(",").map(name => name.trim()));
      return line.replace(/^export\s+/, "");
    }
    const exp = line.match(EXPORT_DECL);
    if (exp) {
      exported.push(exp[2]);
      return line.replace(/^export\s+/, "");
    }
    if (/^\s*(import|export)\b/.test(line)) {
      throw new Error(`[conformance] unsupported module syntax in compiled output: ${line}`);
    }
    return line;
  });
  // Live bindings: `export let` values assigned during setup stay visible.
  const live = exported.map(name => `get ${name}() { return ${name}; }`).join(", ");
  const body =
    `"use strict";\n${lines.join("\n")}\n` +
    `return { ${live} };\n//# sourceURL=conformance-scenario.js`;
  const importer = (spec: string) => {
    if (!(spec in modules))
      throw new Error(`[conformance] scenario imported unknown module "${spec}"`);
    return modules[spec];
  };
  return new Function("__import", body)(importer);
}
