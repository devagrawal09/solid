// The block rule, Babel side: the same accepted / refused fixtures as the
// native compiler (packages/compiler/tests/blocks-rule-fixtures.json).
const babel = require("@babel/core");
const plugin = require("../index");
const fixtures = require("../../compiler/tests/blocks-rule-fixtures.json");

const compile = (code, generate = "dom", extra = {}) =>
  babel.transformSync(code, {
    plugins: [[plugin, { generate, hydratable: generate === "ssr", ...extra }]],
    configFile: false,
    babelrc: false,
    filename: "view.jsx"
  }).code;

describe("block rule (babel)", () => {
  for (const generate of ["dom", "ssr", "universal"]) {
    describe(generate, () => {
      for (const source of fixtures.accepted) {
        test(`accepts ${source}`, () => {
          const code = compile(source, generate);
          const outsideOnly = source.includes("const x = yield* a");
          if (!outsideOnly) expect(code).toMatch(/_\$perform\(/);
          const outside = outsideOnly || source.includes("yield* $signal");
          if (!outside) expect(code).not.toMatch(/yield\*/);
        });
      }
      for (const { code, source } of fixtures.refused) {
        test(`refuses ${code}: ${source}`, () => {
          expect(() => compile(source, generate)).toThrow(code);
        });
      }
    });
  }

  test("the Babel refusal list is the shared list", () => {
    const source = require("fs").readFileSync(
      require.resolve("../src/shared/blocks-rule.ts"),
      "utf8"
    );
    const block = source.slice(
      source.indexOf("export const REFUSALS"),
      source.indexOf("} as const")
    );
    const codes = [...block.matchAll(/^\s+(BLOCKS_[A-Z_]+):/gm)].map(m => m[1]);
    expect(codes.sort()).toEqual([...fixtures.refusals].sort());
  });

  test("imports perform from the blocks module, renamable", () => {
    const src = "function* v() { return <p>{yield* n}</p>; }";
    expect(compile(src)).toMatch(/import \{ perform as _\$perform \} from "@solidjs\/blocks"/);
    expect(compile(src, "dom", { blocksModule: "my-blocks" })).toMatch(/from "my-blocks"/);
  });
});
