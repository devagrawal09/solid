// Stack-A measurement build only: the async-free core (src/index.sync.ts, as
// dist/sync) with the __ORACLE__ arms compiled in. Output goes to
// node_modules/.cache/heuristics/stack-a/oracle-sync, never packages/*/dist.
// Driven by build-oracle-sync.mjs (run with cwd packages/signals so the
// signals tsconfig and plugins resolve).
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const SIGNALS = join(ROOT, "packages/signals");
const require = createRequire(join(SIGNALS, "package.json"));
const replace = require("@rollup/plugin-replace");
const typescript = require("@rollup/plugin-typescript");
export const OUT = join(ROOT, "node_modules/.cache/heuristics/stack-a/oracle-sync");

export default {
  input: { "index.sync": join(SIGNALS, "src/index.sync.ts") },
  output: { dir: OUT, format: "esm", preserveModules: true, preserveModulesRoot: join(SIGNALS, "src") },
  treeshake: { tryCatchDeoptimization: false },
  plugins: [
    (replace.default ?? replace)({
      __DEV__: "false",
      __OBSERVE__: "false",
      __TEST__: "false",
      __ASYNC__: "false",
      __ORACLE__: "true",
      preventAssignment: true
    }),
    (typescript.default ?? typescript)({
      declaration: false,
      outDir: OUT,
      module: "esnext",
      target: "esnext",
      moduleResolution: "bundler",
      verbatimModuleSyntax: true
    })
  ]
};
