// Compile every (scenario, variant) into a runnable ESM module whose
// `@solidjs/signals` import points at a signals build (default: the
// production build, packages/signals/dist/prod) and whose `@solidjs/web`
// import points at the fake web module (built against the same runtime).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileSource, ROOT, SIGNALS_PROD } from "../track-a/compile.mjs";
import { SCENARIOS, VARIANTS } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));

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
export function buildModules({ runtime, only, scenarios, tag } = {}) {
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
      const code = compileSource(scenario[source], scenario.filename, options)
        .replaceAll('"@solidjs/signals"', signalsUrl)
        .replaceAll('"@solidjs/web"', webUrl);
      const file = join(outDir, `${scenario.name}.${variant}.mjs`);
      writeFileSync(file, code);
      modules[`${scenario.name}/${variant}`] = file;
    }
  }
  return modules;
}
