// Harness for the `$()` generator-computation lowering (src/generators.rs).
//
// The pass runs inside `transform()` ahead of JSX lowering, so fixtures are
// compiled through the ordinary entry point; each fixture directory holds
// `code.{js,jsx,ts,tsx}`, an optional `options.json` merged over the DOM
// defaults, and the committed `output.js` snapshot.

const fs = require("fs");
const path = require("path");

const compilerDir = path.resolve(__dirname, "../..");
const { transform } = require(compilerDir);

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
  throw new Error(`No code.{js,ts,jsx,tsx} for generators fixture ${fixture}`);
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

module.exports = {
  fixtureDir,
  fixtureNames,
  readFixture,
  compileFixture
};
