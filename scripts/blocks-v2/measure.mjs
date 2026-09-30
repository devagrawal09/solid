// Instruction counts (valgrind/cachegrind) of one worker process.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT } from "../track-a/compile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Long enough that the measured window is past JIT tier-up: with
// `--single-threaded` optimizing compiles run on the main thread and count.
// 300 update ops was not: a late TurboFan compile of `read` (~10 ms, ~50M
// Ir) landed inside the memo/update window on one runtime and not on another
// with byte-identical code (--trace-opt; +47% on that cell). At 3000 the
// update windows of the handwritten memo / event cells are compile-free.
export const WARMUP = {
  mount: Number(process.env.BV2_WARMUP_MOUNT ?? 60),
  update: Number(process.env.BV2_WARMUP_UPDATE ?? 3000)
};

/** Resolve a runtime name: a snapshot under node_modules/.cache/blocks-v2/runtimes,
 * `current` (packages/signals/dist/prod) or a repo-relative index.js path. */
export function runtimePath(name) {
  if (!name || name === "current") return undefined;
  if (name.endsWith(".js")) return name;
  return `node_modules/.cache/blocks-v2/runtimes/${name}/index.js`;
}

// A fixed young generation (MB per semi-space). V8 otherwise grows the
// semi-spaces adaptively from the heap's history, so the same code settles
// at a different scavenge rate depending on what the process did before the
// window, even on how the runtime was loaded (a tree with vs without a
// `"type": "module"` package.json: 11 vs 6 scavenges per 200 create/mount
// ops, ±4% Ir/op on byte-identical code). Pinned, the scavenge count follows
// the bytes allocated. `BV2_SEMI_SPACE=adaptive` restores V8's sizing
// (numbers recorded before this pin used it).
const SEMI_SPACE = process.env.BV2_SEMI_SPACE ?? "8";
const GC_FLAGS =
  SEMI_SPACE === "adaptive"
    ? []
    : [`--min-semi-space-size=${SEMI_SPACE}`, `--max-semi-space-size=${SEMI_SPACE}`];

export function ir(module, mode, ops, n) {
  return new Promise((resolve, reject) => {
    const child = spawn("valgrind", [
      "--tool=cachegrind",
      "--cache-sim=no",
      "--cachegrind-out-file=/dev/null",
      process.execPath,
      "--predictable",
      "--single-threaded",
      ...GC_FLAGS,
      ...(process.env.BV2_GC_ALIGN ? ["--expose-gc"] : []),
      join(here, "worker.mjs"),
      pathToFileURL(module).href,
      mode,
      String(n),
      String(WARMUP[mode]),
      String(ops)
    ]);
    let stderr = "";
    child.stderr.on("data", d => (stderr += d));
    child.on("close", () => {
      const match = /I\s+refs:\s+([\d,]+)/.exec(stderr);
      if (!match) reject(new Error(`no instruction count:\n${stderr.slice(-2000)}`));
      else resolve(Number(match[1].replaceAll(",", "")));
    });
  });
}

/** Instructions per op: (run with 2*ops - run with ops) / ops. */
export async function irPerOp(module, mode, ops, n) {
  const [once, twice] = await Promise.all([ir(module, mode, ops, n), ir(module, mode, 2 * ops, n)]);
  return { irPerOp: (twice - once) / ops, irOnce: once, irTwice: twice };
}

/** Run `tasks` (async thunks) with at most `jobs` in flight. */
export async function pool(tasks, jobs) {
  let next = 0;
  const out = new Array(tasks.length);
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, jobs) }, worker));
  return out;
}

export { ROOT };
