import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  analyzeStrictFile,
  check,
  formatDiagnostics,
  mapToSource,
  run,
  shouldAnalyzeStrict
} from "../src/index.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const project = name => path.join(fixtures, name, "tsconfig.json");

function messages(result, cwd) {
  return formatDiagnostics(result.diagnostics, cwd);
}

describe("solid-tsc", () => {
  it("accepts the direct property syntax with exact root/path/value types", () => {
    const result = check({ project: project("paths") });
    expect(messages(result, fixtures)).toBe("");
    expect(result.diagnostics).toHaveLength(0);
    // The app module was projected (its blocks use the direct syntax).
    const projected = [...result.projections.keys()].map(f => path.basename(f));
    expect(projected).toEqual(["app.tsx"]);
  });

  it("reports type errors at the authored line and column", () => {
    const result = check({ project: project("paths-error") });
    const text = messages(result, path.join(fixtures, "paths-error"));
    const lines = text.split("\n");
    // `store.user.nope`: the property error lands on the authored key
    // (`nope`, column 28), through the witness argument of the projection.
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^src\/bad\.tsx\(7,28\): error TS2339: Property 'nope' does not exist on type '\{ name: string; \}'/
      )
    );
    // The selected value (`number`) mismatches the annotation.
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^src\/bad\.tsx\(11,9\): error TS2322: Type 'number' is not assignable to type 'string'/
      )
    );
    // Refused forms keep TypeScript's own diagnosis of the authored code: a
    // string operand makes the block yield strings, so no `$` overload (block
    // or strict callback) accepts it (reported at the block); a number operand
    // is not iterable (reported at the operand).
    expect(lines).toContainEqual(
      expect.stringMatching(/^src\/bad\.tsx\(15,26\): error TS2769: No overload matches this call/)
    );
    expect(lines).toContainEqual(expect.stringMatching(/^src\/bad\.tsx\(24,17\): error TS2488/));
    expect(result.diagnostics).toHaveLength(4);
  });

  it("emits declarations from the projected program; a consumer needs no projection", () => {
    const dist = path.join(fixtures, "lib", "dist");
    fs.rmSync(dist, { recursive: true, force: true });
    const lib = check({ project: project("lib") });
    expect(messages(lib, fixtures)).toBe("");
    expect(lib.emitSkipped).toBe(false);
    const declaration = fs.readFileSync(path.join(dist, "index.d.ts"), "utf8");
    expect(declaration).toContain("StoreRead<");
    expect(declaration).toContain('readonly ["theme"]');
    expect(declaration).not.toContain("__solid_readPath");
    // Separate compilation: the consumer typechecks against the .d.ts only.
    const consumer = check({ project: project("consumer") });
    expect(messages(consumer, fixtures)).toBe("");
    expect([...consumer.projections.keys()].map(f => path.basename(f))).toEqual(["use.ts"]);
  });

  it("maps generated offsets back through the edit list", () => {
    const edits = [
      { sourceStart: 10, sourceEnd: 10, generatedStart: 10, generatedEnd: 40 }, // inserted import
      { sourceStart: 60, sourceEnd: 75, generatedStart: 90, generatedEnd: 120 } // rewritten operand
    ];
    expect(mapToSource(edits, 5)).toBe(5);
    expect(mapToSource(edits, 20)).toBe(10); // inside the import: its anchor
    expect(mapToSource(edits, 50)).toBe(20); // after the import: shifted by 30
    expect(mapToSource(edits, 100)).toBe(60); // inside the rewrite: the operand
    expect(mapToSource(edits, 130)).toBe(85); // after both: shifted by 30 + 15
  });

  it("accepts strict markers as ordinary TypeScript and reports their graph", () => {
    const result = check({ project: project("strict") });
    expect(messages(result, fixtures)).toBe("");
    expect(result.diagnostics).toHaveLength(0);
    // No `yield*`: nothing is projected; the strict analysis still runs.
    expect([...result.projections.keys()]).toEqual([]);
    const [[file, blocks]] = [...result.strictBlocks.entries()];
    expect(path.basename(file)).toBe("app.tsx");
    expect(blocks.map(block => [block.host.kind, block.completeness])).toEqual([
      ["memo", "exact"],
      ["memo", "bounded"],
      ["effect", "exact"],
      ["memo", "exact"],
      ["event", "bounded"],
      ["event", "exact"]
    ]);
    const [, user, , label, increment] = blocks;
    expect(user.async).toBe(true);
    expect(user.reads.map(read => [read.kind, read.path.join("."), read.afterAwait])).toEqual([
      ["store", "user.name", false],
      ["store", "items.length", false]
    ]);
    expect(label.reads.map(read => [read.kind, read.root, read.path.join(".")])).toEqual([
      ["prop", "props", "selected.name"],
      ["prop", "props", "step"],
      ["signal", "count", ""]
    ]);
    expect(increment.writes.map(write => write.target)).toEqual(["setCount", "setStore"]);
    expect(increment.host.events).toEqual(["click"]);
  });

  it("reports strict diagnostics next to TypeScript's, at authored positions", () => {
    const result = check({ project: project("strict-error") });
    const lines = messages(result, path.join(fixtures, "strict-error")).split("\n");
    // TypeScript's own error inside a strict callback keeps its column.
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^src\/bad\.tsx\(9,11\): error TS2322: Type 'number' is not assignable to type 'string'/
      )
    );
    // The compiler's strict diagnostics: code, edge, fix, position.
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^src\/bad\.tsx\(15,52\): error SOLID90003: \[STRICT_CAPABILITY_ESCAPE\] `count` is an accessor and is passed to `register`.*read its value with `count\(\)`/
      )
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^src\/bad\.tsx\(20,5\): error SOLID90005: \[STRICT_WRITE_IN_REACTIVE_HOST\] `setCount` is written inside a `memo` host/
      )
    );
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^src\/bad\.tsx\(26,16\): error SOLID90001: \[STRICT_HOST_UNKNOWN\] `lonely` is never consumed/
      )
    );
    expect(result.diagnostics).toHaveLength(4);
    // Every summary is still reported (refused blocks are `unknown`).
    const [[, blocks]] = [...result.strictBlocks.entries()];
    expect(blocks.map(block => block.completeness)).toEqual([
      "exact",
      "unknown",
      "unknown",
      "unknown"
    ]);
    expect(run(["-p", project("strict-error")], { log: () => {}, cwd: fixtures })).toBe(1);
  });

  it("exposes the per-file analysis an editor language service consumes", () => {
    const text =
      'import { $, createMemo, createSignal } from "solid-js";\nconst [count] = createSignal(1);\nexport const m = createMemo($(() => count()));\nconst bad = $(() => count());\n';
    expect(shouldAnalyzeStrict(text)).toBe(true);
    expect(
      shouldAnalyzeStrict(
        'import { createMemo } from "solid-js";\nconst m = createMemo(() => 1);\n'
      )
    ).toBe(false);
    const { blocks, diagnostics } = analyzeStrictFile("/virtual/app.tsx", text);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].reads[0]).toEqual(
      expect.objectContaining({ kind: "signal", root: "count", tracked: true, certainty: "exact" })
    );
    // Sites are authored UTF-16 offsets: usable directly by a language service.
    expect(text.slice(blocks[0].marker.start, blocks[0].marker.end)).toBe("$(() => count())");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        code: 90001,
        source: "solid-strict",
        start: text.indexOf("$(() => count());\n")
      })
    );
    expect(diagnostics[0].file.getLineAndCharacterOfPosition(diagnostics[0].start)).toEqual({
      line: 3,
      character: 12
    });
  });

  it("runs as a tsc-shaped CLI", () => {
    const logs = [];
    const log = line => logs.push(line);
    expect(run(["-p", project("paths")], { log, cwd: fixtures })).toBe(0);
    expect(logs).toEqual([]);
    expect(run(["-p", project("paths-error")], { log, cwd: fixtures })).toBe(1);
    expect(logs.join("\n")).toMatch(/bad\.tsx\(7,28\): error TS2339/);
    expect(run(["-b"], { log, cwd: fixtures })).toBe(1);
    expect(logs.at(-1)).toMatch(/--build and --watch are not supported/);
  });
});
