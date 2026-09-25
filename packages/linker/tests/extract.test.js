// Slice 3 end to end: Rollup builds of the fixture app with and without
// cold event-domain extraction, compared in jsdom.
import fs from "node:fs";
import path from "node:path";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./helpers/build.js";
import { aliasMap, appRoot, tempDir, typedSummaries } from "./helpers/fixtures.js";
import { fullScenario, missScenario, runScenario } from "./helpers/scenario.js";

const input = path.join(appRoot, "src/main.tsx");
let typed;
let baseline;
let cold;
const dirs = {};

const chunks = build => build.output.filter(file => file.type === "chunk");
const chunkNamed = (build, prefix) =>
  chunks(build).filter(chunk => chunk.fileName.startsWith(prefix));
const rel = id => path.relative(appRoot, id).split(path.sep).join("/");

beforeAll(async () => {
  typed = typedSummaries(path.join(appRoot, "tsconfig.json"));
  dirs.baseline = tempDir("baseline");
  dirs.cold = tempDir("cold");
  baseline = await buildApp({ root: appRoot, input, outDir: dirs.baseline, aliasMap });
  cold = await buildApp({
    root: appRoot,
    input,
    outDir: dirs.cold,
    aliasMap,
    cold: { typedSummaries: typed.dir, prefetch: "none" }
  });
});

describe("chunking", () => {
  it("adds one chunk per interaction domain and keeps the entry free of cold-only code", () => {
    expect(
      chunks(baseline)
        .map(c => c.name)
        .sort()
    ).toEqual(["Settings", "main"]);
    expect(
      chunks(cold)
        .map(c => c.name)
        .sort()
    ).toEqual(["Settings", "main", ...cold.manifest.domains.map(d => `cold-${d.id}`)].sort());
    const main = chunkNamed(cold, "main-")[0];
    const baseMain = chunkNamed(baseline, "main-")[0];
    for (const marker of ["empty title", "save #", "function resetMessage", "__telemetryLoaded"]) {
      expect(baseMain.code).toContain(marker);
    }
    // Cold-only helpers left the entry; the effectful module's effect did
    // not, nor did the small helper both domains use (retained hot).
    for (const marker of ["empty title", "function resetMessage", "function collapse"]) {
      expect(main.code).not.toContain(marker);
    }
    expect(main.code).toContain("__telemetryLoaded");
    expect(main.code).toContain("save #");
    // Domains are reached only dynamically.
    const coldFiles = cold.manifest.domains.map(d => d.chunk);
    for (const chunk of chunks(cold))
      for (const file of coldFiles) expect(chunk.imports).not.toContain(file);
    expect(main.dynamicImports).toContain(coldFiles[0]);
  });

  it("places every module in exactly one chunk (no duplication)", () => {
    const seen = new Map();
    for (const chunk of chunks(cold)) {
      for (const id of Object.keys(chunk.modules)) {
        expect(seen.get(id), `${rel(id)} in ${chunk.fileName} and ${seen.get(id)}`).toBeUndefined();
        seen.set(id, chunk.fileName);
      }
    }
    const domainChunk = chunkNamed(cold, `cold-${cold.manifest.domains[0].id}`)[0];
    const modules = Object.keys(domainChunk.modules).map(rel);
    expect(modules).toEqual(
      expect.arrayContaining([
        "src/utils/cycle-a.ts",
        "src/utils/cycle-b.ts",
        "src/features/editor__solid_residue.tsx",
        "src/features/editor__solid_cold_b0.tsx"
      ])
    );
    expect(modules).not.toContain("src/features/stats.ts");
  });

  it("emits a deterministic manifest naming each domain's chunk", () => {
    expect(cold.manifest.schema).toBe("solid-link-manifest");
    expect(cold.manifest.environment).toBe("client");
    for (const domain of cold.manifest.domains) {
      expect(fs.existsSync(path.join(dirs.cold, domain.chunk))).toBe(true);
    }
    // 6 extracted; the rest stay inline (negative cases, wrappers, JSX blocks,
    // and one handler using a library that ships no summary).
    expect(cold.manifest.stats.blocks).toEqual({ hot: 12, cold: 6, unknown: 1 });
  });
});

describe("runtime equivalence", () => {
  it("behaves like the baseline build across hits, misses, forwarding, errors and hot handlers", async () => {
    const base = await runScenario(dirs.baseline, fullScenario);
    const extracted = await runScenario(dirs.cold, fullScenario);
    expect(extracted.transcript).toEqual(base.transcript);
    expect(extracted.errors).toEqual(base.errors);
    // Two misses (the first handler of each domain), everything else a hit.
    expect(extracted.stats).toMatchObject({ misses: 2, loads: 2, loadFailures: 0, dropped: 0 });
    expect(extracted.stats.hits).toBeGreaterThan(4);
    expect(base.transcript).toContainEqual("submit defaultPrevented(sync)=true");
    expect(base.transcript.at(-1)).toContain("failed=failed: Error: handler failed");
  });

  it("keeps preventDefault synchronous and error routing on a cold miss", async () => {
    const base = await runScenario(dirs.baseline, missScenario);
    const extracted = await runScenario(dirs.cold, missScenario);
    expect(extracted.transcript).toEqual(base.transcript);
    expect(extracted.transcript).toContainEqual("submit defaultPrevented(sync)=true");
    expect(extracted.transcript.at(-1)).toContain("failed=failed: Error: empty title");
    expect(extracted.stats.misses).toBe(1);
  });

  it("routes a chunk-load failure to the owner's error boundary", async () => {
    const broken = tempDir("broken");
    fs.cpSync(dirs.cold, broken, { recursive: true });
    fs.rmSync(path.join(broken, cold.manifest.domains[0].chunk));
    const result = await runScenario(broken, [
      Object.assign(api => api.click("clear"), { label: "clear" })
    ]);
    expect(result.transcript.at(-1)).toMatch(
      /failed=failed: .*(Cannot find|ERR_MODULE_NOT_FOUND|not find)/
    );
    expect(result.stats.loadFailures).toBe(1);
  });
});

describe("source maps", () => {
  it("map extracted code back to the authored module", () => {
    const domainChunk = chunkNamed(cold, `cold-${cold.manifest.domains[0].id}`)[0];
    const map = new TraceMap(domainChunk.map);
    const lines = domainChunk.code.split("\n");
    const locate = needle => {
      const line = lines.findIndex(text => text.includes(needle));
      return originalPositionFor(map, { line: line + 1, column: lines[line].indexOf(needle) });
    };
    const editor = fs
      .readFileSync(path.join(appRoot, "src/features/editor.tsx"), "utf8")
      .split("\n");
    const cleared = locate("cleared ");
    expect(cleared.source).toMatch(/src\/features\/editor\.tsx$/);
    expect(editor[cleared.line - 1]).toContain("cleared ");
    const beacon = locate('beacon("submit")');
    expect(beacon.source).toMatch(/src\/features\/editor\.tsx$/);
    expect(editor[beacon.line - 1]).toContain('beacon("submit")');
    const collapse = locate("replace(/\\s+/g");
    expect(collapse.source).toMatch(/src\/utils\/cycle-b\.ts$/);
  });
});

describe("cache stability", () => {
  it("rebuilds byte-identically", async () => {
    const again = await buildApp({
      root: appRoot,
      input,
      outDir: tempDir("again"),
      aliasMap,
      cold: { typedSummaries: typed.dir, prefetch: "none" }
    });
    const names = build =>
      chunks(build)
        .map(c => c.fileName)
        .sort();
    expect(names(again)).toEqual(names(cold));
  });
});
