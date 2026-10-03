// Manual check (outside vitest, where Vite's watcher is live): a real dev
// server with the plugin rewrites the generated file on save.
//   node test/dev-watch.check.mjs
import { createServer } from "vite";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solidLink from "../src/vite.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, "tmp-dev-watch");
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
cpSync(path.join(here, "fixtures/gap"), dir, { recursive: true });
const server = await createServer({
  root: dir,
  configFile: false,
  logLevel: "silent",
  plugins: [solidLink()],
  server: { watch: process.env.POLL ? { usePolling: true, interval: 50 } : {} }
});
await server.listen(0);
// let the watcher finish its initial scan (a real save comes later)
await new Promise(r => setTimeout(r, 1000));
const out = path.join(dir, "src/solid-props.gen.d.ts");
const before = readFileSync(out, "utf8");
const parent = path.join(dir, "src/Parent.tsx");
writeFileSync(
  parent,
  readFileSync(parent, "utf8").replaceAll(
    "return yield* attempt(() => fetchUser(), () => new FetchError());",
    'return { name: "x" };'
  )
);
const start = Date.now();
while (readFileSync(out, "utf8") === before && Date.now() - start < 5000)
  await new Promise(r => setTimeout(r, 25));
const ok = /"UserCard": \{\n\s+user: \{ pending: false/.test(readFileSync(out, "utf8"));
console.log(ok ? `ok: rewritten ${Date.now() - start} ms after save` : "FAILED: not rewritten");
await server.close();
rmSync(dir, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
