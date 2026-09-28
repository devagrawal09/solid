// Generator blocks v2: cross-module helper summaries (helpers-build.js,
// documentation/plans/blocks-v2-performance.md section 11). An exported
// helper generator gains a lowered twin listed in the module's
// `helperSummary`; an importer compiled with that summary calls the twin
// where its host admits the helper's operations.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { transform } = require("..");
const { summarizeHelperGraph } = require("../helpers-build.js");

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "solid-helpers-"));
  for (const [name, code] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), code);
  }
  const resolve = async (source, importer) => {
    if (!source.startsWith(".")) return null;
    const base = path.resolve(path.dirname(importer), source);
    for (const ext of ["", ".tsx", ".ts", ".js"]) {
      if (fs.existsSync(base + ext) && fs.statSync(base + ext).isFile()) return base + ext;
    }
    return null;
  };
  return { root, resolve, file: name => path.join(root, name) };
}

const FILES = {
  "src/theme.ts": `import { createContext } from "solid-js";
export const Theme = createContext("light");
`,
  "src/state.ts": `import { $signal, $memo } from "solid-js";
import { Theme } from "./theme";
export function* useCounter(start: number) {
  const [count, setCount] = yield* $signal(start);
  const doubled = yield* $memo(function* () {
    return (yield* count) * 2;
  });
  return { count, doubled, inc: () => setCount(c => c + 1) };
}
`,
  // Re-exports a composed helper: its twin calls the imported twin.
  "src/use.ts": `import { $signal } from "solid-js";
import { useCounter } from "./state";
export function* useTwo() {
  const a = yield* useCounter(1);
  const b = yield* useCounter(2);
  return [a, b];
}
`,
  "src/app.tsx": `import { $component, $memo } from "solid-js";
import { useCounter } from "./state";
import { useTwo } from "./use";
export const App = $component(function* () {
  const counter = yield* useCounter(1);
  const [a, b] = yield* useTwo();
  const m = yield* $memo(function* () {
    return yield* useCounter(3);
  });
  return function* () {
    return <p>{yield* counter.doubled}</p>;
  };
});
`
};

describe("helper summaries", () => {
  it("summarize the graph in post-order and lower importers to the twins", async () => {
    const { resolve, file } = project(FILES);
    const summaries = await summarizeHelperGraph({ entries: [file("src/app.tsx")], resolve });
    expect(summaries[file("src/state.ts")]).toEqual({
      useCounter: { lowered: "useCounter$lowered", hosts: ["setup"] }
    });
    // Its twin calls the imported twin: the summary of ./state was known.
    expect(summaries[file("src/use.ts")]).toEqual({
      useTwo: { lowered: "useTwo$lowered", hosts: ["setup"] }
    });
    expect(summaries[file("src/app.tsx")]).toBeUndefined();
    const use = transform(fs.readFileSync(file("src/use.ts"), "utf8"), {
      filename: file("src/use.ts"),
      helperSummaries: summaries
    }).code;
    expect(use).toContain("export function* useTwo()");
    expect(use).toMatch(
      /export function useTwo\$lowered\(\) \{\s*const a = _\$useCounter\$lowered\(1\);/
    );
    expect(use).toContain(
      'import { useCounter, useCounter$lowered as _$useCounter$lowered } from "./state";'
    );
    const app = transform(fs.readFileSync(file("src/app.tsx"), "utf8"), {
      filename: file("src/app.tsx"),
      helperSummaries: summaries
    }).code;
    expect(app).toContain("const counter = _$useCounter$lowered(1);");
    expect(app).toContain("const [a, b] = _$useTwo$lowered();");
    // A memo may not create: that site keeps the generator.
    expect(app).toContain("_$perform(useCounter(3))");
    // Server output lowers the same sites (hydration ids stay aligned).
    const ssr = transform(fs.readFileSync(file("src/app.tsx"), "utf8"), {
      filename: file("src/app.tsx"),
      generate: "ssr",
      hydratable: true,
      helperSummaries: summaries
    }).code;
    expect(ssr).toContain("const counter = _$useCounter$lowered(1);");
  });

  it("the options the application compiles with decide the summaries", async () => {
    const { resolve, file } = project(FILES);
    // No v2 lowering, no twins: nothing to summarize, importers keep the
    // generators.
    const summaries = await summarizeHelperGraph({
      entries: [file("src/app.tsx")],
      resolve,
      compile: { hostFusion: false }
    });
    expect(summaries).toEqual({});
  });

  it("validates the option", () => {
    expect(() =>
      transform("export const x = 1;", { helperSummaries: { "./a": { h: { lowered: 1 } } } })
    ).toThrow(/helperSummaries/);
  });
});
