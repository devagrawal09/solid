// Snapshot and contract suite for the strict `$(fn)` callback pass.
//
// Locks the compiled output and the graph summary (`analyzeStrictBlocks`) of
// every fixture in __tests__/strict/fixtures, plus the pass's contract: the
// hosts it recognizes, the diagnostics for what it refuses (with their
// authored positions), preservation of generator blocks, the `strictBlocks`
// sidecar of `transform()`, and source maps for erased markers.
//
// Regenerate intentionally with:
//
//   UPDATE_STRICT_FIXTURES=1 pnpm exec vitest run __tests__/strict-fixtures.test.js

const fs = require("fs");
const path = require("path");
const { transform, analyzeStrictBlocks } = require("..");
const {
  fixtureDir,
  fixtureNames,
  readFixture,
  compileFixture,
  analyzeFixture
} = require("./strict/harness");

const update = process.env.UPDATE_STRICT_FIXTURES === "1";

function expectSnapshot(fixture, file, actual) {
  const target = path.join(fixtureDir, fixture, file);
  if (update) {
    fs.writeFileSync(target, actual);
  }
  expect(actual).toBe(fs.readFileSync(target, "utf8"));
}

describe("strict callback output snapshots", () => {
  for (const fixture of fixtureNames()) {
    it(`${fixture}: compiled output`, () => {
      const result = compileFixture(fixture);
      expectSnapshot(fixture, "output.js", result.code.trimEnd() + "\n");
    });
    it(`${fixture}: graph summary`, () => {
      const analysis = analyzeFixture(fixture);
      expectSnapshot(fixture, "summary.json", JSON.stringify(analysis, null, 2) + "\n");
      // The transform's sidecar is the same analysis (no diagnostics: the
      // transform would have thrown).
      const result = compileFixture(fixture);
      if (analysis.blocks.length) {
        expect(result.strictBlocks).toEqual(analysis);
        expect(result.strictBlocks.diagnostics).toEqual([]);
      } else {
        expect(result.strictBlocks).toBeUndefined();
      }
    });
  }
});

describe("strict callback contract", () => {
  const compile = (code, options = {}) => transform(code, { filename: "src/app.tsx", ...options });
  const fails = (code, options) => {
    try {
      compile(code, options);
    } catch (error) {
      return error.message;
    }
    throw new Error("expected the transform to fail");
  };

  it("erases the marker for every host in every generate mode", () => {
    const source = readFixture("memo-effect-signal");
    for (const generate of ["dom", "ssr", "universal"]) {
      const { code, strictBlocks } = transform(source, { filename: "src/counter.tsx", generate });
      expect(code).not.toMatch(/\$\(\(/);
      // TypeScript syntax survives the transform (the bundler strips it).
      expect(code).toContain("createMemo((prev?: number) => count() * 2 + (prev ?? 0))");
      expect(code).toContain("createSignal(() => count() * 3)");
      expect(code).toContain("createEffect(() => `${double()} ${label()}`");
      expect(code).toContain("const shared = () => label().length;");
      expect(strictBlocks.blocks.map(block => block.host.kind)).toEqual([
        "memo",
        "signal",
        "effect",
        "render-effect",
        "memo",
        "memo"
      ]);
    }
  });

  // The authored source with every `$(…)` marker (and its matching `)`) removed.
  function withoutMarkers(source) {
    let out = "";
    let i = 0;
    while (i < source.length) {
      if (source.startsWith("$(", i)) {
        let depth = 1;
        let j = i + 2;
        while (j < source.length && depth > 0) {
          if (source[j] === "(") depth++;
          else if (source[j] === ")") depth--;
          j++;
        }
        out += withoutMarkers(source.slice(i + 2, j - 1));
        i = j;
      } else {
        out += source[i++];
      }
    }
    return out;
  }

  it("binds erased event handlers exactly like hand-written handlers", () => {
    const { code } = compileFixture("event-handlers");
    const handwritten = transform(withoutMarkers(readFixture("event-handlers")), {
      filename: "src/event-handlers.tsx",
      generate: "dom"
    });
    expect(code).toBe(handwritten.code);
    expect(code).toContain("$$click = increment");
    expect(code).toContain('addEventListener(":reset", () => setCount(0))');
  });

  it("does not touch modules that never import the marker", () => {
    const { code, strictBlocks } = compileFixture("not-solid");
    expect(code).toContain("createMemo($(() => helper(count)))");
    expect(strictBlocks).toBeUndefined();
    const plain =
      'import { createMemo } from "solid-js";\nexport const m = createMemo(() => count());\n';
    expect(transform(plain, { filename: "src/plain.ts" }).strictBlocks).toBeUndefined();
  });

  it("`generators: false` leaves markers to the runtime (which refuses them in dev)", () => {
    const { code, strictBlocks } = compileFixture("memo-effect-signal", { generators: false });
    expect(code).toContain("createMemo($((prev?: number) => count() * 2 + (prev ?? 0)))");
    expect(strictBlocks).toBeUndefined();
  });

  it("preserves generator blocks next to strict markers", () => {
    const { code } = compileFixture("mixed-generator");
    // Generator lowering unchanged: `$` stays, `yield*` becomes `perform`.
    expect(code).toContain("createMemo($(function() {");
    expect(code).toContain("return _$perform(count) * 2;");
    expect(code).toContain("_$perform(write(setCount, c + event.button))");
    expect(code).toContain('_$perform(readStore(props.store, (s) => s.items.join(",")))');
    // Strict markers erased.
    expect(code).toContain("createMemo(() => count() * 2)");
    expect(code).toContain("$$click = () => setCount(0)");
    expect(code).not.toMatch(/\$\(\(\)/);
  });

  describe("diagnostics name the unsupported edge and how to fix it", () => {
    const header =
      'import { $, createMemo, createSignal, createStore, useContext } from "solid-js";\n';

    it("rejects an accessor passed to an unsummarized helper", () => {
      const message = fails(`${header}const [count] = createSignal(1);
const m = createMemo($(() => helper(count)));
`);
      expect(message).toMatch(/\[STRICT_CAPABILITY_ESCAPE\]/);
      expect(message).toMatch(
        /`count` is an accessor and is passed to `helper`, which has no strict summary/
      );
      expect(message).toMatch(/read its value with `count\(\)`/);
      expect(message).toMatch(/\(3:37\)$/);
    });

    it("rejects a store, a setter or props passed to an unsummarized helper", () => {
      expect(
        fails(`${header}const [store] = createStore({ items: [] });
const m = createMemo($(() => summarize(store)));
`)
      ).toMatch(
        /\[STRICT_CAPABILITY_ESCAPE\].*`store` is a store and is passed to `summarize`.*\(3:40\)$/
      );
      expect(
        fails(`${header}const [count, setCount] = createSignal(1);
const h = $(() => register(setCount));
const view = <button onClick={h} />;
`)
      ).toMatch(
        /\[STRICT_CAPABILITY_ESCAPE\].*`setCount` is a setter.*call `setCount\(\.\.\.\)` directly.*\(3:28\)$/
      );
      expect(
        fails(`${header}function View(props) {
  const m = createMemo($(() => merge(props)));
}
`)
      ).toMatch(/\[STRICT_CAPABILITY_ESCAPE\].*`props` is the component's props.*\(3:38\)$/);
      // A path value is data: the read is recorded and the call is unsummarized.
      const { strictBlocks } = compile(`${header}const [store] = createStore({ items: [] });
const m = createMemo($(() => summarize(store.items)));
`);
      expect(strictBlocks.blocks[0].reads).toEqual([
        expect.objectContaining({ kind: "store", root: "store", path: ["items"] })
      ]);
      expect(strictBlocks.blocks[0].calls).toEqual([
        expect.objectContaining({ callee: "summarize" })
      ]);
    });

    it("rejects a closure that captures a setter handed to an unsummarized helper", () => {
      const message = fails(`${header}const [count, setCount] = createSignal(1);
const h = $(() => { setInterval(() => setCount(value => value + 1), 1000); });
const view = <button onClick={h} />;
`);
      expect(message).toMatch(
        /\[STRICT_CAPABILITY_ESCAPE\].*passed to `setInterval`.*captures a capability \(`setCount`\).*\(3:33\)$/
      );
    });

    it("rejects a closure that captures a capability", () => {
      const message = fails(`${header}const [count] = createSignal(1);
const m = createMemo($(() => items.map(item => item + count())));
`);
      expect(message).toMatch(
        /\[STRICT_CAPABILITY_ESCAPE\].*passed to `items\.map`.*captures a capability \(`count`\)/
      );
      expect(message).toMatch(/\(3:40\)$/);
    });

    it("rejects an unsummarized import as an argument", () => {
      const message = fails(`${header}import { config } from "./config";
const [count] = createSignal(1);
const m = createMemo($(() => helper(count(), config)));
`);
      expect(message).toMatch(/\[STRICT_OPAQUE_ARGUMENT\].*`config` is passed to `helper`.*import/);
      expect(message).toMatch(/\(4:46\)$/);
    });

    it("rejects a write inside a reactive host", () => {
      const message = fails(`${header}const [count, setCount] = createSignal(1);
const m = createMemo($(() => { setCount(2); return count(); }));
`);
      expect(message).toMatch(
        /\[STRICT_WRITE_IN_REACTIVE_HOST\].*`setCount` is written inside a `memo` host.*event handler/
      );
      expect(message).toMatch(/\(3:32\)$/);
    });

    it("rejects a reactive read after await", () => {
      const message = fails(`${header}const [id] = createSignal(1);
const [detail] = createSignal("x");
const user = createMemo($(async () => {
  const current = id();
  const loaded = await fetchUser(current);
  return loaded.name + detail();
}));
`);
      expect(message).toMatch(
        /\[STRICT_READ_AFTER_AWAIT\].*`detail\(\)` is read after the first `await`.*read it before the first `await`/
      );
      expect(message).toMatch(/\(7:24\)$/);
    });

    it("rejects owned creation after await as unsupported", () => {
      const message = fails(`${header}const [id] = createSignal(1);
const m = createMemo($(async () => {
  const current = id();
  await load(current);
  const [late] = createSignal(0);
  return late();
}));
`);
      expect(message).toMatch(
        /\[STRICT_CREATION_AFTER_AWAIT\].*`createSignal` is called after an `await`.*does not support/
      );
      expect(message).toMatch(/\(6:18\)$/);
    });

    it("rejects useContext inside a marked callback", () => {
      const message = fails(`${header}const m = createMemo($(() => useContext(Ctx).value));
`);
      expect(message).toMatch(/\[STRICT_CONTEXT_IN_BLOCK\].*component setup.*capture the value/);
      expect(message).toMatch(/\(2:30\)$/);
    });

    it("rejects assignment through a store or props", () => {
      const message = fails(`${header}const [store] = createStore({ user: { name: "" } });
const h = $(() => { store.user.name = "x"; });
const view = <button onClick={h} />;
`);
      expect(message).toMatch(
        /\[STRICT_STORE_ASSIGNMENT\].*`store\.user\.name` assigns through `store`.*setStore/
      );
      expect(message).toMatch(/\(3:21\)$/);
    });

    it("rejects `this` and `arguments`", () => {
      expect(
        fails(`${header}const m = createMemo($(function () { return this.value; }));
`)
      ).toMatch(/\[STRICT_UNSUPPORTED_SYNTAX\].*`this`.*\(2:45\)$/);
      expect(
        fails(`${header}const m = createMemo($(function () { return arguments.length; }));
`)
      ).toMatch(/\[STRICT_UNSUPPORTED_SYNTAX\].*`arguments`.*\(2:45\)$/);
    });

    it("requires one statically known host", () => {
      expect(
        fails(`${header}const [count] = createSignal(1);
const lonely = $(() => count());
`)
      ).toMatch(/\[STRICT_HOST_UNKNOWN\].*`lonely` is never consumed.*\(3:16\)$/);
      expect(
        fails(`${header}const [count] = createSignal(1);
const passed = $(() => count());
register(passed);
`)
      ).toMatch(/\[STRICT_HOST_UNKNOWN\].*`passed` is used here as a value.*\(4:10\)$/);
      expect(
        fails(`${header}const [count] = createSignal(1);
export const exported = $(() => count());
`)
      ).toMatch(/\[STRICT_HOST_UNKNOWN\].*exported marked callback.*\(3:25\)$/);
      expect(
        fails(`${header}const [count] = createSignal(1);
let mutable = $(() => count());
const m = createMemo(mutable);
`)
      ).toMatch(/\[STRICT_HOST_UNKNOWN\].*`let` \/ `var`.*\(3:15\)$/);
      expect(
        fails(`${header}const [count, setCount] = createSignal(1);
const view = <Child onPress={$(() => setCount(2))} />;
`)
      ).toMatch(/\[STRICT_HOST_UNKNOWN\].*`onPress` is a component prop.*\(3:30\)$/);
      expect(
        fails(`${header}const [count] = createSignal(1);
const m = createMemo(() => 1, $(() => count()));
`)
      ).toMatch(/\[STRICT_HOST_UNKNOWN\].*only the first argument of `createMemo`.*\(3:31\)$/);
      expect(
        fails(`${header}const [count] = createSignal(1);
const view = <div>{$(() => count())}</div>;
`)
      ).toMatch(/\[STRICT_HOST_UNKNOWN\].*a JSX child is not a host.*\(3:20\)$/);
    });

    it("rejects a marker used as two host kinds", () => {
      const message = fails(`${header}const [count] = createSignal(1);
const both = $(() => count());
const m = createMemo(both);
const view = <button onClick={both} />;
`);
      expect(message).toMatch(
        /\[STRICT_HOST_AMBIGUOUS\].*`event` host here and as a `memo` host elsewhere.*\(5:31\)$/
      );
    });

    it("reports every diagnostic through analyzeStrictBlocks without throwing", () => {
      const analysis = analyzeStrictBlocks(
        `${header}const [count] = createSignal(1);
const m = createMemo($(() => helper(count)));
const n = $(() => count());
`,
        { filename: "app.tsx" }
      );
      expect(analysis.version).toBe(1);
      expect(analysis.diagnostics.map(d => d.code)).toEqual([
        "STRICT_CAPABILITY_ESCAPE",
        "STRICT_HOST_UNKNOWN"
      ]);
      expect(analysis.blocks.map(b => [b.host.kind, b.completeness])).toEqual([
        ["memo", "unknown"],
        ["unknown", "unknown"]
      ]);
      expect(analysis.blocks[0].escapes).toEqual([
        expect.objectContaining({ kind: "accessor", name: "count" })
      ]);
      // Sites are UTF-16 offsets plus 1-based line/column.
      const start =
        `${header}const [count] = createSignal(1);\nconst m = createMemo($(() => helper(`.length;
      expect(analysis.diagnostics[0].site).toEqual({ start, end: start + 5, line: 3, column: 37 });
    });
  });

  describe("graph summary contract", () => {
    it("distinguishes exact, bounded and untracked reads", () => {
      const analysis = analyzeFixture("memo-effect-signal");
      const [double, , , , picked] = analysis.blocks;
      expect(double.completeness).toBe("exact");
      expect(double.reads).toEqual([
        expect.objectContaining({
          kind: "signal",
          root: "count",
          certainty: "exact",
          tracked: true
        })
      ]);
      expect(picked.completeness).toBe("bounded");
      expect(picked.reads.map(read => [read.root, read.certainty])).toEqual([
        ["count", "exact"],
        ["label", "bounded"]
      ]);
      const events = analyzeFixture("event-handlers").blocks;
      expect(events.every(block => block.host.kind === "event")).toBe(true);
      expect(events.flatMap(block => block.reads).every(read => read.tracked === false)).toBe(true);
      const save = events[1];
      expect(save.async).toBe(true);
      expect(save.writes.map(write => [write.kind, write.target, write.afterAwait])).toEqual([
        ["store", "setStore", true]
      ]);
      expect(save.calls.map(call => call.callee)).toEqual([
        "event.preventDefault",
        "persist",
        "state.saved.push",
        "props.onSaved"
      ]);
    });

    it("records reads before await as tracked and unsummarized calls as bounded", () => {
      const [user] = analyzeFixture("async-memo").blocks;
      expect(user.completeness).toBe("bounded");
      expect(user.reads.map(read => [read.root, read.tracked, read.afterAwait])).toEqual([
        ["userId", true, false],
        ["locale", true, false]
      ]);
      expect(user.awaits).toHaveLength(1);
      expect(user.calls.map(call => [call.callee, call.afterAwait])).toEqual([
        ["fetchUser", false],
        ["formatName", true]
      ]);
    });

    it("records store, prop, alias and structural paths", () => {
      const [summary] = analyzeFixture("store-props").blocks;
      // Evaluation order: `store.items` is walked before its computed key
      // runs; a computed key that is an expression is recorded as `[…]`.
      expect(
        summary.reads.map(read => [
          read.kind,
          read.root,
          read.path.join("."),
          read.access,
          read.certainty
        ])
      ).toEqual([
        ["store", "store", "user.name", "path", "exact"],
        ["store", "store", "items.[…]", "path", "exact"],
        ["signal", "index", "", "path", "exact"],
        ["prop", "props", "filter", "path", "exact"],
        ["store", "store", "items.filter", "structural", "exact"],
        // `current?.name`: a local alias of a path extends it; the optional
        // link makes the read bounded.
        ["store", "store", "items.[…].name", "path", "bounded"],
        ["prop", "props", "selected.id", "path", "exact"]
      ]);
      // The closure's own calls are recorded (it is walked as bounded).
      expect(summary.calls.map(call => call.callee)).toEqual([
        "store.items.filter",
        "item.name.includes"
      ]);
    });

    it("records owned creations, marked inner callbacks and local helpers", () => {
      const analysis = analyzeFixture("nested-creation");
      const [outer, inner] = analysis.blocks;
      expect(inner.host).toEqual(expect.objectContaining({ kind: "memo", factory: "createMemo" }));
      expect(outer.creations.map(creation => [creation.factory, creation.marked])).toEqual([
        ["createSignal", false],
        ["createMemo", true],
        ["onCleanup", false],
        ["onCleanup", false]
      ]);
      const reads = outer.reads.map(read => [read.root, read.tracked, read.certainty]);
      expect(reads).toContainEqual(["source", true, "exact"]);
      expect(reads).toContainEqual(["other", false, "bounded"]);
      // The `onCleanup` closure belongs to the registration: not walked.
      expect(outer.writes).toEqual([]);
      // `describe` is a local helper walked where it is defined; the
      // `setInterval` closure is capability-free and walked as bounded.
      expect(outer.calls.map(call => call.callee)).toEqual(["setInterval", "console.log"]);
    });
  });

  describe("source maps", () => {
    // Minimal VLQ decoder: the generated line of each mapping and its
    // original line, enough to check erased markers keep authored lines.
    function decodeMappings(mappings) {
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      const lines = [];
      let sourceLine = 0;
      for (const [generatedLine, group] of mappings.split(";").entries()) {
        const originals = [];
        for (const segment of group.split(",")) {
          if (!segment) continue;
          const values = [];
          let shift = 0;
          let value = 0;
          for (const char of segment) {
            const digit = chars.indexOf(char);
            value += (digit & 31) << shift;
            if (digit & 32) {
              shift += 5;
            } else {
              values.push(value & 1 ? -(value >> 1) : value >> 1);
              shift = 0;
              value = 0;
            }
          }
          if (values.length >= 3) {
            sourceLine += values[2];
            originals.push(sourceLine + 1);
          }
        }
        lines.push({ generatedLine: generatedLine + 1, originals });
      }
      return lines;
    }

    it("maps an erased callback back to its authored line", () => {
      const source = readFixture("memo-effect-signal");
      const { code, map } = transform(source, {
        filename: "src/counter.tsx",
        generate: "dom",
        sourceMap: true
      });
      const parsed = JSON.parse(map);
      expect(parsed.sources).toEqual(["src/counter.tsx"]);
      const authoredLines = source.split("\n");
      const generatedLines = code.split("\n");
      const mapped = decodeMappings(parsed.mappings);
      for (const needle of [
        "createMemo((prev?: number) => count() * 2",
        "createSignal(() => count() * 3)",
        "const shared = () => label().length;"
      ]) {
        const generatedIndex = generatedLines.findIndex(line => line.includes(needle));
        expect(generatedIndex).toBeGreaterThanOrEqual(0);
        const authoredIndex = authoredLines.findIndex(
          line => line.includes(needle.split("(")[0]) && line.includes("$(")
        );
        expect(authoredIndex).toBeGreaterThanOrEqual(0);
        expect(mapped[generatedIndex].originals).toContain(authoredIndex + 1);
      }
    });
  });
});
