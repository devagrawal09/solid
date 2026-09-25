// Server half: builds every fixture through the driver, server-renders the
// pages, checks the coordinates and records the server emits, and writes
// the page artifacts the client project drives.
import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { promises as fs } from "node:fs";
import { pathToFileURL } from "node:url";
import { buildResumable } from "../../src/build.js";
import {
  configureResumable,
  generateResumeBootstrap,
  jsonForScript,
  checkData,
  SCHEMA
} from "../../src/server.js";
import { fixture, fixturesDir, outDir, writeArtifact, splitScripts } from "../helpers/artifacts.js";

const root = fixturesDir;

async function renderPage(build, serverRelative, render, options = {}) {
  const url = pathToFileURL(build.serverFiles[serverRelative]).href;
  const mod = await import(url);
  const web = await import("@solidjs/web");
  const refusals = [];
  configureResumable({ log: false, onRefuse: r => refusals.push(r) });
  const html = web.renderToString(() => render(mod, web), { nonce: options.nonce });
  return { html, refusals, mod };
}

describe("buy fixture (event-only handler, action + constant + props-derived captures)", () => {
  let build;
  let page;
  beforeAll(async () => {
    build = await buildResumable({
      root,
      entries: [fixture("buy", "buy.tsx"), fixture("buy", "page.tsx")],
      outDir: path.join(outDir, "buy"),
      dev: true,
      // The client project intercepts server-function calls through the
      // runtime's config; that needs the one module instance vitest resolves,
      // not a copy bundled into the chunk (an app bundle also has one copy).
      esbuild: { external: ["@solidjs/web/server-functions"] }
    });
    page = await renderPage(build, "buy/page.tsx", (mod, web) =>
      web.createComponent(mod.Page, { skus: ["a", "b</script><!--\u2028-->"] })
    );
    await writeArtifact("buy", {
      html: page.html,
      manifest: build.manifest,
      refusals: page.refusals,
      outDir: build.outDir
    });
  });

  it("marks every handler resumable with reason-coded captures", () => {
    const verdicts = build.diagnostics.filter(d => d.file === "buy/buy.tsx");
    expect(verdicts.map(d => d.status)).toEqual([
      "resumable",
      "resumable",
      "resumable",
      "resumable",
      "resumable"
    ]);
    const click = build.manifest.handlers.find(h => h.block === "buy/buy.tsx#0");
    expect(click.event).toBe("click");
    expect(click.captures).toEqual([
      {
        name: "track",
        kind: "import",
        source: "./actions",
        imported: "track",
        import: "action",
        id: expect.stringMatching(/^track-[0-9a-f]+$/)
      },
      { name: "sku", kind: "value", reason: "props-path" },
      { name: "STEP", kind: "constant", value: 5 }
    ]);
    expect(click.prelude).toEqual([
      { op: "preventDefault" },
      { op: "guard", path: ["button"], test: "neq", value: 0 }
    ]);
    expect(click.snapshot).toEqual([["button"], ["clientX"], ["isTrusted"]]);
    const input = build.manifest.handlers.find(h => h.event === "input");
    expect(input.snapshot).toEqual([["currentTarget", "value"]]);
    expect(build.manifest.scopes[0].signals).toEqual([]);
    expect(build.manifest.scopes[0].values).toEqual(["sku"]);
  });

  it("keeps the action id identical in the manifest, the client stub and the server registry", async () => {
    const id = build.manifest.handlers[0].captures[0].id;
    const clientStub = await fs.readFile(
      path.join(build.outDir, "client-src", "buy", "actions.js"),
      "utf8"
    );
    expect(clientStub).toContain(`createServerReference_1("${id}")`);
    const serverModule = await fs.readFile(
      path.join(build.outDir, "server", "buy", "actions.js"),
      "utf8"
    );
    expect(serverModule).toMatch(new RegExp(`registerServerReference_1\\(\\s*"${id}"`));
    // the "use server" body is untouched by the resumable pass
    expect(serverModule).toContain("async function track(sku, step, detail)");
    const eventModule = await fs.readFile(
      path.join(build.outDir, "client-src", "buy", "buy.resume.tsx"),
      "utf8"
    );
    expect(eventModule).toContain('import { track } from "./actions";');
    expect(eventModule).toContain("actions: { track: track.id }");
  });

  it("emits stable coordinates: one record per instance, elements indexed, nearest boundary recorded", () => {
    const { markup, scripts } = splitScripts(page.html);
    expect(page.refusals).toEqual([]);
    // three Buy instances: two under the boundary, one outside
    const coordinates = [...markup.matchAll(/data-sr="([^"]+)"/g)].map(m => m[1]);
    expect(coordinates.length).toBe(15);
    const keys = [...new Set(coordinates.map(c => c.split("/")[0]))];
    expect(keys.length).toBe(3);
    for (const key of keys) {
      expect(markup).toContain(`_hk=${key}`);
      expect(scripts.join("")).toContain(`_$HY.r["sr:${key}"]=`);
    }
    // the boundary coordinate: the two inside instances share it, the outside one has none
    const records = scripts.join("");
    expect(records.match(/b:"[^"]+"/g)?.length ?? 0).toBe(2);
    expect(records).toContain("b:null");
    expect(records).toContain(`s:"${build.manifest.scopes[0].id}"`);
  });

  it("serializes values through the hydration serializer with script-safe escaping", () => {
    const { scripts } = splitScripts(page.html);
    const records = scripts.join("");
    expect(records).not.toContain("</script>");
    expect(records).not.toContain("\u2028");
    expect(records).toContain("\\x3C/script>");
    expect(records).toContain("\\u2028");
  });

  it("no handler body is in the server output or the initial page; each is in its event module", async () => {
    const serverCode = await fs.readFile(build.serverFiles["buy/buy.tsx"], "utf8");
    expect(serverCode).not.toContain('kind: "click"');
    expect(serverCode).toContain("_$srScope(");
    expect(page.html).not.toContain('kind: "click"');
    const chunk = await fs.readFile(
      path.join(build.outDir, "client", `${build.manifest.scopes[0].id.split(".")[0]}.js`),
      "utf8"
    );
    expect(chunk).toContain('kind: "click"');
    expect(chunk).not.toContain("_$template");
    expect(chunk).not.toContain("function Buy(");
  });

  it("the event module maps to authored lines", async () => {
    const mapText = await fs.readFile(
      path.join(build.outDir, "client-src", "buy", "buy.resume.tsx.map"),
      "utf8"
    );
    const map = JSON.parse(mapText);
    expect(map.sources).toEqual(["buy/buy.tsx"]);
    expect(map.sourcesContent[0]).toContain("export function Buy(");
    expect(map.mappings.length).toBeGreaterThan(0);
  });

  it("inlines the bootstrap with a nonce and an escaped manifest", () => {
    const script = generateResumeBootstrap({
      manifest: { ...build.manifest, note: "</script>\u2028" },
      nonce: 'n"1',
      code: "/*bootstrap*/"
    });
    expect(script.startsWith('<script nonce="n&quot;1">/*bootstrap*/')).toBe(true);
    expect(script).not.toContain("</script>\u2028");
    expect(script).toContain("\\u003C/script>\\u2028");
    expect(jsonForScript("<")).toBe('"\\u003C"');
  });
});

describe("counter fixture (resume scope: signal + exact text bindings)", () => {
  let build;
  let page;
  beforeAll(async () => {
    build = await buildResumable({
      root,
      entries: [fixture("counter", "counter.tsx")],
      outDir: path.join(outDir, "counter"),
      dev: true
    });
    page = await renderPage(build, "counter/counter.tsx", (mod, web) =>
      web.createComponent(mod.Page, {})
    );
    await writeArtifact("counter", {
      html: page.html,
      manifest: build.manifest,
      refusals: page.refusals,
      outDir: build.outDir
    });
  });

  it("plans the smallest scope: the signal, its text binding, the handler elements", () => {
    const [counter, labeled] = build.manifest.scopes;
    expect(counter.component).toBe("Counter");
    expect(counter.signals).toEqual(["count"]);
    expect(counter.values).toEqual(["count"]);
    expect(counter.bindings).toEqual([{ kind: "text", path: [], hole: null, signal: "count" }]);
    expect(counter.elements).toEqual([{ path: [], on: { click: expect.stringMatching(/\.h0$/) } }]);
    expect(labeled.component).toBe("Labeled");
    expect(labeled.bindings).toEqual([{ kind: "text", path: [2], hole: 0, signal: "count" }]);
    expect(labeled.elements.map(e => e.path)).toEqual([[0], [1]]);
    const inc = build.manifest.handlers.find(h => h.block === "counter/counter.tsx#0");
    expect(inc.captures).toEqual([
      { name: "setCount", kind: "signal-setter", signal: "count" },
      { name: "count", kind: "signal-accessor", signal: "count" }
    ]);
  });

  it("serializes each instance's current signal value and renders the text once", () => {
    const { markup, scripts } = splitScripts(page.html);
    expect(page.refusals).toEqual([]);
    expect(markup).toMatch(
      /<button _hk=(\w+) type="button" class="counter" data-sr="\1\/0">0<\/button>/
    );
    expect(markup).toContain("Count: <!--$-->10<!--/-->");
    const records = scripts.join("");
    expect(records.match(/\{count:0\}/g).length).toBe(2);
    expect(records).toContain("{count:10}");
  });
});

describe("refused fixture (compile-time and render-time refusals)", () => {
  let build;
  beforeAll(async () => {
    build = await buildResumable({
      root,
      entries: [fixture("refused", "refused.tsx")],
      outDir: path.join(outDir, "refused"),
      dev: true
    });
  });

  it("explains every hydrated handler with a reason code at its site", () => {
    const byReason = Object.fromEntries(
      build.diagnostics
        .filter(d => d.status === "hydrated" && d.block)
        .map(d => [d.block, d.reason])
    );
    expect(byReason).toEqual({
      "refused/refused.tsx#0": "mutable-closure-state",
      "refused/refused.tsx#1": "event-escape",
      "refused/refused.tsx#2": "function-capture",
      "refused/refused.tsx#3": "signal-not-in-scope",
      "refused/refused.tsx#4": "unresolved-import",
      "refused/refused.tsx#5": "event-field",
      "refused/refused.tsx#6": "event-method-outside-prelude",
      // the whole scope is refused, so the sound handler stays hydrated too
      "refused/refused.tsx#7": "scope-refused"
    });
    expect(build.diagnostics.every(d => d.site.line > 0)).toBe(true);
    expect(build.manifest.scopes.map(s => s.component)).toEqual(["Runtime"]);
  });

  it("`require` turns a refusal into a build error", async () => {
    await expect(
      buildResumable({
        root,
        entries: [fixture("refused", "refused.tsx")],
        outDir: path.join(outDir, "refused-require"),
        require: true
      })
    ).rejects.toThrow(/RESUME_REFUSED/);
  });

  it("refuses an instance whose captured value is not data, visibly and fail-closed", async () => {
    const page = await renderPage(build, "refused/refused.tsx", (mod, web) => [
      web.createComponent(mod.Runtime, { payload: { ok: true, nested: [1, "two"] } }),
      web.createComponent(mod.Runtime, { payload: () => 1 }),
      web.createComponent(mod.Runtime, { payload: { node: { nodeType: 1, nodeName: "DIV" } } })
    ]);
    const { markup } = splitScripts(page.html);
    expect(markup.match(/data-sr="/g).length).toBe(1);
    expect(markup).toContain('data-sr-refused="unserializable:values.payload:function"');
    expect(markup).toContain('data-sr-refused="unserializable:values.payload.node:dom-node"');
    expect(page.refusals.map(r => r.reason)).toEqual([
      "unserializable:values.payload:function",
      "unserializable:values.payload.node:dom-node"
    ]);
    expect(checkData({ a: new Map([[1, new Set([new Date()])]]) }, "v")).toBeNull();
    const cyclic = { self: null };
    cyclic.self = cyclic;
    expect(checkData(cyclic, "v")).toBeNull();
    expect(checkData(Promise.resolve(), "v")).toBe("unserializable:v:promise");
    expect(checkData(new (class Foo {})(), "v")).toBe("unserializable:v:Foo");
  });

  it("the manifest is versioned", () => {
    expect(build.manifest.schema).toBe(SCHEMA);
    expect(build.manifest.build).toMatch(/^[0-9a-f]{16}$/);
  });
});
