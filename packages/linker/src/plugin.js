// Rollup / Vite (build) plugin: whole-graph analysis at `buildStart`, then
// cold event-domain extraction during the build.
//
//   import { solidColdEvents } from "@solidjs/linker/rollup";
//   plugins: [solidColdEvents({ typedSummaries: ".solid/summaries" }), solid(), …]
//
// It must run before the Solid JSX/generator transform (it rewrites authored
// source); Vite: `enforce: "pre"`, placed before `solid()`. Dev serve/HMR is
// untouched (`apply: "build"`): extraction is a production-build
// specialization, and a watch rebuild re-runs the analysis from scratch.
import fs from "node:fs/promises";
import path from "node:path";
import { analyze } from "./analyze.js";
import { DOMAIN_PREFIX, planExtraction } from "./extract.js";
import { loadGraph, loadTypedSummaries } from "./load.js";
import { buildManifest } from "./manifest.js";

export function solidColdEvents(options = {}) {
  const {
    root = process.cwd(),
    typedSummaries = null,
    typedRoot = root,
    strict = true,
    prefetch = "idle",
    maxDomainBytes,
    environment = "client",
    extract = environment === "client",
    manifest = "solid-link-manifest.json",
    runtimeModule = "@solidjs/linker/runtime",
    onAnalysis
  } = options;
  let analysis = null;
  let plan = null;
  let timings = {};
  const cleanId = id => id.replace(/[?#].*$/, "");

  return {
    name: "solid:cold-events",
    enforce: "pre",
    apply: "build",

    async buildStart(inputOptions) {
      const started = performance.now();
      const inputs = Array.isArray(inputOptions.input)
        ? inputOptions.input
        : typeof inputOptions.input === "object"
          ? Object.values(inputOptions.input)
          : [inputOptions.input];
      const entries = [];
      for (const input of inputs) {
        const resolved = await this.resolve(input, undefined, { skipSelf: true });
        if (!resolved) continue;
        const id = cleanId(resolved.id);
        if (!id.endsWith(".html")) {
          entries.push(id);
          continue;
        }
        // Vite HTML entry: its module scripts are the graph's entries.
        const html = await fs.readFile(id, "utf8");
        for (const match of html.matchAll(
          /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/g
        )) {
          const src = match[1].startsWith("/")
            ? path.join(root, match[1])
            : path.resolve(path.dirname(id), match[1]);
          const script = await this.resolve(src, id, { skipSelf: true });
          if (script) entries.push(cleanId(script.id));
        }
      }
      const typed = typedSummaries ? loadTypedSummaries(path.resolve(root, typedSummaries)) : null;
      const graph = await loadGraph({
        entries,
        root,
        typed,
        typedRoot,
        resolve: async (source, importer) => {
          const resolved = await this.resolve(source, importer, { skipSelf: true });
          if (!resolved) return null;
          return { id: cleanId(resolved.id), external: !!resolved.external };
        },
        load: async id => {
          try {
            return await fs.readFile(cleanId(id), "utf8");
          } catch {
            return null;
          }
        }
      });
      const loaded = performance.now();
      analysis = analyze(graph, { environment, strict, maxDomainBytes, root });
      const analyzed = performance.now();
      // Domains are plain dynamic-import targets: the bundler gives each one
      // chunk (named from its path-like id) holding what only it reaches,
      // and keeps modules its importers already loaded where they are.
      plan = extract
        ? planExtraction(analysis, {
            prefetch,
            runtimeModule,
            domainDir: path.join(root, ".solid-cold")
          })
        : null;
      if (plan) plan.prefetch = prefetch;
      timings = {
        crawlAndSummarize: loaded - started,
        summarize: graph.timings.summarize,
        analyze: analyzed - loaded,
        plan: performance.now() - analyzed
      };
      onAnalysis?.(analysis, plan);
    },

    resolveId(source, importer) {
      if (!plan) return null;
      if (source.startsWith(DOMAIN_PREFIX))
        return plan.domainIds.get(source.slice(DOMAIN_PREFIX.length)) ?? null;
      if (plan.virtual.has(source)) return source;
      // Generated modules import each other by relative specifier.
      if (importer && source.startsWith(".") && !importer.startsWith("\0")) {
        const absolute = path.resolve(path.dirname(cleanId(importer)), source);
        if (plan.virtual.has(absolute)) return absolute;
      }
      return null;
    },

    load(id) {
      const generated = plan?.virtual.get(id);
      return generated ? { code: generated.code, map: generated.map } : null;
    },

    transform(code, id) {
      const hotPlan = plan?.hot.get(cleanId(id));
      if (!hotPlan) return null;
      const result = hotPlan.transform(code);
      if (!result) this.warn(`cold-events: ${id} changed after analysis; its blocks stay hot`);
      return result;
    },

    generateBundle(_outputOptions, bundle) {
      if (!analysis || !manifest) return;
      const chunks = new Map();
      for (const file of Object.values(bundle)) {
        if (file.type !== "chunk") continue;
        for (const moduleId of Object.keys(file.modules)) {
          const domain = plan?.domainOfId.get(moduleId);
          if (domain) chunks.set(domain, file.fileName);
        }
      }
      const entries = analysis.graph.entries.map(id =>
        path.relative(root, id).split(path.sep).join("/")
      );
      const result = buildManifest(analysis, { plan, chunks, timings, entries });
      this.emitFile({
        type: "asset",
        fileName: manifest,
        source: JSON.stringify(result, null, 2) + "\n"
      });
    }
  };
}

export default solidColdEvents;
