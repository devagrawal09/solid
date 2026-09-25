// Harness for the strict `$(fn)` callback pass (src/strict.rs).
//
// The pass runs inside `transform()` ahead of the generator lowering and JSX
// lowering, so fixtures compile through the ordinary entry point. Each
// fixture directory holds `code.{js,jsx,ts,tsx}`, an optional `options.json`
// merged over the DOM defaults, the committed `output.js` snapshot, and the
// committed `summary.json` snapshot of `analyzeStrictBlocks` (the graph
// contract solid-tsc and editor tooling consume).

const fs = require("fs");
const path = require("path");

const compilerDir = path.resolve(__dirname, "../..");
const { transform, analyzeStrictBlocks } = require(compilerDir);

const fixtureDir = path.join(__dirname, "fixtures");

function fixtureNames() {
  return fs
    .readdirSync(fixtureDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith("."))
    .map(entry => entry.name)
    .sort();
}

function fixtureSourceFile(fixture) {
  for (const name of ["code.js", "code.ts", "code.jsx", "code.tsx"]) {
    const file = path.join(fixtureDir, fixture, name);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`No code.{js,ts,jsx,tsx} for strict fixture ${fixture}`);
}

function fixtureId(fixture) {
  return `src/${fixture}${path.extname(fixtureSourceFile(fixture))}`;
}

function readFixture(fixture) {
  return fs.readFileSync(fixtureSourceFile(fixture), "utf8");
}

function readOptions(fixture) {
  const file = path.join(fixtureDir, fixture, "options.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}

function compileFixture(fixture, extra = {}) {
  return transform(readFixture(fixture), {
    filename: fixtureId(fixture),
    generate: "dom",
    ...readOptions(fixture),
    ...extra
  });
}

function analyzeFixture(fixture) {
  return analyzeStrictBlocks(readFixture(fixture), { filename: fixtureId(fixture) });
}

module.exports = {
  fixtureDir,
  fixtureNames,
  fixtureId,
  readFixture,
  compileFixture,
  analyzeFixture
};
