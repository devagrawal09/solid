import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check, formatDiagnostics, mapToSource, run } from "../src/index.js";
import { summarizeProgram } from "../src/capabilities.js";

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
    // string operand makes the block yield strings (reported at the block),
    // a number operand is not iterable (reported at the operand).
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^src\/bad\.tsx\(15,26\): error TS2345: Argument of type '\(\) => Generator<string/
      )
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

  it("--capabilities: typed verdicts for host computes and component props", () => {
    const result = check({ project: project("capabilities") });
    expect(messages(result, fixtures)).toBe("");
    const summary = summarizeProgram(result.program, result.projections);
    const file = path.join(fixtures, "capabilities/src/app.tsx");
    const source = fs.readFileSync(file, "utf8");
    const { computes, props } = summary.files[file];
    const at = text => String(source.indexOf(text));
    expect(computes[at("() => rows().length")]).toBe("sync");
    expect(computes[at("() => rows().map")]).toBe("sync");
    expect(computes[at("async () =>")]).toBe("async");
    expect(computes[at("() => loose")]).toBe("unknown");
    // A `$` block: its call signature returns the block value.
    expect(computes[at("$(function*")]).toBe("sync");
    // `createSignal(value)` is a value, not a compute.
    expect(computes[String(source.indexOf("([])") + 1)]).toBe("sync");
    expect(props[at("flag()")]).toBe("sync");
    expect(props[at("rows()}")]).toBe("sync");
  });

  it("--capabilities writes the summary only for a program that typechecks", () => {
    const out = path.join(fixtures, "capabilities/.summary.json");
    fs.rmSync(out, { force: true });
    const code = run(["-p", project("capabilities"), "--capabilities", out], { log: () => {} });
    expect(code).toBe(0);
    const written = JSON.parse(fs.readFileSync(out, "utf8"));
    expect(written.schema).toBe(1);
    fs.rmSync(out);
    const failing = path.join(fixtures, "paths-error/.summary.json");
    expect(run(["-p", project("paths-error"), "--capabilities", failing], { log: () => {} })).toBe(
      1
    );
    expect(fs.existsSync(failing)).toBe(false);
  });
});
