// One wall-time cell (bench.mjs): `node --expose-gc bench-worker.mjs <module> <op> <n>`.
// Prints the median µs/op of 20 timed batches after warmup.
const [modulePath, opName, n] = process.argv.slice(2);
const { make } = await import(modulePath);
const N = Number(n);
let op, batch, warmup;
if (opName === "mount") {
  op = () => {
    const app = make(N);
    app.mount();
    app.unmount();
  };
  batch = 5;
  warmup = 60;
} else {
  const app = make(N);
  app.mount();
  op = app.ops[opName];
  batch = 50;
  warmup = 2000;
}
for (let i = 0; i < warmup; i++) op();
const samples = [];
for (let s = 0; s < 20; s++) {
  globalThis.gc();
  const t = performance.now();
  for (let i = 0; i < batch; i++) op();
  samples.push(((performance.now() - t) * 1000) / batch);
}
samples.sort((a, b) => a - b);
console.log(samples[10].toFixed(2));
