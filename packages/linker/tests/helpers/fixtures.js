import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { check, formatDiagnostics } from "@solidjs/typecheck";
import { createNodeResolver } from "../../src/load.js";

export const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures");
export const appRoot = path.join(fixtures, "app");
export const aliasMap = {
  "ui-kit": path.join(fixtures, "libs/ui-kit/dist/index.js"),
  "legacy-lib": path.join(fixtures, "libs/legacy-lib/dist/index.js")
};

export function resolverFor(map = aliasMap, conditions) {
  const base = createNodeResolver(conditions ? { conditions } : undefined);
  return (source, importer) => (map[source] ? { id: map[source] } : base(source, importer));
}

export function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `solid-linker-${prefix}-`));
}

/** Run solid-tsc over a fixture project and write its typed summaries. */
export function typedSummaries(project, outDir = tempDir("summaries")) {
  const result = check({ project, summaries: { outDir } });
  const errors = formatDiagnostics(result.diagnostics.filter(d => d.category === 1));
  return { dir: outDir, errors, result };
}

/** Copy a fixture tree (for tests that mutate sources or summaries). */
export function copyFixture(name, to = tempDir(name)) {
  fs.cpSync(path.join(fixtures, name), to, { recursive: true });
  return to;
}
