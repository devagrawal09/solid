// Measurements for the resumable-events prototype. Full-route accounting:
// everything the initial page carries, everything the first interaction
// loads, and the ordinary-hydration baseline for the same fixtures.
//
//   pnpm --filter @solidjs/resumable measure
//
// Writes measurements/results.json and prints a markdown summary. Sizes are
// raw / esbuild-minified / gzip / brotli bytes; latencies are jsdom medians
// (in-process module loading: no network), so they bound only the runtime's
// own work, not a real network. Nothing here is a release claim.
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import { register } from "node:module";
import { buildResumable, buildBootstrap } from "../src/build.js";

register("./resolve-hooks.mjs", import.meta.url);
import { generateResumeBootstrap, jsonForScript, configureResumable } from "../src/server.js";

const require = createRequire(import.meta.url);
const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = path.join(packageDir, "test", "fixtures");
const outDir = path.join(packageDir, "test", ".out", "measure");
const resultsDir = path.join(packageDir, "measurements");

const sizes = text => {
  const buffer = Buffer.from(text);
  return {
    raw: buffer.length,
    gzip: gzipSync(buffer).length,
    brotli: brotliCompressSync(buffer).length
  };
};
const minified = async (code, loader = "js") => {
  const esbuild = await import("esbuild");
  return (await esbuild.transform(code, { loader, minify: true })).code;
};
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

async function bundleSize(entryPoints, { external = [], define = {} } = {}) {
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    entryPoints,
    bundle: true,
    format: "esm",
    minify: true,
    write: false,
    conditions: ["browser", "production"],
    define: { "process.env.NODE_ENV": '"production"', ...define },
    external,
    logLevel: "silent",
    absWorkingDir: packageDir
  });
  const code = result.outputFiles.map(f => f.text).join("\n");
  return { ...sizes(code), rawUnminified: null };
}

async function main() {
  const results = {
    commit: process.env.GIT_COMMIT || null,
    node: process.version,
    date: new Date().toISOString()
  };

  // --- bootstrap ---------------------------------------------------------
  const bootstrapMin = await buildBootstrap({ minify: true });
  const bootstrapRaw = await buildBootstrap({ minify: false });
  results.bootstrap = { minified: sizes(bootstrapMin), unminified: sizes(bootstrapRaw) };

  // --- fixtures: build (prod) --------------------------------------------
  const fixtures = {
    buy: {
      entries: ["buy/buy.tsx", "buy/page.tsx"],
      render: "buy/page.tsx",
      component: "Page",
      props: { skus: ["a", "b"] }
    },
    counter: {
      entries: ["counter/counter.tsx"],
      render: "counter/counter.tsx",
      component: "Page",
      props: {}
    }
  };
  results.fixtures = {};
  for (const [name, fixture] of Object.entries(fixtures)) {
    const compileStart = performance.now();
    const build = await buildResumable({
      root: fixturesDir,
      entries: fixture.entries.map(e => path.join(fixturesDir, e)),
      outDir: path.join(outDir, name),
      dev: false,
      minify: true
    });
    const compileMs = performance.now() - compileStart;

    // event chunk(s) + runtime as shipped (minified by the driver)
    const chunks = {};
    for (const [id, mod] of Object.entries(build.manifest.modules)) {
      chunks[id] = sizes(await fs.readFile(path.join(build.outDir, mod.url), "utf8"));
    }
    const runtime = sizes(
      await fs.readFile(path.join(build.outDir, build.manifest.runtime), "utf8")
    );
    const shared = {};
    for (const file of await fs.readdir(path.join(build.outDir, "client"))) {
      if (file.startsWith("chunk-") && file.endsWith(".js")) {
        shared[file] = sizes(await fs.readFile(path.join(build.outDir, "client", file), "utf8"));
      }
    }

    // server render: HTML overhead of coordinates + records
    const web = await import("@solidjs/web");
    const mod = await import(pathToFileURL(build.serverFiles[fixture.render]).href);
    configureResumable({ log: false });
    const html = web.renderToString(() =>
      web.createComponent(mod[fixture.component], fixture.props)
    );
    const stripped = html
      .replace(/ data-sr="[^"]*"/g, "")
      .replace(/<script>[\s\S]*?<\/script>/g, "");
    const records = (html.match(/<script>[\s\S]*?<\/script>/g) || []).join("");
    const manifestScript = generateResumeBootstrap({ manifest: build.manifest, code: "" });
    const manifestJson = jsonForScript(build.manifest);
    results.fixtures[name] = {
      compileAndBundleMs: Math.round(compileMs),
      eventChunks: chunks,
      runtime,
      sharedChunks: shared,
      html: {
        withResume: sizes(html),
        withoutResume: sizes(stripped),
        coordinatesAndRecordsBytes: Buffer.byteLength(html) - Buffer.byteLength(stripped),
        recordsScriptBytes: Buffer.byteLength(records),
        manifestBytes: Buffer.byteLength(manifestJson),
        inlineBootstrapWithManifest: sizes(bootstrapMin + manifestScript)
      },
      handlers: build.manifest.handlers.length,
      scopes: build.manifest.scopes.length
    };

    // first-interaction latency in jsdom (in-process import; no network)
    results.fixtures[name].latency = await latency(build, html, name);
  }

  // --- ordinary hydration baseline ----------------------------------------
  // The client entry an ordinary hydrated route ships for the same fixtures:
  // solid-js + @solidjs/web (client) + the component compiled for the DOM.
  const compiler = require("@solidjs/compiler");
  const baselineDir = path.join(outDir, "baseline");
  await fs.mkdir(baselineDir, { recursive: true });
  results.baseline = {};
  for (const [name, fixture] of Object.entries(fixtures)) {
    const entry = fixture.entries[fixture.entries.length - 1];
    const source = await fs.readFile(path.join(fixturesDir, entry), "utf8");
    const dom = compiler.transform(source, { filename: entry, generate: "dom", hydratable: true });
    const esbuild = await import("esbuild");
    const stripped = (await esbuild.transform(dom.code, { loader: "tsx" })).code;
    const componentFile = path.join(baselineDir, `${name}.component.js`);
    await fs.writeFile(
      componentFile,
      stripped.replace(/from "\.\/(buy|actions)"/g, (m, dep) => `from "./${name}.${dep}.js"`)
    );
    if (name === "buy") {
      const buySource = await fs.readFile(path.join(fixturesDir, "buy/buy.tsx"), "utf8");
      const buyDom = compiler.transform(buySource, {
        filename: "buy/buy.tsx",
        generate: "dom",
        hydratable: true
      });
      await fs.writeFile(
        path.join(baselineDir, "buy.buy.js"),
        (await esbuild.transform(buyDom.code, { loader: "tsx" })).code.replace(
          'from "./actions"',
          'from "./buy.actions.js"'
        )
      );
      const actions = await fs.readFile(path.join(fixturesDir, "buy/actions.ts"), "utf8");
      const client = compiler.transformDirectives(actions, {
        filename: "buy/actions.ts",
        root: fixturesDir,
        mode: "client"
      });
      await fs.writeFile(path.join(baselineDir, "buy.actions.js"), client.code);
    }
    const hydrateEntry = path.join(baselineDir, `${name}.entry.js`);
    await fs.writeFile(
      hydrateEntry,
      `import { hydrate, createComponent } from "@solidjs/web";\nimport { ${fixture.component} } from "./${name}.component.js";\nhydrate(() => createComponent(${fixture.component}, ${JSON.stringify(fixture.props)}), document.body);\n`
    );
    results.baseline[name] = {
      // same accounting as the resumable route: the server-function client
      // is bundled in when the component imports an action
      hydrationEntry: await bundleSize([hydrateEntry])
    };
  }
  // The hydration bootstrap script Solid inlines (`generateHydrationScript`)
  const webServer = await import("@solidjs/web");
  results.baseline.hydrationScript = sizes(webServer.generateHydrationScript());

  // --- compile cost of the option itself (transform only, no bundling) ----
  results.compile = {};
  for (const [name, fixture] of Object.entries(fixtures)) {
    const entry = fixture.entries[0];
    const source = await fs.readFile(path.join(fixturesDir, entry), "utf8");
    const time = options => {
      const samples = [];
      for (let i = 0; i < 40; i++) {
        const start = performance.now();
        compiler.transform(source, {
          filename: entry,
          generate: "ssr",
          hydratable: true,
          ...options
        });
        samples.push(performance.now() - start);
      }
      return +median(samples).toFixed(3);
    };
    time({});
    results.compile[name] = {
      ssrMs: time({}),
      ssrWithResumableMs: time({
        resumableEvents: {
          root: fixturesDir,
          imports: [{ source: "./actions", imported: "track", kind: "action", id: "track-x" }]
        }
      }),
      ssrWithResumableAndSourceMapMs: time({
        sourceMap: true,
        resumableEvents: {
          root: fixturesDir,
          imports: [{ source: "./actions", imported: "track", kind: "action", id: "track-x" }]
        }
      })
    };
  }

  await fs.mkdir(resultsDir, { recursive: true });
  await fs.writeFile(path.join(resultsDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(summarize(results));
}

/** Cold (nothing loaded), warm (loaded) and prefetched first-click latency in jsdom. */
async function latency(build, html, name) {
  const { JSDOM } = await import("jsdom");
  const { install } = await import("../src/bootstrap.js");
  const runs = { cold: [], warm: [], prefetched: [] };
  // buy: the `.fail` handler throws synchronously, so the failure report
  // marks the exact moment the handler ran (no server-function transport).
  const selector = name === "buy" ? ".fail" : ".counter";
  for (let i = 0; i < 7; i++) {
    for (const mode of ["cold", "prefetched", "warm"]) {
      const dom = new JSDOM(html.replace(/<script>[\s\S]*?<\/script>/g, ""), {
        runScripts: "outside-only"
      });
      const { window } = dom;
      window._$HY = { r: {} };
      for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) window.eval(script);
      let done;
      const finished = new Promise(resolve => (done = resolve));
      // fresh module instances per run are not possible in-process; the
      // loader cost measured is the import() of already-evaluated modules
      const controller = install(build.manifest, {
        window,
        document: window.document,
        report: failure => {
          if (failure.kind === "handler-error") done();
        },
        load: url => import(pathToFileURL(path.join(build.outDir, url)).href + `?run=${i}-${mode}`)
      });
      const target = window.document.querySelector(selector);
      if (mode === "prefetched")
        await controller.prefetch(build.manifest.handlers.find(h => h.event === "click").id);
      if (mode === "warm") {
        target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await controller.settled();
        await new Promise(r => setTimeout(r, 0));
      }
      const start = performance.now();
      target.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      if (name === "buy") await finished;
      else {
        await controller.settled();
        await new Promise(r => setTimeout(r, 0));
      }
      runs[mode].push(performance.now() - start);
      controller.uninstall();
      window.close();
    }
  }
  return Object.fromEntries(
    Object.entries(runs).map(([k, v]) => [
      k,
      { medianMs: +median(v).toFixed(2), samples: v.map(x => +x.toFixed(2)) }
    ])
  );
}

function summarize(r) {
  const s = x => `${x.raw} / ${x.gzip} / ${x.brotli}`;
  const lines = [];
  lines.push(`Node ${r.node}, ${r.date}`);
  lines.push("");
  lines.push("| artifact | raw / gzip / brotli (bytes) |");
  lines.push("| --- | --- |");
  lines.push(`| inline bootstrap (minified) | ${s(r.bootstrap.minified)} |`);
  lines.push(`| inline bootstrap (unminified) | ${s(r.bootstrap.unminified)} |`);
  lines.push(
    `| ordinary hydration inline script (generateHydrationScript) | ${s(r.baseline.hydrationScript)} |`
  );
  for (const [name, f] of Object.entries(r.fixtures)) {
    lines.push(`| ${name}: event chunk(s) | ${Object.values(f.eventChunks).map(s).join("; ")} |`);
    lines.push(`| ${name}: runtime chunk | ${s(f.runtime)} |`);
    for (const [file, size] of Object.entries(f.sharedChunks))
      lines.push(`| ${name}: shared ${file} | ${s(size)} |`);
    lines.push(`| ${name}: HTML with coordinates+records | ${s(f.html.withResume)} |`);
    lines.push(`| ${name}: HTML without | ${s(f.html.withoutResume)} |`);
    lines.push(
      `| ${name}: inline bootstrap + manifest | ${s(f.html.inlineBootstrapWithManifest)} |`
    );
    lines.push(
      `| ${name}: ordinary hydration client entry (component + solid-js + @solidjs/web) | ${s(r.baseline[name].hydrationEntry)} |`
    );
  }
  lines.push("");
  lines.push("| fixture | SSR transform ms | + resumableEvents ms | + source map ms |");
  lines.push("| --- | --- | --- | --- |");
  for (const [name, c] of Object.entries(r.compile)) {
    lines.push(
      `| ${name} | ${c.ssrMs} | ${c.ssrWithResumableMs} | ${c.ssrWithResumableAndSourceMapMs} |`
    );
  }
  lines.push("");
  lines.push("| fixture | compile+bundle ms | cold click ms | prefetched ms | warm ms |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const [name, f] of Object.entries(r.fixtures)) {
    lines.push(
      `| ${name} | ${f.compileAndBundleMs} | ${f.latency.cold.medianMs} | ${f.latency.prefetched.medianMs} | ${f.latency.warm.medianMs} |`
    );
  }
  return lines.join("\n");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
