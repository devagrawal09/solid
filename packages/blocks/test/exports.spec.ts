// The package's export conditions: a test runner with a DOM (vitest + jsdom)
// resolves with both `node` and `browser`; the client runtime must win there,
// as solid-js's does (the server build skips the client's checks — whole-view
// detection, dev warnings — so a twin's tests would pass against the wrong
// runtime).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Exports = string | { [condition: string]: Exports };

/** Node's algorithm: the first key (in order) whose condition is active. */
function pick(entry: Exports, conditions: Set<string>, key = "default"): string | undefined {
  if (typeof entry === "string") return entry;
  for (const [condition, value] of Object.entries(entry)) {
    if (condition === "types") continue;
    if (condition === "default" || conditions.has(condition)) {
      const found = pick(value, conditions, key);
      if (found) return found;
    }
  }
  return undefined;
}

const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
const solid = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../solid/package.json"), "utf8")
);

it("with both node and browser conditions, the client build wins (as solid-js's does)", () => {
  const jsdom = new Set(["node", "browser", "development", "import"]);
  expect(pick(pkg.exports["."], jsdom)).toBe("./dist/blocks.dev.js");
  expect(pick(solid.exports["."], jsdom)).toMatch(/solid\.dev\.js$/);
  expect(pick(pkg.exports["."], new Set(["node", "import"]))).toBe("./dist/server.js");
  expect(pick(pkg.exports["."], new Set(["browser", "import"]))).toBe("./dist/blocks.js");
});
