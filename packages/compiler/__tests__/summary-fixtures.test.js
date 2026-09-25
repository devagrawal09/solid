// Snapshot suite for `summarizeModule` (src/summary.rs): the compiler half
// of the strict multi-module summaries. Each fixture directory holds
// `code.{js,ts,jsx,tsx}` and the committed `summary.json`.
//
// Regenerate intentionally with:
//
//   UPDATE_SUMMARY_FIXTURES=1 pnpm exec vitest run __tests__/summary-fixtures.test.js

const fs = require("fs");
const path = require("path");
const { summarizeModule } = require("..");

const fixtureDir = path.join(__dirname, "summary", "fixtures");
const update = process.env.UPDATE_SUMMARY_FIXTURES === "1";

function source(fixture) {
  for (const name of ["code.js", "code.ts", "code.jsx", "code.tsx"]) {
    const file = path.join(fixtureDir, fixture, name);
    if (fs.existsSync(file)) return { file: name, text: fs.readFileSync(file, "utf8") };
  }
  throw new Error(`no code file in ${fixture}`);
}

const fixtures = fs
  .readdirSync(fixtureDir, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort();

describe("summarizeModule snapshots", () => {
  for (const fixture of fixtures) {
    it(fixture, () => {
      const { file, text } = source(fixture);
      const summary = summarizeModule(text, { filename: `src/${file}` });
      const actual = JSON.stringify(summary, null, 2) + "\n";
      const snapshot = path.join(fixtureDir, fixture, "summary.json");
      if (update) fs.writeFileSync(snapshot, actual);
      expect(actual).toBe(fs.readFileSync(snapshot, "utf8"));
    });
  }
});

describe("summarizeModule contract", () => {
  const events = source("event-blocks").text;
  const summary = summarizeModule(events, { filename: "src/code.tsx" });
  const block = name => summary.blocks.find(b => b.name === name);

  it("is deterministic", () => {
    const again = summarizeModule(events, { filename: "src/code.tsx" });
    expect(JSON.stringify(again)).toBe(JSON.stringify(summary));
  });

  it("records schema and version", () => {
    expect(summary.schema).toBe("solid-behavior-summary");
    expect(summary.version).toBe(1);
  });

  it("classifies captures by scope and records module-level and import captures", () => {
    const captures = Object.fromEntries(block("submit").body.captures.map(c => [c.name, c.scope]));
    expect(captures).toMatchObject({
      draft: "local",
      setDraft: "local",
      attempt: "import",
      validate: "import",
      format: "module",
      write: "import",
      track: "import"
    });
  });

  it("records a replayable prelude and propagation sensitivity", () => {
    const event = block("submit").body.event;
    expect(event.prelude.statements.map(s => s.kind)).toEqual(["preventDefault", "guardReturn"]);
    expect(event.propagationSensitive).toBe(true);
    expect(block("guarded").body.event.prelude.statements).toEqual([]);
    expect(block("guarded").body.event.stopPropagation).toBe(1);
  });

  it("records escapes: event object, assigned capture, this, event methods", () => {
    expect(block("escaping").body.event.escapes).toEqual(["argument:track"]);
    expect(block("bump").body.escapes.assignsCapture).toBe(true);
    expect(block("odd").body.escapes.this).toBe(true);
    expect(block("odd").body.event.methods).toEqual(["composedPath"]);
  });

  it("records every site a block flows to", () => {
    expect(block("submit").sites.map(s => s.kind)).toEqual(["domEvent"]);
    expect(block("inner").sites.map(s => s.kind)).toEqual(["delegated"]);
    expect(block("outer").sites.map(s => s.kind)).toEqual(["domEvent", "escape"]);
  });

  it("does not count type positions or double-count JSX tags as references", () => {
    const form = summary.bindings.find(b => b.name === "Form");
    expect(form.refs.map(r => r.name)).not.toContain("SubmitEvent");
  });

  it("marks non-literal dynamic imports, export *, top-level await, eval, with and server functions", () => {
    const unknowns = summarizeModule(source("unknowns").text, { filename: "src/code.js" });
    expect(unknowns.unknowns.map(u => u.kind)).toEqual([
      "topLevelAwait",
      "dynamicImportNonLiteral",
      "eval",
      "importMeta",
      "with",
      "newFunction"
    ]);
    expect(unknowns.serverFunctions).toBe(1);
    expect(unknowns.directives).toEqual(["use client"]);
    const block = unknowns.blocks[0].body;
    expect(block.escapes.newFunction).toBe(true);
    const graph = summarizeModule(source("module-graph").text, { filename: "src/code.ts" });
    expect(graph.unknowns.map(u => u.kind)).toEqual(["exportStar"]);
    expect(graph.dynamicImports.map(d => [d.source, d.lazy])).toEqual([
      ["./Page", true],
      ["./later", false]
    ]);
  });

  it("reports positions as UTF-16 offsets", () => {
    const text = 'const s = "😀";\nexport const x = 1;\n';
    const result = summarizeModule(text, { filename: "a.ts" });
    const x = result.bindings.find(b => b.name === "x");
    expect(x.span.start).toBe(text.indexOf("x = 1"));
    expect(x.span.line).toBe(2);
  });
});
