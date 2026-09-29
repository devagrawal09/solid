// The block rule of the JSX transform: `yield*` inside a JSX expression or
// attribute value becomes `perform(…)`; the refused positions are exactly
// tests/blocks-rule-fixtures.json (shared with the Babel plugin and the
// ESLint rule).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { transform } = require("../index.js");
const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../tests/blocks-rule-fixtures.json", import.meta.url)),
    "utf8"
  )
);

const compile = (code, generate = "dom", extra = {}) =>
  transform(code, { filename: "view.tsx", generate, hydratable: generate === "ssr", ...extra })
    .code;

describe("block rule", () => {
  for (const generate of ["dom", "ssr", "universal"]) {
    describe(generate, () => {
      for (const source of fixtures.accepted) {
        it(`accepts ${source}`, () => {
          const code = compile(source, generate);
          const outsideOnly = source.includes("const x = yield* a");
          // every yield* that sat in a JSX hole is now a perform call
          if (!outsideOnly) expect(code).toMatch(/_\$perform\(/);
          // a yield* outside JSX, or in a nested function*'s setup, is untouched
          const outside = outsideOnly || source.includes("yield* $signal");
          if (!outside) expect(code).not.toMatch(/yield\*/);
        });
      }
      for (const { code, source } of fixtures.refused) {
        it(`refuses ${code}: ${source}`, () => {
          expect(() => compile(source, generate)).toThrow(code);
        });
      }
    });
  }

  it("the refusal list is closed", () => {
    const seen = new Set(fixtures.refused.map(f => f.code));
    expect([...seen].sort()).toEqual([...fixtures.refusals].sort());
  });

  it("imports perform from the blocks module, renamable", () => {
    const src = "function* v() { return <p>{yield* n}</p>; }";
    expect(compile(src)).toContain('import { perform as _$perform } from "@solidjs/blocks"');
    expect(compile(src, "dom", { blocksModule: "my-blocks" })).toContain(
      'import { perform as _$perform } from "my-blocks"'
    );
  });

  it("the view has no yield left and each read is its own hole", () => {
    const code = compile(
      "const V = function* () { return <p class={{ big: (yield* n) > 3 }}>Hello {(yield* user).name}</p>; };"
    );
    expect(code).toContain("_$perform(user).name");
    expect(code).toMatch(/_\$effect\(|_\$insert\(/);
    expect(code).not.toContain("yield");
  });
});
