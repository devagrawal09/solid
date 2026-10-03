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

tester.run("no-dollar-block", rules["no-dollar-block"], {
  valid: [
    component(
      "const d = yield* $memo(function* () { return 1; }); return function* () { return <p>{yield* d}</p>; };"
    ),
    // a `$` that is not the library's (a test helper, jQuery)
    "const $ = s => document.querySelector(s); $('p');",
    "import { $ } from 'jquery'; $('p');"
  ],
  invalid: [
    {
      // a derivation in a setup becomes the setup's $memo; the import follows
      code:
        'import { $, $component } from "@solidjs/blocks";\n' +
        component(
          "const d = $(function* () { return 1; }); return function* () { return <p>{yield* d}</p>; };"
        ),
      output:
        'import { $component, $memo } from "@solidjs/blocks";\n' +
        component(
          "const d = yield* $memo(function* () { return 1; }); return function* () { return <p>{yield* d}</p>; };"
        ),
      errors: [{ messageId: "import" }, { messageId: "derived" }]
    },
    {
      // in a row's setup too (D-030)
      code: "const r = <For each={xs}>{function* (x) { const s = $(function* () { return yield* x.a; }); return function* () { return <i>{yield* s}</i>; }; }}</For>;",
      output:
        "const r = <For each={xs}>{function* (x) { const s = yield* $memo(function* () { return yield* x.a; }); return function* () { return <i>{yield* s}</i>; }; }}</For>;",
      errors: [{ messageId: "derived" }]
    },
    {
      // no-JSX holes: an `h` child, an attribute value, a flow control's source prop
      code: "const v = h('p', { class: $(function* () { return 'a'; }) }, $(function* () { return 1; }), Show({ when: $(function* () { return true; }), children: 'x' }));",
      output:
        "const v = h('p', { class: function* () { return 'a'; } }, function* () { return 1; }, Show({ when: function* () { return true; }, children: 'x' }));",
      errors: [{ messageId: "hole" }, { messageId: "hole" }, { messageId: "hole" }]
    },
    {
      code: "const v = html`<p>${$(function* () { return 1; })}</p>`;",
      output: "const v = html`<p>${function* () { return 1; }}</p>`;",
      errors: [{ messageId: "hole" }]
    },
    {
      // rows: `$(function* (item) …)` and `$scope(fn)` are the bare function*
      code: 'import { $, $scope, For } from "@solidjs/blocks";\nconst a = <For each={xs}>{$(function* (x) { return function* () { return <i />; }; })}</For>;\nconst b = <For each={xs}>{$scope(row)}</For>;',
      output:
        'import { For } from "@solidjs/blocks";\nconst a = <For each={xs}>{function* (x) { return function* () { return <i />; }; }}</For>;\nconst b = <For each={xs}>{row}</For>;',
      errors: [
        { messageId: "import" },
        { messageId: "import" },
        { messageId: "row" },
        { messageId: "row" }
      ]
    },
    {
      // no fix where no form is equivalent: a module-level source, a JSX child
      code: 'import { $ } from "@solidjs/blocks";\nconst NOBODY = $(function* () { return null; });',
      output: null,
      errors: [{ messageId: "import" }, { messageId: "other" }]
    },
    {
      code: component("return function* () { return <p>{$(function* () { return 1; })}</p>; };"),
      output: null,
      errors: [{ messageId: "other" }]
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

tester.run("no-unyielded-write", rules["no-unyielded-write"], {
  valid: [
    component(
      "const [n, setN] = yield* $signal(1); const inc = $event(function* () { yield* setN(2); }); yield* $effect(function* () { const v = yield* setN(3); }); return function* () { return <p onClick={inc}>{yield* n}</p>; };"
    ),
    component(
      "const [s, setS] = yield* $optimisticStore({ a: 1 }); const go = $event(function* () { yield* setS(d => { d.a = 2; }); }); return function* () { return <p onClick={go} />; };"
    ),
    // not a block setter: plain code is no-foreign-reactive's concern
    "const [a, setA] = createSignal(1); setA(2);"
  ],
  invalid: [
    {
      code: component(
        "const [n, setN] = yield* $signal(1); const inc = $event(function* () { setN(2); }); return function* () { return <p onClick={inc} />; };"
      ),
      errors: [{ messageId: "unyielded", data: { name: "setN" } }]
    },
    {
      code: component(
        "const [s, setS] = yield* $store({ a: 1 }); setS(d => { d.a = 2; }); return function* () { return <p />; };"
      ),
      errors: [{ messageId: "unyielded", data: { name: "setS" } }]
    },
    {
      code: component(
        "const [n, setN] = yield* $optimistic(1); const bump = () => setN(1); return function* () { return <p />; };"
      ),
      errors: [{ messageId: "unyielded", data: { name: "setN" } }]
    },
    {
      code: component(
        "const [n, setN] = yield* $signal(1); const go = $event(function* () { yield setN(1); }); return function* () { return <p onClick={go} />; };"
      ),
      errors: [{ messageId: "unyielded", data: { name: "setN" } }]
    }
  ]
});

tester.run("no-foreign-reactive", rules["no-foreign-reactive"], {
  valid: [
    'import { $signal, $optimisticStore, until, refresh } from "@solidjs/blocks";',
    'import { lazy, createUniqueId, onCleanup } from "solid-js";',
    'import { query, useNavigate } from "@solidjs/router";',
    'import type { Accessor } from "solid-js";',
    'import { type Signal } from "solid-js";'
  ],
  invalid: [
    {
      code: 'import { createSignal, createOptimisticStore } from "solid-js";',
      errors: [
        {
          messageId: "foreign",
          data: { name: "createSignal", source: "solid-js", hint: " Use `$signal`." }
        },
        {
          messageId: "foreign",
          data: {
            name: "createOptimisticStore",
            source: "solid-js",
            hint: " Use `$optimisticStore`."
          }
        }
      ]
    },
    {
      code: 'import { useLocation as loc } from "@solidjs/router";',
      errors: [{ messageId: "foreign" }]
    },
    {
      code: 'import { dynamic } from "@solidjs/web";',
      errors: [
        {
          messageId: "foreign",
          data: { name: "dynamic", source: "@solidjs/web", hint: " Use `$dynamic`." }
        }
      ]
    },
    {
      code: 'import { flush } from "solid-js";',
      errors: [{ messageId: "foreign", data: { name: "flush", source: "solid-js", hint: "" } }]
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

// --- with type information -----------------------------------------------------------
const typedFixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
const typedTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaFeatures: { jsx: true },
      projectService: true,
      tsconfigRootDir: typedFixtures
    },
    ecmaVersion: 2024,
    sourceType: "module"
  }
});
const filename = `${typedFixtures}/file.tsx`;
const decls = `
interface Yieldable<Y, R> { [Symbol.iterator](): Generator<Y, R, any>; }
interface EventCall<R> extends Promise<R>, Yieldable<unknown, R> { readonly __call: true }
declare function $event<A extends unknown[]>(f: (...a: A) => Generator<unknown, unknown, unknown>): (...a: A) => EventCall<void>;
declare function attempt<T>(f: () => T): Yieldable<unknown, T>;
declare function start(c: EventCall<unknown>): Yieldable<unknown, void>;
declare const actions: { save: (x: number) => EventCall<void> };
`;
typedTester.run("no-unyielded-write (with types)", rules["no-unyielded-write"], {
  valid: [
    {
      filename,
      code:
        decls +
        "const e = $event(function* () { yield* actions.save(1); yield* start(actions.save(2)); });"
    },
    // plain code calls an event: it runs (a DOM dispatch, a timer, a callback)
    { filename, code: decls + "const e = $event(function* () {}); e();" },
    // a call kept for later is not discarded
    {
      filename,
      code: decls + "const e = $event(function* () { const call = actions.save(1); yield* call; });"
    }
  ],
  invalid: [
    {
      filename,
      code: decls + "const e = $event(function* () { actions.save(1); });",
      errors: [{ messageId: "eventCall" }]
    },
    {
      filename,
      code: decls + "const e = $event(function* () { void actions.save(1); });",
      errors: [{ messageId: "eventCall" }]
    },
    {
      filename,
      code: decls + "const e = $event(function* () { actions.save(1).catch(() => {}); });",
      errors: [{ messageId: "eventCall" }]
    },
    {
      filename,
      code: decls + "const e = $event(function* () { attempt(() => 1); });",
      errors: [{ messageId: "discarded" }]
    },
    {
      filename,
      code: decls + "function* helper() { yield 1; } const e = $event(function* () { helper(); });",
      errors: [{ messageId: "discarded" }]
    }
  ]
});
