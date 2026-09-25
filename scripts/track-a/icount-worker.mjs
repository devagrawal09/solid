// Instruction-count worker (run under valgrind/cachegrind by icount.mjs):
// `node icount-worker.mjs <module> <mode> <n> <warmup> <ops>` — warms up,
// runs <ops> operations, exits. No timing, no GC forcing.
const [modulePath, mode, n, warmup, ops] = process.argv.slice(2);
const { make } = await import(modulePath);
const N = Number(n);
let op;
if (mode === "mount") {
  op = () => {
    const app = make(N);
    app.mount();
    app.unmount();
  };
} else {
  const app = make(N);
  app.mount();
  op = () => app.update();
}
for (let i = 0; i < Number(warmup); i++) op();
for (let i = 0; i < Number(ops); i++) op();
