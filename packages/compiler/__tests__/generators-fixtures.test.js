// Snapshot suite for the `$()` block lowering.
//
// Locks the raw native output for every fixture in
// __tests__/generators/fixtures, plus the pass's contract: the `generators`
// option, the non-DOM generate modes, and the compile-time diagnostics for
// constructs a block forbids.
//
// Regenerate intentionally with:
//
//   UPDATE_GENERATORS_FIXTURES=1 pnpm exec vitest run __tests__/generators-fixtures.test.js

const fs = require("fs");
const path = require("path");
const { transform } = require("..");
const { fixtureDir, fixtureNames, readFixture, compileFixture } = require("./generators/harness");

const update = process.env.UPDATE_GENERATORS_FIXTURES === "1";

function expectSnapshot(fixture, actual) {
  const file = path.join(fixtureDir, fixture, "output.js");
  if (update) {
    fs.writeFileSync(file, actual);
  }
  expect(actual).toBe(fs.readFileSync(file, "utf8"));
}

describe("block lowering output snapshots", () => {
  for (const fixture of fixtureNames()) {
    it(fixture, () => {
      const result = compileFixture(fixture);
      expectSnapshot(fixture, result.code.trimEnd() + "\n");
    });
  }
});

describe("block lowering contract", () => {
  const source = readFixture("jsx-child");

  it("is on by default and lowers ahead of every generate mode", () => {
    for (const generate of ["dom", "ssr", "universal"]) {
      const { code } = transform(source, { filename: "src/view.jsx", generate });
      expect(code).not.toMatch(/yield\*/);
      expect(code).not.toContain("$(function*");
      // `props.theme` is a path read of the component's props.
      expect(code).toContain('_$perform(_$readProp(props, ["theme"]))');
      expect(code).toContain("_$perform(count)");
      expect(code).toContain(
        'import { $, createSignal, perform as _$perform, readPath as _$readPath, readProp as _$readProp } from "solid-js";'
      );
    }
  });

  it("`generators: false` leaves `$` calls to the runtime driver", () => {
    const { code } = transform(readFixture("memo-effect"), {
      filename: "src/memo-effect.jsx",
      generators: false
    });
    expect(code).toContain("$(function* (prev) {");
    expect(code).toContain("const c = yield* count;");
    expect(code).not.toContain("_$perform");
  });

  it("a JSX yield is not a usable program without the pass", () => {
    // The JSX transform hoists dynamic expressions into arrow functions,
    // where `yield` is a syntax error (the attribute here), and a child
    // yield that happens to stay inline reads once per run instead of
    // fine-grained — which is why JSX yields are a compiler-only spelling.
    const { code } = transform(source, { filename: "src/view.jsx", generators: false });
    expect(code).toMatch(/\(\) => _\$readShallow\(yield\* props\.theme\)/);
    expect(code).toContain("_$insert(_el$, yield* count, null);");
  });

  it("does not disturb modules that never import `$`", () => {
    const plain =
      'import { createMemo } from "solid-js";\nexport const v = createMemo(function* () { yield* count; throw new Error("x"); });\n';
    const { code } = transform(plain, { filename: "src/plain.js" });
    expect(code).toContain("function* () {");
    expect(code).toContain("yield* count;");
    expect(code).toContain('throw new Error("x")');
  });

  describe("diagnostics", () => {
    const compile = code => () => transform(code, { filename: "src/block.jsx" });

    it("rejects `throw` inside a block body", () => {
      expect(
        compile(`import { $ } from "solid-js";
const a = $(function* () {
  if (yield* flag) throw new Error("no");
  return 1;
});
`)
      ).toThrow(/\[THROW_IN_BLOCK\].*yield\* raise\(error\).*\(3:20\)/);
    });

    it("rejects a bare `yield`", () => {
      expect(
        compile(`import { $ } from "solid-js";
const a = $(function* () { const c = yield count; return c; });
`)
      ).toThrow(/\[PLAIN_YIELD_IN_BLOCK\].*\(2:38\)/);
    });

    it("rejects async generators (await)", () => {
      expect(
        compile(`import { $ } from "solid-js";
const a = $(async function* () { return await fetchIt(); });
`)
      ).toThrow(/\[ASYNC_GENERATOR_IN_BLOCK\].*yield\* wait\(promise\)/);
    });

    it("rejects a yield* inside JSX when the block cannot be lowered", () => {
      expect(
        compile(`import { $, wait } from "solid-js";
const view = $(function* () {
  return <p>{(yield* wait(fetchUser(1))).name}</p>;
});
`)
      ).toThrow(/\[JSX_YIELD_IN_UNLOWERED_BLOCK\].*may only read signals.*\(3:15\)/);
      // Outside the JSX the wait is fine: the block stays with the runtime driver.
      const { code } = transform(
        `import { $, wait } from "solid-js";
const view = $(function* () { const u = yield* wait(fetchUser(1)); return <p>{u.name}</p>; });
`,
        { filename: "src/block.jsx" }
      );
      expect(code).toContain("yield* wait(fetchUser(1))");
    });

    it("leaves throws in nested functions and in non-block generators alone", () => {
      const { code } = transform(
        `import { $ } from "solid-js";
function* plain() { throw new Error("mine"); }
const a = $(function* () {
  const check = () => { throw new Error("mine"); };
  return yield* count;
});
`,
        { filename: "src/block.jsx" }
      );
      expect(code).toContain("_$perform(count)");
      expect(code.match(/throw new Error\("mine"\)/g)).toHaveLength(2);
    });
  });

  it("validates the option type through the JS entry", () => {
    expect(() => transform("const a = 1;", { filename: "a.js", generators: false })).not.toThrow();
    expect(() => transform("const a = 1;", { filename: "a.js", generatorz: false })).toThrow(
      /unknown option `generatorz`/
    );
  });
});

describe("host fusion contract", () => {
  const memoEffectSource = readFixture("fusion-memo-effect");

  it("erases $() wrapper and perform calls when consumed by createMemo/createEffect", () => {
    const { code } = transform(memoEffectSource, { filename: "src/test.js", hostFusion: true });
    // $ wrapper erased: createMemo/createEffect receive plain functions
    expect(code).toContain("createMemo(function(prev) {");
    expect(code).toContain("createEffect(function() {");
    expect(code).not.toMatch(/createMemo\(\$\(function/);
    expect(code).not.toMatch(/createEffect\(\$\(function/);
    // perform erased: direct accessor calls
    expect(code).toContain("const c = count();");
    expect(code).toContain("double()");
    expect(code).toContain("label()");
    expect(code).not.toContain("_$perform(count)");
    expect(code).not.toContain("_$perform(double)");
    expect(code).not.toContain("_$perform(label)");
  });

  it("erases path reads to member expressions", () => {
    const { code } = transform(readFixture("fusion-paths"), {
      filename: "src/test.js",
      hostFusion: true
    });
    // The member chain is the tracked walk; `readValue` keeps the one step
    // the chain cannot express (reading through an accessor or block found
    // at the path).
    expect(code).toContain("return _$readValue(store.user.name);");
    expect(code).toContain("return _$readValue(props.count);");
    expect(code).not.toContain("_$readPath(");
    expect(code).not.toContain("_$readProp(");
    expect(code).not.toContain("_$perform(");
  });

  it("does NOT fuse standalone blocks (no known host)", () => {
    const { code } = transform(readFixture("fusion-bail-standalone"), {
      filename: "src/test.js",
      hostFusion: true
    });
    // $ wrapper and perform must remain
    expect(code).toContain("$(function() {");
    expect(code).toContain("_$perform(count)");
  });

  it("is off by default even when generators are on", () => {
    const { code } = transform(memoEffectSource, { filename: "src/test.js" });
    // Without hostFusion, $ wrapper and perform stay
    expect(code).toContain("$(function(prev) {");
    expect(code).toContain("_$perform(count)");
  });

  it("produces identical output to non-fused when consumed by the same host", () => {
    // Verify the fused createMemo output is a plain function, not a block
    const fused = transform(memoEffectSource, { filename: "src/test.js", hostFusion: true });
    const unfused = transform(memoEffectSource, { filename: "src/test.js", hostFusion: false });
    // Fused output should be strictly smaller (no $(), no _$perform())
    expect(fused.code.length).toBeLessThan(unfused.code.length);
    // Both should still have createMemo and createEffect
    expect(fused.code).toContain("createMemo(");
    expect(fused.code).toContain("createEffect(");
    expect(unfused.code).toContain("createMemo(");
    expect(unfused.code).toContain("createEffect(");
  });
});
