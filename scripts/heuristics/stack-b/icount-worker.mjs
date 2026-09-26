// Copy of ../icount-worker.mjs (stack-B keeps its own files).
// Run under valgrind by icount.mjs:
//   node icount-worker.mjs <module> <op> <n> <warmup> <ops>
// `mount` = make + mount + unmount; any other op runs on one mounted graph.
const [modulePath, opName, n, warmup, ops] = process.argv.slice(2);
const { make } = await import(modulePath);
const N = Number(n);
let op;
if (opName === "mount") {
  op = () => {
    const app = make(N);
    app.mount();
    app.unmount();
  };
} else {
  const app = make(N);
  app.mount();
  op = app.ops[opName];
}
for (let i = 0; i < Number(warmup); i++) op();
for (let i = 0; i < Number(ops); i++) op();
