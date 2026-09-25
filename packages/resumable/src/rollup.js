// @ts-check
/**
 * Rollup / Vite (build) integration of the resumable-events prototype
 * (experimental, private): the bundler contract in its smallest form.
 *
 * For each entry component module the plugin compiles the module for SSR
 * with the link facts of its `"use server"` imports (`linkFacts`), keeps the
 * event module the compiler cut out as a virtual module, and emits it as its
 * own chunk (`emitFile({ type: "chunk" })`) together with the runtime. The
 * bundler's own graph then decides sharing and hashing; nothing from an
 * event module is placed in the initial entry, because nothing imports it —
 * the manifest names the chunk, the bootstrap loads it by URL.
 *
 * `generateBundle` writes `solid-resume-manifest.json` with the final chunk
 * file names, the scopes, the handlers and the diagnostics.
 */
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { linkFacts } from "./build.js";

const require = createRequire(import.meta.url);
const compiler = require("@solidjs/compiler");

const VIRTUAL = "\0solid-resume:";
const RUNTIME = fileURLToPath(new URL("./runtime.js", import.meta.url));

export function solidResumable(options) {
  const root = path.resolve(options.root);
  const manifestFileName = options.manifestFileName || "solid-resume-manifest.json";
  /** @type {Map<string, { code: string; map: object | null }>} virtual id → event module */
  const virtual = new Map();
  const manifest = { schema: 1, build: "", runtime: "", modules: {}, scopes: [], handlers: [] };
  const diagnostics = [];
  /** @type {Map<string, string>} module id → emitted reference id */
  const refs = new Map();
  let runtimeRef = "";

  return {
    name: "solid-resumable",
    async buildStart() {
      virtual.clear();
      refs.clear();
      manifest.modules = {};
      manifest.scopes = [];
      manifest.handlers = [];
      diagnostics.length = 0;
      const hash = createHash("sha256");
      for (const entry of options.entries) {
        const file = path.resolve(root, entry);
        const source = await fs.readFile(file, "utf8");
        const relative = path.relative(root, file).split(path.sep).join("/");
        const { facts } = await linkFacts(file, source, { root, trusted: options.trusted });
        const result = compiler.transform(source, {
          filename: relative,
          generate: "ssr",
          hydratable: true,
          sourceMap: true,
          resumableEvents: {
            root,
            ...(options.serverModule ? { serverModule: options.serverModule } : {}),
            imports: facts,
            require: !!options.require
          }
        });
        const resumable = result.resumable;
        if (!resumable) continue;
        diagnostics.push(...resumable.diagnostics.map(d => ({ file: relative, ...d })));
        manifest.scopes.push(...resumable.scopes);
        manifest.handlers.push(...resumable.handlers);
        hash.update(resumable.module);
        for (const handler of resumable.handlers) hash.update(handler.id + ":" + handler.source);
        if (!resumable.eventModule) continue;
        // The virtual module lives beside its source so relative imports
        // (the action module) resolve exactly as authored.
        const id =
          VIRTUAL + path.join(path.dirname(file), resumable.eventModule.name.split("/").pop());
        virtual.set(id, { code: resumable.eventModule.code, map: resumable.eventModule.map });
        refs.set(resumable.module, this.emitFile({ type: "chunk", id, name: resumable.module }));
        manifest.modules[resumable.module] = { url: "", file: relative };
      }
      manifest.build = hash.digest("hex").slice(0, 16);
      if (refs.size)
        runtimeRef = this.emitFile({ type: "chunk", id: RUNTIME, name: "solid-resume-runtime" });
    },
    resolveId(source, importer) {
      if (source.startsWith(VIRTUAL)) return source;
      if (importer && importer.startsWith(VIRTUAL) && source.startsWith(".")) {
        // relative imports of an event module resolve from its source's directory
        return this.resolve(source, importer.slice(VIRTUAL.length), { skipSelf: true });
      }
      return null;
    },
    load(id) {
      const module = virtual.get(id);
      if (!module) return null;
      return { code: module.code, map: module.map };
    },
    generateBundle() {
      for (const [id, ref] of refs) manifest.modules[id].url = "./" + this.getFileName(ref);
      if (runtimeRef) manifest.runtime = "./" + this.getFileName(runtimeRef);
      this.emitFile({
        type: "asset",
        fileName: manifestFileName,
        source: JSON.stringify({ ...manifest, diagnostics }, null, 2)
      });
    }
  };
}
