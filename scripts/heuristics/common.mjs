// Shared plumbing for the heuristic-oracle harness.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SIGNALS = join(ROOT, "packages/signals/dist");

/** Runtimes: shipped prod tree, the same tree with oracle arms, async-free
 * tree. Measured from a snapshot (`snapshotRuntimes`) so a concurrent
 * workspace build that cleans packages/signals/dist cannot corrupt a run. */
// Per process, so concurrent harness scripts never delete each other's copy.
const SNAPSHOT = join(ROOT, "node_modules/.cache/heuristics/runtimes", String(process.pid));
export const RUNTIMES = {
  prod: join(SNAPSHOT, "prod/index.js"),
  oracle: join(SNAPSHOT, "oracle/index.js"),
  sync: join(SNAPSHOT, "sync/index.sync.js")
};

export function snapshotRuntimes() {
  rmSync(SNAPSHOT, { recursive: true, force: true });
  for (const tree of ["prod", "oracle", "sync"]) {
    const from = join(SIGNALS, tree);
    if (!existsSync(from))
      throw new Error(`missing ${from}: run the signals build and scripts/heuristics/build.mjs`);
    cpSync(from, join(SNAPSHOT, tree), { recursive: true });
  }
}

/**
 * Cells: (runtime, source variant). `baseline@prod` is the reference;
 * `baseline@oracle` (control) prices the oracle arms with no node opted in;
 * each oracle variant runs on the oracle runtime; `baseline@sync` places the
 * per-node oracles next to the whole-graph async-free core (Track A stage 2).
 */
export function cells(scenario) {
  const out = [
    { label: "baseline@prod", variant: "baseline", runtime: "prod" },
    { label: "control@oracle", variant: "baseline", runtime: "oracle" },
    { label: "baseline@sync", variant: "baseline", runtime: "sync" }
  ];
  for (const v of Object.keys(scenario.variants))
    if (v !== "baseline") out.push({ label: `${v}@oracle`, variant: v, runtime: "oracle" });
  return out;
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
