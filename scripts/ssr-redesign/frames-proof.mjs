#!/usr/bin/env node
// The frames client switches an example needs, proven from its modules'
// compiled SERVER output (the Solid compiler's `generate: "ssr"` output of
// every src module; @solidjs/compiler/capabilities, proveFramesFeatures —
// the proof the capability linker's server build writes).
//
//   node scripts/ssr-redesign/frames-proof.mjs [example …]   (default: hackernews chat notes)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const { transform } = require(join(repo, "packages/compiler/index.js"));
const { proveFramesFeatures, FRAMES_SWITCHES } = require(
  join(repo, "packages/compiler/capabilities.js")
);

const walk = dir =>
  readdirSync(dir).flatMap(name => {
    const file = join(dir, name);
    return statSync(file).isDirectory() ? walk(file) : /\.[jt]sx?$/.test(name) ? [file] : [];
  });

const examples = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["hackernews", "chat", "notes"];
for (const example of examples) {
  const root = join(repo, "examples", example);
  const modules = walk(join(root, "src")).map(file => {
    let code = null;
    try {
      code = transform(readFileSync(file, "utf8"), {
        filename: file,
        generate: "ssr",
        hydratable: true
      }).code;
    } catch {}
    return { rel: relative(root, file), code };
  });
  const features = proveFramesFeatures({ modules });
  const off = FRAMES_SWITCHES.filter(f => !features[f].on);
  console.log(`\n${example}: ${modules.length} modules; off: ${off.join(", ") || "none"}`);
  for (const f of FRAMES_SWITCHES)
    if (features[f].on) console.log(`  ${f}: ${features[f].because.slice(0, 2).join("; ")}`);
}
