// The twins through the plugin (Phase 2): the `h` twins have no JSX, so the
// plugin leaves every file alone; for the JSX twins, compiling the plugin's
// output equals what the compiler's own rule produced from the source — the
// compiler's rule is idle once the plugin has run (D-031 note).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { transform } from "../src/index.js";

const require = createRequire(import.meta.url);
const compiler = require("@solidjs/compiler");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const JSX_TWINS = [
  "effect-blocks",
  "hackernews-spa-blocks",
  "rendering-blocks",
  "room-blocks",
  "sierpinski-blocks",
  "todos-blocks"
];
const H_TWINS = ["sierpinski-blocks-h", "todos-blocks-h"];
const MODES = [{}, { generate: "ssr", hydratable: true }, { hydratable: true }];

const sources = twin =>
  existsSync(join(repo, "examples", twin))
    ? execFileSync("git", ["ls-files", `examples/${twin}`], { cwd: repo, encoding: "utf8" })
        .split("\n")
        .filter(f => /\.[mc]?[jt]sx?$/.test(f))
    : [];

describe("the h twins are no-ops", () => {
  for (const twin of H_TWINS) {
    const files = sources(twin);
    it.skipIf(!files.length)(`${twin}: transform() is null for every file`, () => {
      const changed = files.filter(f =>
        transform(readFileSync(join(repo, f), "utf8"), { filename: join(repo, f) })
      );
      expect(changed).toEqual([]);
    });
  }
});

// Only meaningful while the workspace compiler still carries the rule
// (removed by D-043; the checked-in outputs of rule.test.js are the oracle then).
const compilerHasRule = compiler
  .transform("function* v() { return <p>{yield* n}</p>; }", { filename: "probe.tsx" })
  .code.includes("_$perform(n)");

describe.skipIf(!compilerHasRule)("plugin + compiler = compiler alone (the rule idles)", () => {
  for (const twin of JSX_TWINS) {
    const files = sources(twin).filter(f => /\.[jt]sx$/.test(f));
    it.skipIf(!files.length)(`${twin}: every JSX file, dom / ssr / hydratable`, () => {
      let holes = 0;
      for (const f of files) {
        const filename = join(repo, f);
        const source = readFileSync(filename, "utf8");
        // the rule alone: the compiler has no pass for the library's lazy
        const out = transform(source, { filename, lazy: false });
        if (!out) continue;
        holes += out.code.match(/_\$perform\(/g).length;
        for (const mode of MODES) {
          const compile = code => {
            try {
              return compiler.transform(code, { filename, ...mode }).code;
            } catch (e) {
              // e.g. a whole-document Shell compiled for the DOM: both refuse
              return "error";
            }
          };
          expect(compile(out.code), `${f} ${JSON.stringify(mode)}`).toBe(compile(source));
        }
      }
      expect(holes).toBeGreaterThan(0);
    });
  }
});
