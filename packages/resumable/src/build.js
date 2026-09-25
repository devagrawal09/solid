// @ts-check
/**
 * Build driver of the resumable-events prototype (experimental, private):
 * the whole-graph half the compiler cannot do per module.
 *
 * For every entry component module it
 *
 * 1. reads the module's import edges (`summarizeCapabilities`) and, for each
 *    relative import that is a `"use server"` module, runs the directive
 *    transform to learn the wire id of every exported server function —
 *    the link facts a handler may capture (`kind: "action"`, with the id the
 *    client stub, the server registry and the manifest all agree on);
 * 2. compiles the module for SSR with `resumableEvents` (server code with
 *    coordinates, the event module, the per-module manifest);
 * 3. writes the server output, the client stubs of the action modules and
 *    the event modules, bundles the event modules and the runtime with
 *    esbuild into deterministic named chunks (`<module id>.js`,
 *    `runtime.js`, shared `chunk-<hash>.js`), with source maps;
 * 4. assembles the whole manifest: schema, a build id (hash of every module
 *    id and handler source hash), module URLs, scopes and handlers, and the
 *    diagnostics that explain every handler's verdict.
 *
 * The initial entry of a resumable route is the inline bootstrap only: no
 * event module, no runtime, no component code.
 */
import { createRequire } from "node:module";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const compiler = require("@solidjs/compiler");

export const SCHEMA = 1;

const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js", ".mjs"];

/** Resolve a relative import to a file under `from`'s directory. */
async function resolveImport(from, source) {
  const base = path.resolve(path.dirname(from), source);
  const candidates = [
    base,
    ...EXTENSIONS.map(ext => base + ext),
    ...EXTENSIONS.map(ext => path.join(base, "index" + ext))
  ];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** The `"use server"` module directive, syntactically (the transform decides). */
function looksLikeServerModule(source) {
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use server["']\s*;?/.test(source);
}

/**
 * Link facts for the imports of `file`: server-function ids of every
 * `"use server"` module it imports, plus the client and server code of those
 * modules. Trusted plain imports come from `options.trusted`.
 */
export async function linkFacts(file, source, options) {
  const root = options.root;
  const relative = path.relative(root, file).split(path.sep).join("/");
  const summary = compiler.summarizeCapabilities(source, { filename: relative });
  const facts = [];
  const actionModules = new Map();
  for (const edge of summary.imports) {
    if (edge.typeOnly || !edge.source.startsWith(".")) continue;
    const target = await resolveImport(file, edge.source);
    if (!target) continue;
    const targetSource = await fs.readFile(target, "utf8");
    if (!looksLikeServerModule(targetSource)) continue;
    const targetRelative = path.relative(root, target).split(path.sep).join("/");
    const client = compiler.transformDirectives(targetSource, {
      filename: targetRelative,
      root,
      mode: "client"
    });
    const server = compiler.transformDirectives(targetSource, {
      filename: targetRelative,
      root,
      mode: "server"
    });
    if (!client.valid || !server.valid) continue;
    for (const fn of client.functions) {
      for (const exported of fn.exports) {
        facts.push({ source: edge.source, imported: exported, kind: "action", id: fn.id });
      }
    }
    actionModules.set(edge.source, {
      file: target,
      relative: targetRelative,
      client: client.code,
      server: server.code,
      functions: client.functions
    });
  }
  for (const trusted of options.trusted || []) facts.push({ ...trusted, kind: "trusted" });
  return { facts, actionModules, imports: summary.imports };
}

/** Strip TypeScript from compiler output (esbuild transform, no bundling). */
async function stripTypes(code, loader, sourcefile) {
  const esbuild = await import("esbuild");
  const result = await esbuild.transform(code, {
    loader,
    sourcefile,
    format: "esm",
    target: "es2022"
  });
  return result.code;
}

/**
 * Build the resumable route artifacts for `entries` (absolute file paths of
 * component modules) into `outDir`.
 */
export async function buildResumable(options) {
  const root = path.resolve(options.root);
  const outDir = path.resolve(options.outDir);
  const serverModule = options.serverModule || "@solidjs/resumable/server";
  const dev = !!options.dev;
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(path.join(outDir, "server"), { recursive: true });
  await fs.mkdir(path.join(outDir, "client-src"), { recursive: true });

  const manifest = {
    schema: SCHEMA,
    build: "",
    runtime: "",
    modules: {},
    scopes: [],
    handlers: []
  };
  const diagnostics = [];
  const eventEntries = {};
  const written = [];
  const buildHash = createHash("sha256");
  const serverFiles = {};

  for (const entry of options.entries) {
    const file = path.resolve(entry);
    const source = await fs.readFile(file, "utf8");
    const relative = path.relative(root, file).split(path.sep).join("/");
    const { facts, actionModules } = await linkFacts(file, source, {
      root,
      trusted: options.trusted
    });
    const ssr = compiler.transform(source, {
      filename: relative,
      generate: "ssr",
      hydratable: true,
      sourceMap: true,
      resumableEvents: { root, serverModule, imports: facts, require: !!options.require },
      ...(options.compile || {})
    });
    const serverName = relative.replace(/\.[^.]+$/, "") + ".js";
    const serverPath = path.join(outDir, "server", serverName);
    await fs.mkdir(path.dirname(serverPath), { recursive: true });
    await fs.writeFile(serverPath, await stripTypes(ssr.code, loaderFor(relative), relative));
    written.push(serverPath);
    serverFiles[relative] = serverPath;
    for (const [, action] of actionModules) {
      const name = action.relative.replace(/\.[^.]+$/, "") + ".js";
      const serverActionPath = path.join(outDir, "server", name);
      await fs.mkdir(path.dirname(serverActionPath), { recursive: true });
      await fs.writeFile(
        serverActionPath,
        await stripTypes(action.server, loaderFor(action.relative), action.relative)
      );
      const clientActionPath = path.join(outDir, "client-src", name);
      await fs.mkdir(path.dirname(clientActionPath), { recursive: true });
      await fs.writeFile(
        clientActionPath,
        await stripTypes(action.client, loaderFor(action.relative), action.relative)
      );
      written.push(serverActionPath, clientActionPath);
    }
    const resumable = ssr.resumable;
    if (!resumable) continue;
    diagnostics.push(...resumable.diagnostics.map(d => ({ file: relative, ...d })));
    manifest.scopes.push(...resumable.scopes);
    manifest.handlers.push(...resumable.handlers);
    buildHash.update(resumable.module);
    for (const handler of resumable.handlers) buildHash.update(handler.id + ":" + handler.source);
    if (resumable.eventModule) {
      const eventPath = path.join(outDir, "client-src", resumable.eventModule.name);
      await fs.mkdir(path.dirname(eventPath), { recursive: true });
      await fs.writeFile(eventPath, resumable.eventModule.code);
      if (resumable.eventModule.map) {
        await fs.writeFile(eventPath + ".map", JSON.stringify(resumable.eventModule.map));
      }
      written.push(eventPath);
      eventEntries[resumable.module] = eventPath;
      manifest.modules[resumable.module] = {
        url: `./client/${resumable.module}.js`,
        file: relative
      };
    }
  }
  manifest.build = buildHash.digest("hex").slice(0, 16);
  manifest.runtime = "./client/runtime.js";

  // Bundle: one named chunk per event module, the runtime, shared code split.
  const esbuild = await import("esbuild");
  const runtimePath = fileURLToPath(new URL("./runtime.js", import.meta.url));
  const entryPoints = { runtime: runtimePath };
  for (const [id, file] of Object.entries(eventEntries)) entryPoints[id] = file;
  const result = await esbuild.build({
    entryPoints,
    bundle: true,
    format: "esm",
    splitting: true,
    outdir: path.join(outDir, "client"),
    entryNames: "[name]",
    chunkNames: "chunk-[hash]",
    sourcemap: true,
    minify: !!options.minify,
    target: "es2022",
    conditions: ["browser", dev ? "development" : "production"],
    define: { "process.env.NODE_ENV": JSON.stringify(dev ? "development" : "production") },
    metafile: true,
    logLevel: "silent",
    absWorkingDir: root,
    ...(options.esbuild || {})
  });
  await fs.writeFile(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { manifest, diagnostics, outDir, serverFiles, metafile: result.metafile, written };
}

function loaderFor(file) {
  if (file.endsWith(".tsx")) return "tsx";
  if (file.endsWith(".ts")) return "ts";
  if (file.endsWith(".jsx")) return "jsx";
  return "js";
}

/** Bundle the inline bootstrap: a classic IIFE exposing `solidResume.install`. */
export async function buildBootstrap({ outFile, minify = true }) {
  const esbuild = await import("esbuild");
  const source = fileURLToPath(new URL("./bootstrap.js", import.meta.url));
  const result = await esbuild.build({
    entryPoints: [source],
    bundle: true,
    format: "iife",
    globalName: "solidResume",
    minify,
    target: "es2020",
    write: false,
    logLevel: "silent"
  });
  const code = result.outputFiles[0].text;
  if (outFile) {
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, code);
  }
  return code;
}
