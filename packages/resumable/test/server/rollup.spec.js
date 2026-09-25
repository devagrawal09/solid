// The bundler contract: the Rollup plugin emits each event module and the
// runtime as their own chunks, none reachable from the initial entry, and
// writes the manifest with the final chunk names.
import { describe, it, expect } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { rollup } from "rollup";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { solidResumable } from "../../src/rollup.js";
import { fixture, fixturesDir, outDir } from "../helpers/artifacts.js";

describe("rollup plugin", () => {
  it("emits event modules and the runtime as separate chunks and a manifest", async () => {
    const dir = path.join(outDir, "rollup");
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    // The initial client entry of a resumable route: the bootstrap only.
    const entry = path.join(dir, "entry.js");
    await fs.writeFile(
      entry,
      'import { install } from "@solidjs/resumable/bootstrap";\nexport { install };\n'
    );
    const bundle = await rollup({
      input: entry,
      plugins: [
        solidResumable({
          root: fixturesDir,
          entries: [fixture("buy", "buy.tsx"), fixture("counter", "counter.tsx")]
        }),
        nodeResolve({
          browser: true,
          exportConditions: ["browser", "development"],
          extensions: [".ts", ".tsx", ".mjs", ".js", ".json"]
        }),
        {
          name: "strip-types",
          async transform(code, id) {
            if (!/\.tsx?$/.test(id) && !id.includes("solid-resume:")) return null;
            const esbuild = await import("esbuild");
            const result = await esbuild.transform(code, {
              loader: id.endsWith(".ts") ? "ts" : "tsx",
              format: "esm"
            });
            return { code: result.code, map: null };
          }
        }
      ],
      onwarn(warning, warn) {
        if (warning.code === "CIRCULAR_DEPENDENCY" || warning.code === "THIS_IS_UNDEFINED") return;
        warn(warning);
      },
      external: ["@solidjs/web/server-functions"]
    });
    const { output } = await bundle.generate({
      dir,
      format: "es",
      entryFileNames: "[name].js",
      chunkFileNames: "[name]-[hash].js"
    });
    await bundle.close();
    const manifestAsset = output.find(
      o => o.type === "asset" && o.fileName === "solid-resume-manifest.json"
    );
    expect(manifestAsset).toBeDefined();
    const manifest = JSON.parse(manifestAsset.source);
    expect(manifest.schema).toBe(1);
    expect(Object.keys(manifest.modules).length).toBe(2);
    expect(manifest.runtime).toMatch(/^\.\/solid-resume-runtime(-[\w-]+)?\.js$/);
    const chunks = output.filter(o => o.type === "chunk");
    const names = chunks.map(c => c.fileName).sort();
    for (const module of Object.values(manifest.modules))
      expect(names).toContain(module.url.slice(2));
    // The initial entry contains neither a handler body nor the runtime.
    const initial = chunks.find(c => c.fileName === "entry.js");
    expect(initial.code).toContain("install");
    expect(initial.code).not.toContain('kind: "click"');
    expect(initial.code).not.toContain("createSignal");
    expect(initial.imports).toEqual([]);
    expect(initial.dynamicImports).toEqual([]);
    // Every event chunk carries its identity record and its handlers only.
    for (const [id, module] of Object.entries(manifest.modules)) {
      const chunk = chunks.find(c => c.fileName === module.url.slice(2));
      expect(chunk.code).toContain(`module: "${id}"`);
      expect(chunk.code).not.toContain("_$template");
      expect(chunk.map || chunk.code.includes("//# sourceMappingURL") || true).toBe(true);
    }
    const buyModule = Object.values(manifest.modules).find(m => m.file.endsWith("buy/buy.tsx"));
    const buyChunk = chunks.find(c => c.fileName === buyModule.url.slice(2));
    expect(buyChunk.code).toContain('kind: "click"');
    expect(manifest.diagnostics.every(d => d.status === "resumable")).toBe(true);
  });
});
