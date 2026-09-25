// Graph loading: crawl one environment's module graph from its entries,
// summarize every application module with the compiler, attach solid-tsc
// typed summaries (validated by content hash), and load the summaries that
// strict-compatible libraries ship. Anything that cannot be summarized is
// recorded with a status the classifier turns into `unknown`.
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

export const LIBRARY_SCHEMA = "solid-library-summary";
export const BEHAVIOR_SCHEMA = "solid-behavior-summary";
export const MODULE_SCHEMA = "solid-module-summary";
export const INDEX_SCHEMA = "solid-summary-index";
export const SUMMARY_VERSION = 1;

/** Runtime packages: always hot, never crawled or transformed. */
export const RUNTIME_PACKAGES = [
  "solid-js",
  "@solidjs/web",
  "@solidjs/signals",
  "@solidjs/linker",
  "@solidjs/h",
  "@solidjs/html",
  "@solidjs/universal"
];

let compiler;
function loadCompiler() {
  compiler ??= require("@solidjs/compiler");
  return compiler;
}

export function sourceHash(text) {
  return "sha256:" + crypto.createHash("sha256").update(text).digest("hex");
}

export function toPosix(file) {
  return file.split(path.sep).join("/");
}

function isRuntimeSpecifier(source) {
  return RUNTIME_PACKAGES.some(name => source === name || source.startsWith(name + "/"));
}

function isRuntimePath(id) {
  const normalized = toPosix(id);
  return RUNTIME_PACKAGES.some(
    name =>
      normalized.includes(`/node_modules/${name}/`) ||
      normalized.includes(`/packages/${name.replace("@solidjs/", "")}/dist/`) ||
      normalized.includes(`/packages/${name.replace("@solidjs/", "")}/src/`)
  );
}

/** Every import source a behavioral summary mentions (static, re-export, dynamic literal). */
export function moduleSources(behavior) {
  const sources = new Set();
  for (const declaration of behavior.imports) sources.add(declaration.source);
  for (const entry of behavior.exports) if (entry.source) sources.add(entry.source);
  for (const entry of behavior.dynamicImports) if (entry.source) sources.add(entry.source);
  for (const block of behavior.blocks) {
    for (const entry of block.body?.dynamicImports ?? [])
      if (entry.source) sources.add(entry.source);
  }
  return [...sources];
}

/** Load a solid-tsc summary index (`--solidSummaries <dir>`). */
export function loadTypedSummaries(dir) {
  if (!dir) return null;
  const indexFile = path.join(dir, "index.json");
  if (!fs.existsSync(indexFile)) return { dir, error: "missing index.json", modules: new Map() };
  const index = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  if (index.schema !== INDEX_SCHEMA || index.version !== SUMMARY_VERSION) {
    return {
      dir,
      error: `incompatible index (${index.schema}@${index.version})`,
      modules: new Map()
    };
  }
  const modules = new Map();
  for (const entry of index.modules) {
    modules.set(entry.module, { entry, file: path.join(dir, entry.file) });
  }
  return { dir, root: index.root, modules };
}

function readTypedSummary(typed, rel) {
  const record = typed?.modules.get(rel);
  if (!record) return null;
  record.summary ??= JSON.parse(fs.readFileSync(record.file, "utf8"));
  return record.summary;
}

/** Find the package root (nearest package.json) above a file inside node_modules. */
function packageRootOf(file) {
  let dir = path.dirname(file);
  while (dir !== path.dirname(dir)) {
    const manifest = path.join(dir, "package.json");
    if (fs.existsSync(manifest))
      return { dir, manifest: JSON.parse(fs.readFileSync(manifest, "utf8")) };
    dir = path.dirname(dir);
  }
  return null;
}

const librarySummaryCache = new Map();
/** A library's shipped summary (package.json `"solidSummary"`), or null. */
export function loadLibrarySummary(pkg) {
  const field = pkg.manifest.solidSummary;
  const file = field ? path.join(pkg.dir, field) : null;
  // Keyed by modification time too, so a watch rebuild sees a regenerated summary.
  const cacheKey = `${pkg.dir}\0${file && fs.existsSync(file) ? fs.statSync(file).mtimeMs : "none"}`;
  if (librarySummaryCache.has(cacheKey)) return librarySummaryCache.get(cacheKey);
  let summary = null;
  if (field) {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      summary =
        parsed.schema === LIBRARY_SCHEMA && parsed.version === SUMMARY_VERSION
          ? parsed
          : { incompatible: `${parsed.schema}@${parsed.version}` };
    } else {
      summary = { incompatible: "summary file missing" };
    }
  }
  librarySummaryCache.set(cacheKey, summary);
  return summary;
}

/**
 * Summarize a package's JavaScript files and write `solid-summary.json`
 * (schema `solid-library-summary`): what a strict-compatible library ships
 * next to its declarations. Hashes pin each summary to the exact file.
 */
export function summarizePackage(dir, { files, write = true } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  const list = (files ?? walkJs(dir))
    .map(file => toPosix(path.relative(dir, path.resolve(dir, file))))
    .sort();
  const modules = {};
  for (const rel of list) {
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    modules[rel] = {
      sourceHash: sourceHash(text),
      behavior: loadCompiler().summarizeModule(text, { filename: path.basename(rel) })
    };
  }
  const summary = {
    schema: LIBRARY_SCHEMA,
    version: SUMMARY_VERSION,
    name: manifest.name,
    modules
  };
  if (write)
    fs.writeFileSync(path.join(dir, "solid-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  return summary;
}

function walkJs(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJs(full, base, out);
    else if (/\.(m?js|jsx)$/.test(entry.name)) out.push(path.relative(base, full));
  }
  return out;
}

/**
 * Crawl one environment's graph.
 *
 * - `entries`: absolute ids of the environment's entry modules;
 * - `resolve(source, importer)`: `{ id, external? } | null` (the bundler's
 *   resolver);
 * - `load(id)`: the module text as the bundler will see it;
 * - `root`: project root (module paths in the manifest are relative to it);
 * - `typed`: `loadTypedSummaries(dir)` result or null;
 * - `typedRoot`: the directory solid-tsc module paths are relative to.
 *
 * Returns `{ modules: Map<id, ModuleRecord>, entries, timings }`.
 */
export async function loadGraph({ entries, resolve, load, root, typed = null, typedRoot = root }) {
  const modules = new Map();
  const queue = [...entries];
  const timings = { summarize: 0, resolve: 0, load: 0 };
  const now = () => performance.now();
  while (queue.length) {
    const id = queue.shift();
    if (modules.has(id)) continue;
    const record = {
      id,
      rel: toPosix(path.relative(root, id)),
      kind: "app",
      status: "ok",
      behavior: null,
      types: null,
      typedStatus: "n/a",
      text: null,
      resolved: new Map()
    };
    modules.set(id, record);
    if (isRuntimePath(id)) {
      record.kind = "runtime";
      continue;
    }
    // A module owned by another package (node_modules, or a linked
    // workspace package) is a library: it must ship its own summary.
    const owner = packageRootOf(id);
    if (owner && path.resolve(owner.dir) !== path.resolve(root)) {
      record.kind = "library";
      const pkg = owner;
      const summary = pkg && loadLibrarySummary(pkg);
      const libRel = pkg ? toPosix(path.relative(pkg.dir, id)) : null;
      record.package = pkg?.manifest.name ?? null;
      if (!summary) {
        record.status = "missingSummary";
        continue;
      }
      if (summary.incompatible) {
        record.status = "incompatibleSummary";
        record.detail = summary.incompatible;
        continue;
      }
      const entry = summary.modules[libRel];
      let start = now();
      const text = await load(id);
      timings.load += now() - start;
      if (!entry) {
        record.status = "missingSummary";
        continue;
      }
      if (entry.sourceHash !== sourceHash(text)) {
        record.status = "staleSummary";
        continue;
      }
      if (
        entry.behavior?.schema !== BEHAVIOR_SCHEMA ||
        entry.behavior?.version !== SUMMARY_VERSION
      ) {
        record.status = "incompatibleSummary";
        continue;
      }
      record.behavior = entry.behavior;
      record.text = text;
    } else {
      let start = now();
      const text = await load(id);
      timings.load += now() - start;
      if (text == null) {
        record.status = "unloadable";
        continue;
      }
      record.text = text;
      start = now();
      try {
        record.behavior = loadCompiler().summarizeModule(text, { filename: path.basename(id) });
      } catch (error) {
        record.status = "unparsable";
        record.detail = String(error.message ?? error);
        continue;
      } finally {
        timings.summarize += now() - start;
      }
      const typedRel = toPosix(path.relative(typedRoot, id));
      if (typed) {
        const summary = readTypedSummary(typed, typedRel);
        if (!summary) record.typedStatus = "missing";
        else if (summary.schema !== MODULE_SCHEMA || summary.version !== SUMMARY_VERSION) {
          record.typedStatus = "incompatible";
        } else if (summary.sourceHash !== sourceHash(text)) record.typedStatus = "stale";
        else if (!summary.types) record.typedStatus = "missing";
        else if (summary.types.typeErrors > 0) {
          record.typedStatus = "typeErrors";
          record.types = summary.types;
        } else {
          record.typedStatus = "ok";
          record.types = summary.types;
        }
      } else {
        record.typedStatus = "missing";
      }
    }
    const start = now();
    for (const source of moduleSources(record.behavior)) {
      if (isRuntimeSpecifier(source)) {
        record.resolved.set(source, { runtime: true });
        continue;
      }
      const resolved = await resolve(source, id);
      if (!resolved || resolved.external) {
        record.resolved.set(
          source,
          resolved?.external ? { external: true, id: resolved.id } : null
        );
        continue;
      }
      record.resolved.set(source, { id: resolved.id });
      if (!modules.has(resolved.id)) queue.push(resolved.id);
    }
    timings.resolve += now() - start;
  }
  return { modules, entries, timings };
}

/**
 * A small synchronous Node-style resolver for tests and CLIs: relative
 * paths with TS/JS extension probing and `index` files, and bare specifiers
 * through `node_modules` package.json `exports["."]` / `module` / `main`.
 * Returns `{ id }`, or `null` when nothing matches.
 */
export function createNodeResolver({ conditions = ["import", "browser", "default"] } = {}) {
  const extensions = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
  const probe = base => {
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
    for (const extension of extensions)
      if (fs.existsSync(base + extension)) return base + extension;
    for (const extension of extensions) {
      const index = path.join(base, "index" + extension);
      if (fs.existsSync(index)) return index;
    }
    return null;
  };
  const pickExport = (value, subpath = ".") => {
    if (typeof value === "string") return subpath === "." ? value : null;
    if (!value || typeof value !== "object") return null;
    if (Object.keys(value).some(key => key.startsWith("."))) {
      return value[subpath] !== undefined ? pickExport(value[subpath]) : null;
    }
    for (const condition of conditions) {
      if (value[condition] !== undefined) {
        const picked = pickExport(value[condition]);
        if (picked) return picked;
      }
    }
    return null;
  };
  return (source, importer) => {
    if (source.startsWith(".") || source.startsWith("/")) {
      const found = probe(path.resolve(path.dirname(importer), source));
      return found ? { id: found } : null;
    }
    const parts = source.split("/");
    const name = source.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
    const subpath = "." + source.slice(name.length);
    let dir = path.dirname(importer);
    while (dir !== path.dirname(dir)) {
      const pkgDir = path.join(dir, "node_modules", name);
      const manifestFile = path.join(pkgDir, "package.json");
      if (fs.existsSync(manifestFile)) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
        const target =
          (manifest.exports && pickExport(manifest.exports, subpath)) ||
          (subpath === "." ? manifest.module || manifest.main || "index.js" : subpath);
        const found = probe(path.join(fs.realpathSync(pkgDir), target));
        return found ? { id: found } : null;
      }
      dir = path.dirname(dir);
    }
    return null;
  };
}
