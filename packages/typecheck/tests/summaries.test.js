// Typed module summaries (Track C): `check({ summaries })` and
// `solid-tsc --solidSummaries <dir>`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { blockMismatches } from "../src/summary.js";
import { check, mapToGenerated, mapToSource, run, sourceHash } from "../src/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const project = path.join(fixtures, "summaries", "tsconfig.json");
const result = check({ project, summaries: true });
const modules = result.summaries.modules;
const app = modules.get("src/app.tsx");

describe("solid-tsc typed summaries", () => {
  it("summarizes every authored module, sorted, with schema, version and content hash", () => {
    expect([...modules.keys()]).toEqual([
      "src/app.tsx",
      "src/broken.ts",
      "src/components/Button.tsx",
      "src/components/Toolbar.tsx",
      "src/components/index.ts",
      "src/util/format.ts",
      "src/util/index.ts"
    ]);
    expect(app.schema).toBe("solid-module-summary");
    expect(app.version).toBe(1);
    const text = fs.readFileSync(path.join(fixtures, "summaries/src/app.tsx"), "utf8");
    expect(app.sourceHash).toBe(sourceHash(text));
    // The behavioral half is the compiler's summary of the authored text.
    expect(app.behavior.schema).toBe("solid-behavior-summary");
    expect(app.behavior.blocks.map(b => b.name)).toEqual(["add", "reset"]);
  });

  it("is deterministic and machine-independent", () => {
    const again = check({ project, summaries: true });
    for (const [name, summary] of modules) {
      expect(JSON.stringify(again.summaries.modules.get(name))).toBe(JSON.stringify(summary));
    }
    expect(JSON.stringify([...modules.values()])).not.toContain(path.resolve(fixtures));
  });

  it("resolves import identity through a renaming re-export and export *", () => {
    const components = app.types.imports.find(i => i.source === "./components");
    expect(components.resolvedFile).toBe("src/components/index.ts");
    const [primary, toolbar] = components.specifiers;
    expect(primary.resolved).toMatchObject({ file: "src/components/Button.tsx", name: "Button" });
    expect(toolbar.resolved).toMatchObject({ file: "src/components/Toolbar.tsx", name: "Toolbar" });
    const util = app.types.imports.find(i => i.source === "./util");
    expect(util.specifiers.map(s => s.resolved.file)).toEqual([
      "src/util/format.ts",
      "src/util/format.ts"
    ]);
    const barrel = modules.get("src/components/index.ts").types.exports;
    expect(barrel.map(e => [e.name, e.resolved.name, e.reexport])).toEqual([
      ["PrimaryButton", "Button", true],
      ["Toolbar", "Toolbar", false]
    ]);
    // Runtime declarations are identified as external, without re-describing their types.
    const runtime = app.types.imports.find(i => i.source === "solid-js");
    expect(runtime.external).toBe(true);
    expect(runtime.specifiers.every(s => s.type === null && s.resolved.external)).toBe(true);
  });

  it("records instantiated block categories, consistent with the behavioral operations", () => {
    const [add, reset] = app.types.blocks;
    expect(add).toMatchObject({
      block: true,
      value: "void",
      tasks: "never",
      writes: "StoreSetter<{ list: Array<Todo>; }>",
      input: "NoInfer<MouseEvent>",
      inputIsEvent: true,
      hasWrites: true,
      consistent: true
    });
    expect(reset.writes).toBe("Setter<string>");
    expect(reset.failures).toBe("never");
  });

  it("refines completeness with types: accessor operands are exact reads", () => {
    const [add, reset] = app.types.blocks;
    // `yield* title` is an accessor read once typed; `attempt(() => formatTitle(…))`
    // still calls code the summary does not describe.
    expect(app.behavior.blocks[0].body.completenessReasons).toContain("valueOperand");
    expect(add.completenessReasons).toEqual(["externalCalls", "attempt"]);
    expect(add.completeness).toBe("bounded");
    expect(reset).toMatchObject({ completeness: "exact", completenessReasons: [] });
  });

  it("records capture types with validated brands", () => {
    const brands = Object.fromEntries(app.types.blocks[0].captures.map(c => [c.name, c.brands]));
    expect(brands.title).toEqual(["accessor"]);
    expect(brands.setTodos).toEqual(["setter"]);
    expect(brands.LIMIT).toEqual(["primitive"]);
    expect(brands.formatTitle).toEqual(["function"]);
    const props = app.types.blocks[1].captures.find(c => c.name === "props");
    expect(props.brands).toContain("props");
  });

  it("records direct path reads with root, path tuple and selected value type (authored positions)", () => {
    expect(app.types.blocks[0].paths).toEqual([
      {
        root: "todos",
        keys: ["list", "length"],
        resolved: true,
        kind: "StoreRead",
        rootType: "{ list: Array<Todo>; }",
        pathType: 'readonly ["list", "length"]',
        valueType: "number"
      }
    ]);
    // app.tsx is projected: its summary positions are still authored ones.
    expect(result.projections.has(path.join(fixtures, "summaries/src/app.tsx"))).toBe(true);
  });

  it("records component props and instantiated prop types at JSX sites", () => {
    const toolbar = modules.get("src/components/Toolbar.tsx").types;
    expect(toolbar.components).toEqual([
      {
        name: "Toolbar",
        propsType: "{ onSave: EventBlock<MouseEvent>; }",
        props: [
          { name: "onSave", type: "EventBlock<MouseEvent>", optional: false, brands: ["block"] }
        ]
      }
    ]);
    expect(toolbar.jsxSites).toEqual([
      {
        element: "Button",
        attribute: "onPress",
        resolved: true,
        expected: "EventBlock<MouseEvent>",
        actual: "EventBlock<MouseEvent>",
        brands: ["block"]
      }
    ]);
    expect(app.types.jsxSites.map(s => [s.element, s.expected])).toEqual([
      ["PrimaryButton", "EventBlock<MouseEvent>"],
      ["Toolbar", "EventBlock<MouseEvent>"]
    ]);
  });

  it("records type errors per module (negative)", () => {
    expect(modules.get("src/broken.ts").types.typeErrors).toBe(1);
    expect(app.types.typeErrors).toBe(0);
  });

  it("flags behavior/type disagreements (negative)", () => {
    const block = {
      body: { ops: { writes: [{}], waits: [{}], raises: [], attempts: [] } }
    };
    expect(
      blockMismatches(block, {
        hasWrites: false,
        hasTasks: false,
        hasFailures: false,
        block: false
      })
    ).toEqual(["writesNotTyped", "tasksNotTyped", "missingBlockBrand"]);
  });

  it("maps authored offsets to generated ones through insertion edits", () => {
    const edits = [
      { sourceStart: 10, sourceEnd: 10, generatedStart: 10, generatedEnd: 40 },
      { sourceStart: 60, sourceEnd: 60, generatedStart: 90, generatedEnd: 100 }
    ];
    expect(mapToGenerated(edits, 5)).toBe(5);
    expect(mapToGenerated(edits, 10)).toBe(40);
    expect(mapToGenerated(edits, 59)).toBe(89);
    expect(mapToGenerated(edits, 60)).toBe(100);
    for (const offset of [0, 9, 11, 59, 61, 80]) {
      expect(mapToSource(edits, mapToGenerated(edits, offset))).toBe(offset);
    }
  });

  it("writes index.json and per-module files from the CLI", () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "solid-summaries-"));
    const logs = [];
    const code = run(["-p", project, "--solidSummaries", outDir], {
      log: line => logs.push(line),
      cwd: fixtures
    });
    // broken.ts has a type error: the CLI fails, but the summaries are still written.
    expect(code).toBe(1);
    const index = JSON.parse(fs.readFileSync(path.join(outDir, "index.json"), "utf8"));
    expect(index.schema).toBe("solid-summary-index");
    expect(index.modules).toHaveLength(7);
    const written = JSON.parse(
      fs.readFileSync(path.join(outDir, "src/app.tsx.summary.json"), "utf8")
    );
    expect(written.sourceHash).toBe(app.sourceHash);
    expect(run(["-p", project, "--solidSummaries"], { log: line => logs.push(line) })).toBe(1);
    expect(logs.at(-1)).toMatch(/requires an output directory/);
    fs.rmSync(outDir, { recursive: true, force: true });
  });
});
