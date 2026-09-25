// Real-app data point: examples/todos-blocks (TodoMVC written with `$`
// blocks) built with Vite 7 + @solidjs/vite-plugin, with and without cold
// event-domain extraction. Uses an inline config so the example's own
// vite.config.mjs is not involved.
//
//   node bench/todomvc.mjs [--runs 5] [--out bench/results/todomvc.json]
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import { check } from "@solidjs/typecheck";
import { solidColdEvents } from "../src/plugin.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../examples/todos-blocks");
const runtimeModule = path.resolve(here, "../src/runtime.js");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const runs = Number(option("runs", 5));
const outFile = path.resolve(option("out", path.join(here, "results/todomvc.json")));
const require = createRequire(path.join(root, "package.json"));
const { build } = await import(require.resolve("vite"));
const solidModule = await import(require.resolve("@solidjs/vite-plugin"));
const solid =
  typeof solidModule.default === "function" ? solidModule.default : solidModule.default.default;

const sizesOf = code => ({
  raw: Buffer.byteLength(code),
  gzip: zlib.gzipSync(code, { level: 9 }).length,
  brotli: zlib.brotliCompressSync(code, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } })
    .length
});
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];

const summaries = fs.mkdtempSync(path.join(os.tmpdir(), "todomvc-summaries-"));
let started = performance.now();
const plain = check({ project: path.join(root, "tsconfig.json") });
const plainMs = performance.now() - started;
started = performance.now();
const typed = check({
  project: path.join(root, "tsconfig.json"),
  summaries: { outDir: summaries }
});
const typedMs = performance.now() - started;

const result = {
  schema: "solid-linker-bench-todomvc",
  version: 1,
  node: process.version,
  typecheck: {
    errors:
      typed.diagnostics.filter(d => d.category === 1).length +
      plain.diagnostics.filter(d => d.category === 1).length,
    plainMs: Math.round(plainMs),
    withSummariesMs: Math.round(typedMs),
    summaryPhaseMs: Math.round(typed.summaryTime)
  },
  builds: {}
};

for (const variant of ["base", "cold"]) {
  const times = [];
  let output;
  let analysis;
  for (let i = 0; i < runs + 1; i++) {
    const t0 = performance.now();
    const built = await build({
      root,
      configFile: false,
      logLevel: "silent",
      resolve: { alias: { "@solidjs/linker/runtime": runtimeModule } },
      plugins: [
        ...(variant === "cold"
          ? [
              solidColdEvents({
                root,
                typedSummaries: summaries,
                runtimeModule,
                onAnalysis: a => (analysis = a)
              })
            ]
          : []),
        solid()
      ],
      build: {
        outDir: path.join(here, ".out", `todomvc-${variant}`),
        write: true,
        emptyOutDir: true
      }
    });
    if (i > 0) times.push(performance.now() - t0);
    output = (Array.isArray(built) ? built[0] : built).output;
  }
  const chunks = output.filter(file => file.type === "chunk");
  result.builds[variant] = {
    buildMs: { median: Math.round(median(times)), samples: times.map(Math.round) },
    chunks: chunks.map(chunk => ({
      file: chunk.fileName.replace(/-[\w-]{8}\.js$/, ".js"),
      isEntry: chunk.isEntry,
      ...sizesOf(chunk.code)
    })),
    blocks: analysis
      ? analysis.blocks.map(block => ({
          key: block.key,
          name: block.name,
          class: block.class,
          reasons: block.reasons
        }))
      : null
  };
}
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      typecheck: result.typecheck,
      base: result.builds.base.chunks,
      cold: result.builds.cold.chunks
    },
    null,
    1
  )
);
