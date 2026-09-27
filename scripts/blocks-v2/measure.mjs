// Instruction counts (valgrind/cachegrind) of one worker process.
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ROOT } from "../track-a/compile.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Long enough that the measured window is past JIT tier-up: with
// `--single-threaded` optimizing compiles run on the main thread and count.
export const WARMUP = {
  mount: Number(process.env.BV2_WARMUP_MOUNT ?? 60),
  update: Number(process.env.BV2_WARMUP_UPDATE ?? 300)
};

/** Resolve a runtime name: a snapshot under node_modules/.cache/blocks-v2/runtimes,
 * `current` (packages/signals/dist/prod) or a repo-relative index.js path. */
export function runtimePath(name) {
  if (!name || name === "current") return undefined;
  if (name.endsWith(".js")) return name;
  return `node_modules/.cache/blocks-v2/runtimes/${name}/index.js`;
}

export function ir(module, mode, ops, n) {
  return new Promise((resolve, reject) => {
    const child = spawn("valgrind", [
      "--tool=cachegrind",
      "--cache-sim=no",
      "--cachegrind-out-file=/dev/null",
      process.execPath,
      "--predictable",
      "--single-threaded",
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
