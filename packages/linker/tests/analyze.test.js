// Linker analysis over the fixture graphs: event-only proofs, fixed-point
// hot|cold|shared|unknown classification (client and server graphs
// independently), clustering, and the negative/unknown cases.
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildManifest, link, summarizePackage } from "../src/index.js";
import {
  aliasMap,
  appRoot,
  copyFixture,
  fixtures,
  resolverFor,
  tempDir,
  typedSummaries
} from "./helpers/fixtures.js";

let typed;
let client;
let server;
const byModule = analysis => Object.fromEntries(analysis.modules.map(m => [m.module, m]));
const byBlock = analysis =>
  Object.fromEntries(analysis.blocks.map(b => [b.name ? `${b.module}:${b.name}` : b.key, b]));

beforeAll(async () => {
  typed = typedSummaries(path.join(appRoot, "tsconfig.json"));
  expect(typed.errors).toBe("");
  const options = { root: appRoot, typedSummaries: typed.dir, resolve: resolverFor() };
  client = await link({ ...options, entries: [path.join(appRoot, "src/main.tsx")] });
  server = await link({
    ...options,
    entries: [path.join(appRoot, "src/server.tsx")],
    environment: "server"
  });
});

describe("classification (client graph)", () => {
  it("classifies modules hot | cold | shared | unknown", () => {
    const modules = byModule(client);
    const classes = Object.fromEntries(Object.entries(modules).map(([name, m]) => [name, m.class]));
    expect(classes).toMatchObject({
      "src/main.tsx": "hot",
      "src/App.tsx": "hot",
      "src/components/index.ts": "hot",
      "src/components/Button.tsx": "hot",
      "src/components/Toolbar.tsx": "hot",
      // Rendering and extracted handlers both use these.
      "src/features/editor.tsx": "shared",
      "src/features/stats.ts": "shared",
      "src/utils/analytics.ts": "shared",
      // Reached only from extracted bodies, including an import cycle.
      "src/utils/cycle-a.ts": "cold",
      "src/utils/cycle-b.ts": "cold",
      // Small, and reached by both domains: kept hot rather than becoming a
      // shared chunk of its own.
      "src/utils/describe.ts": "shared",
      "src/utils/validate.ts": "cold",
      "src/utils/report.ts": "cold",
      // A library with a valid summary is analyzed like application code...
      "../libs/ui-kit/dist/index.js": "cold",
      "../libs/ui-kit/dist/format.js": "cold",
      "../libs/ui-kit/dist/badge.js": "unused",
      // ...one without a summary is unknown and retained.
      "../libs/legacy-lib/dist/index.js": "unknown"
    });
    expect(modules["../libs/legacy-lib/dist/index.js"].status).toBe("missingSummary");
    expect(modules["src/server-only.ts"]).toBeUndefined();
  });

  it("moves cold-only statements of hot modules to residues, pinning what cannot move (fixed point)", () => {
    const modules = byModule(client);
    expect(modules["src/features/editor.tsx"].residue).toEqual(["resetMessage"]);
    expect(modules["src/utils/validate.ts"].residue).toEqual([]);
    // Effectful module: the effect stays hot, the cold-only bindings move.
    expect(modules["src/utils/telemetry.ts"].residue).toEqual(["beacon", "beacons"]);
    // `LIMIT` is imported by a cold (non-generated) module: pinned and re-rooted hot.
    const limit = client.bindings.find(
      b => b.module === "src/features/stats.ts" && b.name === "LIMIT"
    );
    expect(limit).toMatchObject({ class: "shared", moved: false });
    expect(modules["src/features/stats.ts"].residue).toEqual([]);
    expect(client.iterations).toBe(3);
    expect(client.sharedRetained).toEqual([
      {
        dependency: "src/utils/describe.ts",
        domains: client.domains.map(d => d.id).sort(),
        bytes: 121
      }
    ]);
    // A registered action keeps its identity: created by module evaluation, never moved.
    const persist = client.bindings.find(b => b.module === "src/state.ts" && b.name === "persist");
    expect(persist).toMatchObject({ class: "shared", moved: false });
  });

  it("proves event-only blocks across modules, barrels and prop forwarding", () => {
    const blocks = byBlock(client);
    const cold = client.blocks.filter(b => b.class === "cold").map(b => b.name ?? b.key);
    expect(cold.sort()).toEqual(
      ["clear", "fail", "run", "save", "submit", "src/features/editor.tsx#b10"].sort()
    );
    // Exported, imported through App, forwarded Toolbar.onSave → Button.onPress → <button onClick>.
    expect(blocks["src/exported-handler.tsx:save"]).toMatchObject({
      class: "cold",
      events: ["click"]
    });
    expect(blocks["src/features/editor.tsx:submit"]).toMatchObject({
      prelude: ["preventDefault", "guardReturn"],
      snapshot: ["currentTarget", "type"],
      events: ["submit"]
    });
  });

  it("keeps escaping and propagation-sensitive handlers hot, with reasons (negative)", () => {
    const blocks = byBlock(client);
    expect(blocks["src/features/editor.tsx:sensitive"].reasons).toEqual([
      "propagationOutsidePrelude"
    ]);
    expect(blocks["src/features/editor.tsx:escaping"].reasons).toEqual([
      "eventEscapes:argument:track"
    ]);
    expect(blocks["src/features/editor.tsx:counted"].reasons).toEqual([
      "escape:assignsCapture",
      "mutableCapture:clears"
    ]);
    expect(blocks["src/features/editor.tsx:inner"].reasons).toEqual([
      "notEventOnly:site:delegated"
    ]);
    expect(blocks["src/features/editor.tsx:outer"].reasons).toEqual(["eventEscapes:argument:call"]);
    for (const name of ["sensitive", "escaping", "counted", "inner", "outer"]) {
      expect(blocks[`src/features/editor.tsx:${name}`].class).toBe("hot");
    }
  });

  it("refuses wrappers, forwarding into a delegating wrapper, and unsummarized libraries", () => {
    const blocks = byBlock(client);
    expect(blocks["src/features/wrappers.tsx:viaConfirm"]).toMatchObject({
      class: "hot",
      reasons: ["notEventOnly:forward:Confirm.onPress:propUse:delegated"]
    });
    expect(blocks["src/features/wrappers.tsx:viaWrap"]).toMatchObject({
      class: "hot",
      reasons: ["notEventOnly:site:argument"]
    });
    expect(blocks["src/features/wrappers.tsx:confirm"].reasons).toEqual([
      "eventEscapes:argument:call"
    ]);
    expect(blocks["src/features/editor.tsx:legacy"]).toMatchObject({
      class: "unknown",
      reasons: ["unknownLibrary:legacyFormat"]
    });
  });

  it("records exact | bounded | unknown completeness per block", () => {
    const blocks = byBlock(client);
    expect(blocks["src/features/editor.tsx:fail"].completeness).toBe("exact");
    expect(blocks["src/features/editor.tsx:submit"].completeness).toBe("bounded");
  });

  it("clusters by interaction domain: one chunk per route root, not one per handler", () => {
    expect(client.domains.map(d => [d.roots, d.blocks.length])).toEqual([
      [["src/main.tsx"], 5],
      [["src/routes/Settings.tsx"], 1]
    ]);
    expect(client.lazyRoots).toEqual(["src/routes/Settings.tsx"]);
  });
});

describe("server graph", () => {
  it("is analyzed independently", () => {
    const modules = byModule(server);
    expect(modules["src/server-only.ts"].class).toBe("hot");
    expect(modules["src/server.tsx"].roots).toEqual(["src/server.tsx"]);
    expect(server.environment).toBe("server");
    // No server module is rooted at the client entry.
    expect(Object.values(modules).some(m => m.roots.includes("src/main.tsx"))).toBe(false);
    expect(buildManifest(server).environment).toBe("server");
  });
});

describe("determinism", () => {
  it("produces identical manifests across runs", async () => {
    const again = await link({
      root: appRoot,
      typedSummaries: typed.dir,
      resolve: resolverFor(),
      entries: [path.join(appRoot, "src/main.tsx")]
    });
    const strip = manifest => ({ ...manifest, stats: { ...manifest.stats, timings: null } });
    expect(JSON.stringify(strip(buildManifest(again)))).toBe(
      JSON.stringify(strip(buildManifest(client)))
    );
  });
});

describe("missing, stale, incompatible or escaped metadata becomes unknown (negative)", () => {
  const entry = root => [path.join(root, "src/main.tsx")];

  it("strict mode without typed summaries extracts nothing; non-strict analysis does", async () => {
    const strict = await link({ root: appRoot, entries: entry(appRoot), resolve: resolverFor() });
    expect(strict.blocks.filter(b => b.class === "cold")).toEqual([]);
    expect(byBlock(strict)["src/features/editor.tsx:submit"]).toMatchObject({
      class: "unknown",
      reasons: ["types:missing"]
    });
    const loose = await link({
      root: appRoot,
      entries: entry(appRoot),
      resolve: resolverFor(),
      strict: false
    });
    expect(loose.blocks.filter(b => b.class === "cold")).toHaveLength(6);
  });

  it("a stale typed summary (source changed after solid-tsc) makes the module's blocks unknown", async () => {
    // Equivalent to editing the source after solid-tsc ran: the recorded
    // content hash no longer matches the text being bundled.
    const dir = tempDir("stale");
    fs.cpSync(typed.dir, dir, { recursive: true });
    const file = path.join(dir, "src/features/editor.tsx.summary.json");
    const summary = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...summary, sourceHash: "sha256:" + "0".repeat(64) }));
    const analysis = await link({
      root: appRoot,
      entries: entry(appRoot),
      typedSummaries: dir,
      resolve: resolverFor()
    });
    const blocks = byBlock(analysis);
    expect(blocks["src/features/editor.tsx:submit"]).toMatchObject({
      class: "unknown",
      reasons: ["types:stale"]
    });
    // Other modules keep their proofs.
    expect(blocks["src/exported-handler.tsx:save"].class).toBe("cold");
  });

  it("type errors in a module make its blocks unknown", async () => {
    const dir = tempDir("errors");
    fs.cpSync(typed.dir, dir, { recursive: true });
    const file = path.join(dir, "src/exported-handler.tsx.summary.json");
    const summary = JSON.parse(fs.readFileSync(file, "utf8"));
    summary.types.typeErrors = 1;
    fs.writeFileSync(file, JSON.stringify(summary));
    const analysis = await link({
      root: appRoot,
      entries: entry(appRoot),
      typedSummaries: dir,
      resolve: resolverFor()
    });
    expect(byBlock(analysis)["src/exported-handler.tsx:save"]).toMatchObject({
      class: "unknown",
      reasons: ["types:typeErrors"]
    });
  });

  it("a typed identity that disagrees with the linker's re-export resolution is unknown", async () => {
    const dir = tempDir("identity");
    fs.cpSync(typed.dir, dir, { recursive: true });
    const file = path.join(dir, "src/features/editor.tsx.summary.json");
    const summary = JSON.parse(fs.readFileSync(file, "utf8"));
    const validate = summary.types.imports.find(i => i.source === "../utils/validate");
    validate.specifiers.find(s => s.local === "validate").resolved.file = "src/utils/describe.ts";
    fs.writeFileSync(file, JSON.stringify(summary));
    const analysis = await link({
      root: appRoot,
      entries: entry(appRoot),
      typedSummaries: dir,
      resolve: resolverFor()
    });
    expect(byBlock(analysis)["src/features/editor.tsx:submit"]).toMatchObject({
      class: "unknown",
      reasons: ["identityMismatch:validate"]
    });
  });

  it("stale or incompatible library summaries make library modules unknown", async () => {
    const libs = copyFixture("libs");
    const map = {
      "ui-kit": path.join(libs, "ui-kit/dist/index.js"),
      "legacy-lib": path.join(libs, "legacy-lib/dist/index.js")
    };
    fs.appendFileSync(path.join(libs, "ui-kit/dist/format.js"), "\nexport const drift = 1;\n");
    let analysis = await link({
      root: appRoot,
      entries: entry(appRoot),
      typedSummaries: typed.dir,
      resolve: resolverFor(map)
    });
    const format = analysis.modules.find(m => m.module.endsWith("ui-kit/dist/format.js"));
    expect(format).toMatchObject({ class: "unknown", status: "staleSummary" });
    // Regenerating the summary restores the proof.
    summarizePackage(path.join(libs, "ui-kit"));
    analysis = await link({
      root: appRoot,
      entries: entry(appRoot),
      typedSummaries: typed.dir,
      resolve: resolverFor(map)
    });
    expect(analysis.modules.find(m => m.module.endsWith("ui-kit/dist/format.js")).class).toBe(
      "cold"
    );
    const summary = JSON.parse(
      fs.readFileSync(path.join(libs, "ui-kit/solid-summary.json"), "utf8")
    );
    const libs2 = copyFixture("libs");
    fs.writeFileSync(
      path.join(libs2, "ui-kit/solid-summary.json"),
      JSON.stringify({ ...summary, version: 999 })
    );
    analysis = await link({
      root: appRoot,
      entries: entry(appRoot),
      typedSummaries: typed.dir,
      resolve: resolverFor({ ...map, "ui-kit": path.join(libs2, "ui-kit/dist/index.js") })
    });
    expect(analysis.modules.find(m => m.module.endsWith("ui-kit/dist/index.js"))).toMatchObject({
      class: "unknown",
      status: "incompatibleSummary"
    });
  });

  it("a non-literal dynamic import makes every export unknown", async () => {
    const root = path.join(fixtures, "dynamic-app");
    const analysis = await link({
      root,
      entries: entry(root),
      resolve: resolverFor({}),
      strict: false
    });
    const blocks = byBlock(analysis);
    expect(analysis.nonLiteralDynamicImport).toBe("src/main.tsx");
    expect(blocks["src/panel.tsx:local"].class).toBe("cold");
    expect(blocks["src/panel.tsx:exportedPing"].reasons).toEqual([
      "notEventOnly:unknownImporter:src/main.tsx"
    ]);
    const text = analysis.modules.find(m => m.module === "src/text.ts");
    expect(text.class).toBe("unknown");
  });

  it("eval makes a module opaque: nothing extracted, everything it imports retained", async () => {
    const root = path.join(fixtures, "opaque-app");
    const analysis = await link({
      root,
      entries: entry(root),
      resolve: resolverFor({}),
      strict: false
    });
    expect(byBlock(analysis)["src/widget.tsx:click"]).toMatchObject({
      class: "unknown",
      reasons: ["moduleOpaque"]
    });
    const modules = byModule(analysis);
    expect(modules["src/widget.tsx"].class).toBe("unknown");
    expect(modules["src/helper.ts"].class).toBe("unknown");
  });
});
