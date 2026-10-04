#!/usr/bin/env node
// Generated the checked-in expected outputs ONCE from the fork's Rust compiler,
// while it still carried the block rule (packages/compiler/src/blocks_rule.rs,
// removed by D-043). Since then the files under this directory are the oracle
// (D-043: "the plugin's checked-in expected outputs become the oracle"); this
// script is kept for provenance and refuses to run against a compiler without
// the rule.
//
//   node test/fixtures/generate.mjs   (from packages/vite-plugin-blocks)
//
// Writes:
//   rule.json                      the rule's cases (from the compiler's
//                                  tests/blocks-rule-fixtures.json) with the
//                                  compiler's refusal message for each refused case
//   compiled/accepted-<n>.<mode>.out   the compiler's output for accepted case n
//   twins/<twin>/<file>            a snapshot of one source file per JSX twin
//   compiled/<twin>.<mode>.out     the compiler's output for that snapshot
// where <mode> is `dom` (default options) or `ssr` (`generate: "ssr"`,
// `hydratable: true`).
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../../..");
const require = createRequire(import.meta.url);
const compiler = require("@solidjs/compiler");

export const MODES = {
  dom: {},
  ssr: { generate: "ssr", hydratable: true }
};

/** One source file per JSX twin: the one with the most holes. */
export const TWIN_SAMPLES = {
  "effect-blocks": "src/checkout.tsx",
  "hackernews-spa-blocks": "src/components/story.tsx",
  "rendering-blocks": "shared/src/components/App.tsx",
  "room-blocks": "src/routes/live.tsx",
  "sierpinski-blocks": "src/app.tsx",
  "todos-blocks": "src/app.tsx"
};

/** The file name the compiler is given for a twin sample (stable across machines). */
export const twinFilename = (twin, file) => `${twin}/${basename(file)}`;

function main() {
  const probe = compiler.transform("function* v() { return <p>{yield* n}</p>; }", {
    filename: "probe.tsx"
  }).code;
  if (!probe.includes("_$perform(n)")) {
    console.error(
      "generate.mjs: the workspace compiler has no block rule (removed by D-043); " +
        "the checked-in outputs are the oracle and are not regenerated."
    );
    process.exit(1);
  }

  const source = JSON.parse(
    readFileSync(join(repo, "packages/compiler/tests/blocks-rule-fixtures.json"), "utf8")
  );
  const compile = (code, filename, mode) =>
    compiler.transform(code, { filename, ...MODES[mode] }).code;

  mkdirSync(join(here, "compiled"), { recursive: true });
  const refused = source.refused.map(({ code, source: src }) => {
    try {
      compiler.transform(src, { filename: "case.tsx" });
    } catch (e) {
      return { code, source: src, error: e.message };
    }
    throw new Error(`the compiler accepted a refused case: ${src}`);
  });
  source.accepted.forEach((src, i) => {
    for (const mode of Object.keys(MODES))
      writeFileSync(
        join(here, `compiled/accepted-${i}.${mode}.out`),
        compile(src, "case.tsx", mode)
      );
  });
  const rule = {
    $comment:
      "The JSX transform's block rule. Generated once by generate.mjs from the fork's Rust compiler (packages/compiler/src/blocks_rule.rs and tests/blocks-rule-fixtures.json, both removed by D-043): `refusals` is exactly the list of codes the rule refuses, `refused[].error` the compiler's message, compiled/accepted-<n>.<mode>.out its output for accepted[n]. The plugin and the ESLint rule `@solidjs/blocks/yield-in-jsx-hole` are tested against this file.",
    version: source.version,
    refusals: source.refusals,
    refused,
    accepted: source.accepted
  };
  writeFileSync(join(here, "rule.json"), JSON.stringify(rule, null, 2) + "\n");

  for (const [twin, file] of Object.entries(TWIN_SAMPLES)) {
    const from = join(repo, "examples", twin, file);
    mkdirSync(join(here, "twins", twin), { recursive: true });
    copyFileSync(from, join(here, "twins", twin, basename(file)));
    const code = readFileSync(from, "utf8");
    for (const mode of Object.keys(MODES))
      writeFileSync(
        join(here, `compiled/${twin}.${mode}.out`),
        compile(code, twinFilename(twin, file), mode)
      );
  }
  console.log("generate.mjs: wrote rule.json, compiled/*.out, twins/*");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
