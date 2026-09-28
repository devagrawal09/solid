#!/usr/bin/env node
// Server render time of the generator-blocks-v2 apps (documentation/plans/
// blocks-v2-performance.md, section 11): the whole page rendered with
// renderToStream (hydratable, awaited in full) from the SSR compile of
//   hn-blocks     scripts/ssr-redesign/apps/hn-blocks (the HN story page,
//                 1,406 comments);
//   todos-blocks  examples/todos-blocks (100 todos) through apps/todos, the
//                 mock API's latency removed.
// App `.ts` modules holding a generator body are compiled too (lib.mjs; e.g.
// todos-blocks' filter.ts, as its Vite config compiles it). Also reports what is left of the block
// machinery in each app module's server output: `_$perform(` calls,
// generator block bodies (`function*` handed to the block wrapper) and
// whether the module imports `$` (the driver).
//
//   node scripts/ssr-redesign/blocks-ssr-bench.mjs --tag after
//        bundle both apps with the current compiler (SOLID_COMPILER_NATIVE=
//        <file.node> selects another binary, e.g. a saved baseline) under
//        node_modules/.cache/ssr-redesign/blocks-bench-<tag>/
//   node scripts/ssr-redesign/blocks-ssr-bench.mjs --compare before,after
//        [--iters 20] [--rounds 10] [--out file.json]
//        render the tagged bundles in one process, alternating tag and app
//        every round (machine noise hits every variant alike); the reported
//        time is the median of all samples. The HTML of every tag must be
//        identical (the gate: the lowering must not change what renders).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HERE, loadServer, median, ROOT } from "./lib.mjs";

const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? args[args.indexOf(name) + 1] : d);
const ITERS = Number(opt("--iters", 20));
const ROUNDS = Number(opt("--rounds", 10));
const cache = join(ROOT, "node_modules/.cache/ssr-redesign");

const TODOS_SEED = Array.from({ length: 100 }, (_, i) => ({
  id: String(100000 + i),
  title: `todo item number ${i}`,
  completed: i % 3 === 0
}));

const APPS = {
  "hn-blocks": {
    entry: join(HERE, "apps/hn-blocks/server.tsx"),
    modules: ["scripts/ssr-redesign/apps/hn-blocks/story.tsx"],
    render: s => s.render()
  },
  "todos-blocks": {
    entry: join(HERE, "apps/todos/server.tsx"),
    modules: ["examples/todos-blocks/src/app.tsx", "examples/todos-blocks/src/filter.ts"],
    render: s => s.render(TODOS_SEED),
    // The mock API's 400 ms latency would dominate: resolve the list at once.
    rewrites: {
      "examples/todos-blocks/src/api.ts": [["return delay(getTodos(), 400);", "return Promise.resolve(getTodos());"]]
    }
  }
};

function residue(transform, file) {
  const src = readFileSync(join(ROOT, file), "utf8");
  const code = transform(src, { filename: join(ROOT, file), generate: "ssr", hydratable: true }).code;
  const count = re => (code.match(re) || []).length;
  return {
    perform: count(/_\$perform\(/g),
    generatorBlocks: count(/_\$\$\((?:_\$blockScope\()?function\s*\*/g),
    driver: /\$ as _\$\$/.test(code)
  };
}

const dirOf = tag => join(cache, `blocks-bench-${tag}`);

if (args.includes("--tag")) {
  const tag = opt("--tag");
  const { transform } = await import(pathToFileURL(join(ROOT, "packages/compiler/index.js")).href);
  mkdirSync(dirOf(tag), { recursive: true });
  const meta = {};
  for (const [name, app] of Object.entries(APPS)) {
    await loadServer(app.entry, join(dirOf(tag), `${name}.mjs`), { rewrites: app.rewrites });
    meta[name] = Object.fromEntries(app.modules.map(m => [m, residue(transform, m)]));
    const r = Object.values(meta[name]);
    console.log(
      `${tag} ${name}: perform ${r.reduce((n, x) => n + x.perform, 0)}, generator blocks ${r.reduce((n, x) => n + x.generatorBlocks, 0)}, ` +
        `\`$\` imported: ${r.some(x => x.driver)}`
    );
  }
  writeFileSync(join(dirOf(tag), "residue.json"), JSON.stringify(meta, null, 2) + "\n");
} else {
  const tags = opt("--compare", "after").split(",");
  const servers = {};
  const html = {};
  for (const tag of tags)
    for (const [name, app] of Object.entries(APPS)) {
      const s = (servers[`${tag}/${name}`] = await import(pathToFileURL(join(dirOf(tag), `${name}.mjs`)).href));
      const out = await app.render(s);
      if (/Something went wrong|\[ssr\]/.test(out)) throw new Error(`${tag}/${name}: rendered its error fallback`);
      if (html[name] === undefined) html[name] = out;
      else if (html[name] !== out) throw new Error(`${tag}/${name}: HTML differs from ${tags[0]}'s`);
    }
  console.log(`gate: every tag renders identical HTML (${Object.entries(html).map(([n, h]) => `${n} ${h.length} B`).join(", ")})`);
  const samples = Object.fromEntries(Object.keys(servers).map(k => [k, []]));
  for (let round = 0; round < ROUNDS; round++) {
    const order = round % 2 ? [...tags].reverse() : tags;
    for (const [name, app] of Object.entries(APPS))
      for (const tag of order) {
        const s = servers[`${tag}/${name}`];
        for (let i = 0; i < 3; i++) await app.render(s);
        for (let i = 0; i < ITERS; i++) {
          const t = performance.now();
          await app.render(s);
          samples[`${tag}/${name}`].push(performance.now() - t);
        }
      }
  }
  const results = {};
  for (const name of Object.keys(APPS)) {
    const row = tags.map(tag => median(samples[`${tag}/${name}`]));
    results[name] = Object.fromEntries(tags.map((tag, i) => [tag, { ms: row[i], residue: JSON.parse(readFileSync(join(dirOf(tag), "residue.json"), "utf8"))[name] }]));
    console.log(
      `${name.padEnd(13)} ` +
        tags.map((tag, i) => `${tag} ${row[i].toFixed(3)} ms${i ? ` (${(((row[i] - row[0]) / row[0]) * 100).toFixed(1)}%)` : ""}`).join(" | ")
    );
  }
  if (args.includes("--out"))
    writeFileSync(opt("--out"), JSON.stringify({ iters: ITERS, rounds: ROUNDS, node: process.version, results }, null, 2) + "\n");
}
