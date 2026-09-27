// Compile every (scenario, variant) into a runnable ESM module whose
// `@solidjs/signals` import points at a signals build (default: the
// production build, packages/signals/dist/prod) and whose `@solidjs/web`
// import points at the fake web module (built against the same runtime).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileSource, ROOT, SIGNALS_PROD } from "../track-a/compile.mjs";
import { SCENARIOS, VARIANTS } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const COMPILER_INDEX = join(ROOT, "packages/compiler/index.js");

/** A compiler whose native binding is `nativePath` (e.g. a saved baseline
 * binary): the JS wrapper re-required with SOLID_COMPILER_NATIVE set. */
function compilerAt(nativePath) {
  const previous = process.env.SOLID_COMPILER_NATIVE;
  process.env.SOLID_COMPILER_NATIVE = nativePath;
  delete require.cache[require.resolve(COMPILER_INDEX)];
  try {
    return require(COMPILER_INDEX);
  } finally {
    if (previous === undefined) delete process.env.SOLID_COMPILER_NATIVE;
    else process.env.SOLID_COMPILER_NATIVE = previous;
    delete require.cache[require.resolve(COMPILER_INDEX)];
  }
}

/**
 * A runtime spec: `name` or `name+compiler`, where `compiler` names a saved
 * native binary node_modules/.cache/blocks-v2/runtimes/<compiler>.node — so
 * a "before" row can pair the old runtime with the old compiler.
 */
export function parseSpec(spec) {
  const [runtime, compiler] = spec.split("+");
  return {
    runtime,
    compiler: compiler
      ? join(ROOT, "node_modules/.cache/blocks-v2/runtimes", `${compiler}.node`)
      : undefined
  };
}

export function parseArgs(argv) {
  return Object.fromEntries(
    argv
      .join(" ")
      .split("--")
      .filter(Boolean)
      .map(pair => {
        const [k, ...v] = pair.trim().split(/\s+/);
        return [k, v.join(" ") || "true"];
      })
  );
}

/**
 * @returns {Record<string, string>} `${scenario}/${variant}` → module path
 */
export function buildModules({ runtime, only, scenarios, tag, compiler } = {}) {
  const alt = compiler ? compilerAt(compiler) : null;
  const compile = (source, filename, options) =>
    alt
      ? alt.transform(source, { filename, generate: "dom", ...options }).code
      : compileSource(source, filename, options);
  const runtimePath = runtime ? join(ROOT, runtime) : SIGNALS_PROD;
  const outDir = join(ROOT, "node_modules/.cache/blocks-v2", tag ?? (runtime ?? "prod").replace(/\W+/g, "-"));
  mkdirSync(outDir, { recursive: true });
  const signalsUrl = JSON.stringify(pathToFileURL(runtimePath).href);
  const webFile = join(outDir, "fake-web.mjs");
  writeFileSync(
    webFile,
    readFileSync(join(here, "fake-web.mjs"), "utf8").replaceAll('"@solidjs/signals"', signalsUrl)
  );
  const webUrl = JSON.stringify(pathToFileURL(webFile).href);
  const modules = {};
  for (const scenario of SCENARIOS) {
    if (scenarios && !scenarios.includes(scenario.name)) continue;
    for (const [variant, { source, options }] of Object.entries(VARIANTS)) {
      if (only && !only.includes(variant)) continue;
      if (!scenario[source]) continue;
      const code = compile(scenario[source], scenario.filename, options)
        .replaceAll('"@solidjs/signals"', signalsUrl)
        .replaceAll('"@solidjs/web"', webUrl);
      const file = join(outDir, `${scenario.name}.${variant}.mjs`);
      writeFileSync(file, code);
      modules[`${scenario.name}/${variant}`] = file;
    }
  }
  return modules;
}
