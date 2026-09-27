// Print the compiler's output for a source file:
//   node scripts/blocks-v2/show.cjs file.tsx ['{"hostFusion":true}'] [run]
// With `run`, the output (its `@solidjs/signals` import pointed at the
// production build) is also written next to the source as .mjs and executed.
const { join } = require("node:path");
const { writeFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const root = join(__dirname, "../..");
const { transform } = require(join(root, "packages/compiler/index.js"));
const src = require("node:fs").readFileSync(process.argv[2], "utf8");
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
let code;
try {
  code = transform(src, { filename: process.argv[2], ...extra }).code;
  console.log(code);
} catch (e) {
  console.log("ERR", e.message);
  process.exit(1);
}
if (process.argv[4] === "run") {
  const runtime = pathToFileURL(join(root, "packages/signals/dist/prod/index.js")).href;
  const out = process.argv[2].replace(/\.[jt]sx?$/, "") + ".out.mjs";
  writeFileSync(out, code.replaceAll('"@solidjs/signals"', JSON.stringify(runtime)));
  console.log("--- run ---");
  try {
    console.log(execFileSync(process.execPath, [out], { encoding: "utf8" }));
  } catch (e) {
    console.log(e.stdout, e.stderr);
  }
}
