// Snapshot and contract suite for the resumable-events pass (src/resumable.rs).
//
// Locks, for every fixture in __tests__/resumable/fixtures, the SSR output
// (coordinates), the per-module manifest (scopes, handlers with reason-coded
// captures, prelude, snapshot, diagnostics) and the generated event module,
// plus the option contract: off by default, the DOM generate untouched,
// `require`, the hydratable/generators prerequisites, source maps.
//
// Regenerate intentionally with:
//
//   UPDATE_RESUMABLE_FIXTURES=1 pnpm exec vitest run __tests__/resumable-fixtures.test.js

const fs = require("fs");
const path = require("path");
const { transform } = require("..");

const fixtureDir = path.join(__dirname, "resumable", "fixtures");
const update = process.env.UPDATE_RESUMABLE_FIXTURES === "1";

function fixtures() {
  return fs
    .readdirSync(fixtureDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
}

function read(fixture) {
  return fs.readFileSync(path.join(fixtureDir, fixture, "code.tsx"), "utf8");
}

function options(fixture) {
  const file = path.join(fixtureDir, fixture, "options.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function compile(fixture, extra = {}) {
  return transform(read(fixture), {
    filename: `src/${fixture}.tsx`,
    generate: "ssr",
    hydratable: true,
    sourceMap: true,
    resumableEvents: { root: process.cwd() },
    ...options(fixture),
    ...extra
  });
}

function expectSnapshot(fixture, file, actual) {
  const target = path.join(fixtureDir, fixture, file);
  if (update) fs.writeFileSync(target, actual);
  expect(actual).toBe(fs.readFileSync(target, "utf8"));
}

describe("resumable events: fixture snapshots", () => {
  for (const fixture of fixtures()) {
    it(`${fixture}: SSR output`, () => {
      expectSnapshot(fixture, "output.js", compile(fixture).code.trimEnd() + "\n");
    });
    it(`${fixture}: manifest`, () => {
      const { resumable } = compile(fixture);
      const manifest = {
        ...resumable,
        eventModule: resumable.eventModule && { name: resumable.eventModule.name }
      };
      expectSnapshot(fixture, "manifest.json", JSON.stringify(manifest, null, 2) + "\n");
    });
    it(`${fixture}: event module`, () => {
      const { resumable } = compile(fixture);
      const module = resumable.eventModule;
      expectSnapshot(
        fixture,
        "event-module.js",
        module ? module.code.trimEnd() + "\n" : "// no resumable handler\n"
      );
      if (module) {
        expect(module.name).toBe(`src/${fixture}.resume.tsx`);
        expect(module.map.sources).toEqual([`src/${fixture}.tsx`]);
        expect(module.map.sourcesContent[0]).toBe(read(fixture));
        expect(module.map.mappings.length).toBeGreaterThan(0);
      }
    });
    it(`${fixture}: the DOM generate is untouched`, () => {
      const withOption = compile(fixture, { generate: "dom" });
      const without = transform(read(fixture), {
        filename: `src/${fixture}.tsx`,
        generate: "dom",
        hydratable: true
      });
      expect(withOption.code).toBe(without.code);
      expect(withOption.code).not.toContain("_$sr");
      // the manifest and module are still available to tooling
      expect(withOption.resumable.schema).toBe(1);
    });
  }
});

describe("resumable events: option contract", () => {
  it("is off by default: no coordinates, no manifest", () => {
    const result = transform(read("counter"), {
      filename: "src/counter.tsx",
      generate: "ssr",
      hydratable: true
    });
    expect(result.code).not.toContain("_$sr");
    expect(result.resumable).toBeUndefined();
  });

  it("ids are stable across generates and relative to the root", () => {
    const ssr = compile("counter", {
      resumableEvents: { root: "/repo" },
      filename: "/repo/src/counter.tsx"
    });
    const dom = compile("counter", {
      resumableEvents: { root: "/repo" },
      filename: "/repo/src/counter.tsx",
      generate: "dom"
    });
    expect(ssr.resumable.module).toBe(dom.resumable.module);
    expect(ssr.resumable.handlers.map(h => h.id)).toEqual(dom.resumable.handlers.map(h => h.id));
    const other = compile("counter", {
      resumableEvents: { root: "/other" },
      filename: "/other/src/counter.tsx"
    });
    expect(other.resumable.module).toBe(ssr.resumable.module);
    const moved = compile("counter", {
      resumableEvents: { root: "/repo" },
      filename: "/repo/lib/counter.tsx"
    });
    expect(moved.resumable.module).not.toBe(ssr.resumable.module);
  });

  it("the handler source hash changes with the callback text only", () => {
    const base = compile("counter").resumable.handlers[0];
    const edited = transform(read("counter").replace("count() + 1", "count() + 2"), {
      filename: "src/counter.tsx",
      generate: "ssr",
      hydratable: true,
      resumableEvents: true
    }).resumable.handlers[0];
    expect(edited.id).toBe(base.id);
    expect(edited.source).not.toBe(base.source);
    const reformatted = transform(
      read("counter").replace(
        "// one signal, one exact text binding, one handler.",
        "// edited comment"
      ),
      {
        filename: "src/counter.tsx",
        generate: "ssr",
        hydratable: true,
        resumableEvents: true
      }
    ).resumable.handlers[0];
    expect(reformatted.source).toBe(base.source);
  });

  it("`require` fails the build on the first hydrated handler, at its site", () => {
    expect(() => compile("refused", { resumableEvents: { require: true } })).toThrow(
      /\[RESUME_REFUSED\] `clicks` is assigned inside the handler.* \(\d+:\d+\)/
    );
  });

  it("requires generators and, on SSR, hydratable", () => {
    expect(() => compile("counter", { generators: false })).toThrow(/requires `generators: true`/);
    expect(() => compile("counter", { hydratable: false })).toThrow(/requires `hydratable: true`/);
    expect(() => compile("counter", { generate: "dom", hydratable: false })).not.toThrow();
  });

  it("validates the option shape", () => {
    expect(() =>
      compile("counter", {
        resumableEvents: { imports: [{ source: "./a", imported: "b", kind: "action" }] }
      })
    ).toThrow(/an action needs its id/);
    expect(() => compile("counter", { resumableEvents: { nope: true } })).toThrow(
      /unknown resumableEvents option/
    );
    expect(() => compile("counter", { resumableEvents: "yes" })).toThrow(/boolean or an object/);
    expect(compile("counter", { resumableEvents: false }).resumable).toBeUndefined();
  });

  it("an unverified import stays hydrated; a trusted fact admits it", () => {
    const source = `
import { $ } from "solid-js";
import { helper } from "./helper";
export function A() {
  return <button onClick={$(() => helper(1))}>x</button>;
}`;
    const refused = transform(source, {
      filename: "src/a.tsx",
      generate: "ssr",
      hydratable: true,
      resumableEvents: true
    });
    expect(refused.resumable.diagnostics.map(d => [d.status, d.reason])).toEqual([
      ["hydrated", "unresolved-import"],
      ["hydrated", "handler-refused"]
    ]);
    const admitted = transform(source, {
      filename: "src/a.tsx",
      generate: "ssr",
      hydratable: true,
      resumableEvents: { imports: [{ source: "./helper", imported: "helper", kind: "trusted" }] }
    });
    expect(admitted.resumable.diagnostics.map(d => d.status)).toEqual(["resumable"]);
    expect(admitted.resumable.eventModule.code).toContain('import { helper } from "./helper";');
    expect(admitted.resumable.eventModule.code).toContain("actions: {}");
  });

  it("refuses the reasons the design lists", () => {
    const { diagnostics } = compile("refused").resumable;
    const reasons = Object.fromEntries(
      diagnostics.filter(d => d.block).map(d => [d.block, d.reason])
    );
    expect(reasons).toEqual({
      "src/refused.tsx#0": "mutable-closure-state",
      "src/refused.tsx#1": "event-escape",
      "src/refused.tsx#2": "function-capture",
      "src/refused.tsx#3": "signal-not-in-scope",
      "src/refused.tsx#4": "unresolved-import",
      "src/refused.tsx#5": "event-field",
      "src/refused.tsx#6": "event-method-outside-prelude",
      "src/refused.tsx#7": "store-capture",
      "src/refused.tsx#8": "scope-refused",
      "src/refused.tsx#9": "scope-refused",
      "src/refused.tsx#10": "scope-refused"
    });
    const scopes = diagnostics.filter(d => !d.block).map(d => [d.scope, d.reason]);
    expect(scopes).toEqual([
      ["Refused", "handler-refused"],
      ["Dynamic", "template-dynamic:component"],
      ["Escapes", "signal-escapes"]
    ]);
    // every diagnostic points at an authored site
    expect(diagnostics.every(d => d.site.line > 0 && d.site.column > 0)).toBe(true);
  });
});
