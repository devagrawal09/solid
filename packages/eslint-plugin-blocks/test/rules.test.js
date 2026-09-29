import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { rules, REFUSALS } from "../src/index.js";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: { ecmaFeatures: { jsx: true } },
    ecmaVersion: 2024,
    sourceType: "module"
  }
});

const component = body => `const C = $component(function* () { ${body} });`;

tester.run("no-throw", rules["no-throw"], {
  valid: [
    component("return function* () { return <p />; };"),
    "function* notABlock() { throw new Error('x'); }",
    component(
      "const f = () => { throw new Error('plain callback'); }; return function* () { return <p />; };"
    ),
    "const m = $memo(function* () { try { return 1; } catch (e) { return 2; } });"
  ],
  invalid: [
    {
      code: "const m = $memo(function* () { throw new Error('x'); });",
      errors: [{ messageId: "throw" }]
    },
    {
      code: "const e = $event(function* () { if (x) throw y; });",
      errors: [{ messageId: "throw" }]
    },
    {
      code: component("return function* () { throw new Error('view'); };"),
      errors: [{ messageId: "throw" }]
    },
    {
      code: "const r = <For each={xs}>{function* (x) { throw x; }}</For>;",
      errors: [{ messageId: "throw" }]
    }
  ]
});

tester.run("no-read-outside-hole", rules["no-read-outside-hole"], {
  valid: [
    component(
      "const [n] = yield* $signal(1); return function* () { return <p class={{ a: (yield* n) > 1 }}>{yield* n}</p>; };"
    ),
    component("return function* () { return <section>{yield* Child({})}</section>; };"),
    "const m = $memo(function* () { const v = yield* n; return v; });"
  ],
  invalid: [
    {
      code: component(
        "const [n] = yield* $signal(1); return function* () { const v = yield* n; return <p>{v}</p>; };"
      ),
      errors: [{ messageId: "read" }]
    },
    {
      code: "const r = <For each={xs}>{function* (x) { return function* () { if (yield* x.done) return <i />; return <b />; }; }}</For>;",
      errors: [{ messageId: "read" }]
    },
    {
      code: component("return function* () { const c = yield* Child({}); return c; };"),
      errors: [{ messageId: "child" }]
    }
  ]
});

tester.run("read-before-attempt", rules["read-before-attempt"], {
  valid: [
    "const m = $memo(function* () { const id = yield* props.id; return yield* attempt(() => f(id)); });",
    "const m = $memo(function* () { const u = yield* attempt(() => f()); if (!u) yield* raise(new E()); return u; });",
    "const e = $event(function* () { yield* attempt(() => f()); const v = yield* n; });"
  ],
  invalid: [
    {
      code: "const m = $memo(function* () { const u = yield* attempt(() => f()); return u + (yield* n); });",
      errors: [{ messageId: "after" }]
    }
  ]
});

tester.run("no-write-in-reactive", rules["no-write-in-reactive"], {
  valid: [
    component(
      "const [n, setN] = yield* $signal(1); const inc = $event(function* () { setN(2); }); yield* $effect(function* () { yield* setN(3); }); return function* () { return <p onClick={inc}>{yield* n}</p>; };"
    ),
    component(
      "const [n, setN] = yield* $signal(1); const bump = () => setN(1); return function* () { return <p>{yield* n}</p>; };"
    ),
    "const [a, setA] = createSignal(1); const m = $memo(function* () { return 1; });"
  ],
  invalid: [
    {
      code: component(
        "const [n, setN] = yield* $signal(1); const m = yield* $memo(function* () { setN(2); return yield* n; }); return function* () { return <p>{yield* m}</p>; };"
      ),
      errors: [{ messageId: "write", data: { kind: "a $memo" } }]
    },
    {
      code: component(
        "const [s, setS] = yield* $store({ a: 1 }); setS(d => { d.a = 2; }); return function* () { return <p />; };"
      ),
      errors: [{ messageId: "write", data: { kind: "a setup" } }]
    },
    {
      code: component(
        "const [n, setN] = yield* $signal(1); return function* () { setN(1); return <p />; };"
      ),
      errors: [{ messageId: "write", data: { kind: "a view" } }]
    }
  ]
});

tester.run("typed-props-key", rules["typed-props-key"], {
  valid: [
    'export const UserCard = $component(function* (props: TypedProps<{ user: User }, "UserCard">) { return function* () { return <p />; }; });',
    "const Local = $component(function* (props: TypedProps<{ user: User }>) { return function* () { return <p />; }; });"
  ],
  invalid: [
    {
      code: "export const UserCard = $component(function* (props: TypedProps<{ user: User }>) { return function* () { return <p />; }; });",
      output:
        'export const UserCard = $component(function* (props: TypedProps<{ user: User }, "UserCard">) { return function* () { return <p />; }; });',
      errors: [{ messageId: "key" }]
    },
    {
      code: "const Local = $component(function* (props: TypedProps<{ a: 1 }>) { return function* () { return <p />; }; });",
      options: [{ require: "all" }],
      output:
        'const Local = $component(function* (props: TypedProps<{ a: 1 }, "Local">) { return function* () { return <p />; }; });',
      errors: [{ messageId: "key" }]
    }
  ]
});

// --- the lint's refusals ARE the transform's refusals --------------------------------------------------
const fixtures = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../../compiler/tests/blocks-rule-fixtures.json", import.meta.url)),
    "utf8"
  )
);

tester.run("yield-in-jsx-hole", rules["yield-in-jsx-hole"], {
  valid: fixtures.accepted,
  invalid: fixtures.refused.map(({ code, source }) => ({
    code: source,
    errors: [{ messageId: code }]
  }))
});

describe("transform refusals and lint refusals are the same list", () => {
  const require = createRequire(import.meta.url);
  const { transform } = require("@solidjs/compiler");

  it("the rule's codes are the shared list", () => {
    expect(Object.keys(REFUSALS).sort()).toEqual([...fixtures.refusals].sort());
  });

  // Every case: the compiler throws code X exactly when the lint reports X.
  const cases = [...fixtures.accepted.map(source => ({ source, code: null })), ...fixtures.refused];
  for (const { source, code } of cases) {
    it(`${code ?? "accepted"}: ${source}`, async () => {
      let compiled = null;
      try {
        transform(source, { filename: "case.tsx" });
      } catch (e) {
        compiled = /\[(BLOCKS_[A-Z_]+)\]/.exec(String(e.message))?.[1] ?? "OTHER";
      }
      const { Linter } = await import("eslint");
      const linter = new Linter({ configType: "flat" });
      const messages = linter.verify(source, {
        languageOptions: {
          parser: tsParser,
          parserOptions: { ecmaFeatures: { jsx: true } },
          ecmaVersion: 2024,
          sourceType: "module"
        },
        plugins: { blocks: { rules } },
        rules: { "blocks/yield-in-jsx-hole": "error" }
      });
      const linted = messages.length ? /\[(BLOCKS_[A-Z_]+)\]/.exec(messages[0].message)?.[1] : null;
      expect(linted).toBe(code);
      expect(compiled).toBe(code);
    });
  }
});
