// Stack-B plumbing: a copy of ../common.mjs with every cache under
// node_modules/.cache/heuristics/stack-b/ (another experiment shares the
// machine and the parent harness's cache directories).
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
export const CACHE = join(ROOT, "node_modules/.cache/heuristics/stack-b");
export const OUT_DIR = join(ROOT, "documentation/plans/heuristic-oracles/stack-b");
const SIGNALS = join(ROOT, "packages/signals/dist");

// Per-process snapshot so a concurrent build that cleans dist cannot corrupt a run.
const SNAPSHOT = join(CACHE, "runtimes", String(process.pid));
export const RUNTIMES = {
  prod: join(SNAPSHOT, "prod/index.js"),
  oracle: join(SNAPSHOT, "oracle/index.js"),
  sync: join(SNAPSHOT, "sync/index.sync.js")
};

export function snapshotRuntimes() {
  rmSync(SNAPSHOT, { recursive: true, force: true });
  for (const tree of ["prod", "oracle", "sync"]) {
    const from = join(SIGNALS, tree);
    if (!existsSync(from)) throw new Error(`missing ${from}`);
    cpSync(from, join(SNAPSHOT, tree), { recursive: true });
  }
  process.on("exit", () => rmSync(SNAPSHOT, { recursive: true, force: true }));
}

export function writeModule(dir, name, source, runtime) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.mjs`);
  const specifier = pathToFileURL(RUNTIMES[runtime]).href;
  writeFileSync(file, source.replaceAll('"@solidjs/signals"', JSON.stringify(specifier)));
  return file;
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
