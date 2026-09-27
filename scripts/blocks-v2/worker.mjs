// One measurement process: `node worker.mjs <module-url> <mode> <n> <warmup> <ops> [timed]`.
//
// mode `mount`: one op = mount + unmount of n components.
// mode `update`: mount once; one op = `update()` (awaited when it returns a promise).
//
// Without `timed` it warms up, runs <ops> ops and exits (the instruction
// count harness diffs two such runs). With `timed` it prints JSON timing
// samples: after warmup, `samples` batches of `ops` ops each, a forced GC
// between batches (never inside one).
const [moduleUrl, mode, n, warmup, ops, timed] = process.argv.slice(2);
const { make } = await import(moduleUrl);
const N = Number(n);
const app = make(N);
let op;
if (mode === "mount") {
  op = () => {
    app.mount();
    app.unmount();
  };
} else {
  app.mount();
  op = () => app.update();
}
async function run(count) {
  for (let i = 0; i < count; i++) {
    const r = op();
    if (r) await r;
  }
}
await run(Number(warmup));
if (!timed) {
  await run(Number(ops));
} else {
  const samples = [];
  const SAMPLES = Number(timed);
  for (let s = 0; s < SAMPLES; s++) {
    globalThis.gc?.();
    const t0 = process.hrtime.bigint();
    await run(Number(ops));
    samples.push(Number(process.hrtime.bigint() - t0) / Number(ops));
  }
  process.stdout.write(JSON.stringify(samples));
}
