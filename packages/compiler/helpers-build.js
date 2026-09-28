"use strict";
// Generator blocks v2 — cross-module helper summaries
// (documentation/plans/blocks-v2-performance.md, section 11).
//
// The compiler lowers a helper generator (`function* useThing() { … }`) to a
// plain function when its body allows it (`src/blocks_v2_lower/helpers.rs`).
// An exported helper keeps its generator and gains a lowered twin
// (`export function useThing$lowered(…)`), listed in the module's
// `helperSummary` (`transform()` output): export → `{ lowered, hosts }`.
// A module importing that helper lowers its call sites to the twin when the
// compile receives the summary (`helperSummaries`, keyed by the imported
// module's path or by the import source as written) — the compiler itself
// only ever sees one module.
//
// This file supplies the summaries:
//
// - `summarizeHelperGraph({ entries, resolve, readFile, summaries, compile })`
//   walks the application graph from `entries` depth-first, compiling each
//   module (with the summaries of what it imports, so re-exported twins
//   chain) and recording its `helperSummary` under its path. Any bundler can
//   call it before transforming modules.
// - `solidHelperSummaries({ summaries, entries, compile })` is the Vite /
//   Rollup plugin running it in `buildStart` through the bundler's resolver.
//   Pass the same `summaries` object to the Solid plugin's compiler options
//   (`solid({ solid: { helperSummaries: summaries } })`): it is filled before
//   the first module is transformed.
//
// A summary must describe the exporting module's actual compile: `compile`
// is merged into the options the walk compiles with (pass the Solid plugin's
// `hostFusion`, for instance — with `hostFusion: false` no twin exists and
// the summary is empty). Like the capability linker, the plugin applies to
// builds and test runs; the dev server's graph changes under HMR, so dev
// keeps each helper's generator at cross-module call sites.

const fs = require("fs");
const path = require("path");
const { transform, summarizeCapabilities } = require("./index.js");

const SOURCE_RE = /\.[cm]?[jt]sx?$/;

function stripQuery(id) {
  const q = id.indexOf("?");
  return q === -1 ? id : id.slice(0, q);
}

/**
 * Summarize the helper twins of every application module reachable from
 * `entries` (post-order: a module's imports first). Returns `summaries`
 * (filled in place): `{ [module path]: helperSummary }`.
 */
async function summarizeHelperGraph({
  entries,
  resolve,
  readFile = file => fs.readFileSync(file, "utf8"),
  summaries = {},
  compile = {},
  isApplication = file => !file.includes(`${path.sep}node_modules${path.sep}`)
}) {
  const state = new Map();
  const visit = async file => {
    if (state.has(file)) return;
    state.set(file, "visiting");
    let code;
    try {
      code = readFile(file);
    } catch {
      return;
    }
    let edges = [];
    try {
      const summary = summarizeCapabilities(code, { filename: file });
      edges = [...summary.imports, ...summary.reexports].filter(e => !e.typeOnly);
    } catch {
      // Not a module the compiler parses: nothing to summarize.
      return;
    }
    for (const edge of edges) {
      const resolved = await resolve(edge.source, file);
      if (!resolved) continue;
      const id = stripQuery(resolved);
      if (SOURCE_RE.test(id) && isApplication(id)) await visit(id);
    }
    // A cycle back to a module being visited reads its summary as absent:
    // its call sites keep the generator (exact, just not lowered).
    try {
      const out = transform(code, {
        ...compile,
        filename: file,
        generate: "dom",
        helperSummaries: summaries
      });
      if (out.helperSummary) summaries[file] = out.helperSummary;
    } catch {
      // A module that fails to compile fails the real build too.
    }
  };
  for (const entry of entries) await visit(entry);
  return summaries;
}

function htmlScripts(file, root) {
  const html = fs.readFileSync(file, "utf8");
  const out = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/g)) {
    const src = match[1];
    if (/^(https?:)?\/\//.test(src)) continue;
    out.push(src.startsWith("/") ? path.join(root, src) : path.resolve(path.dirname(file), src));
  }
  return out;
}

/** The Vite / Rollup plugin (see the header). */
function solidHelperSummaries(options = {}) {
  const summaries = options.summaries ?? {};
  let config;
  return {
    name: "solid:helper-summaries",
    enforce: "pre",
    apply(_config, env) {
      return env.command === "build" || !!process.env.VITEST;
    },
    configResolved(resolved) {
      config = resolved;
    },
    async buildStart(input) {
      const root = config?.root ?? process.cwd();
      const named =
        typeof input?.input === "string"
          ? [input.input]
          : Array.isArray(input?.input)
            ? input.input
            : Object.values(input?.input ?? {});
      const entries = [];
      for (const entry of named.length ? named : (options.entries ?? [])) {
        const file = path.resolve(root, entry);
        if (/\.html?$/.test(file) && fs.existsSync(file)) entries.push(...htmlScripts(file, root));
        else if (fs.existsSync(file)) entries.push(file);
      }
      for (const key of Object.keys(summaries)) delete summaries[key];
      await summarizeHelperGraph({
        entries,
        summaries,
        compile: options.compile,
        resolve: async (source, importer) => {
          const resolved = await this.resolve(source, importer, { skipSelf: true });
          return resolved && !resolved.external ? resolved.id : null;
        }
      });
    }
  };
}

module.exports = { summarizeHelperGraph, solidHelperSummaries };
