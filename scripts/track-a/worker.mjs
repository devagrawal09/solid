// One measurement process: `node --expose-gc --max-semi-space-size=256
// worker.mjs <module> <mode> <n> <warmup> <samples> <perSample>`.
// Prints one JSON line: per-sample ns/op, allocation bytes/op, GC-discarded
// allocation samples.
import { performance } from "node:perf_hooks";
import { GCProfiler } from "node:v8";

const [modulePath, mode, n, warmup, samples, perSample] = process.argv.slice(2);
const N = Number(n);
const { make } = await import(modulePath);

let op;
let teardown = () => {};
if (mode === "mount") {
  op = () => {
    const app = make(N);
    app.mount();
    app.unmount();
  };
} else if (mode === "update") {
  const app = make(N);
  app.mount();
  op = () => app.update();
  teardown = () => app.unmount();
} else throw new Error(`unknown mode ${mode}`);

for (let i = 0; i < Number(warmup); i++) op();

const nsPerOp = [];
for (let s = 0; s < Number(samples); s++) {
  globalThis.gc();
  const k = Number(perSample);
  const t0 = performance.now();
  for (let i = 0; i < k; i++) op();
  nsPerOp.push(((performance.now() - t0) * 1e6) / k);
}

// Allocation: heap growth over one op with no collection in between (a
// large semi-space keeps scavenges out of a single op; V8's synchronous GC
// profiler reports any collection that happened anyway, and that sample is
// discarded).
const bytesPerOp = [];
let discarded = 0;
for (let s = 0; s < 15; s++) {
  globalThis.gc();
  const profiler = new GCProfiler();
  profiler.start();
  const h0 = process.memoryUsage().heapUsed;
  op();
  const h1 = process.memoryUsage().heapUsed;
  const { statistics } = profiler.stop();
  if (statistics.length) discarded++;
  else bytesPerOp.push(h1 - h0);
}
teardown();
process.stdout.write(JSON.stringify({ nsPerOp, bytesPerOp, discarded }) + "\n");
