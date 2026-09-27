#!/usr/bin/env node
// Dump a fixture bundle (unminified and minified) for diffing slices:
//   node scripts/slices-dump.mjs <fixture> <outfile> [--sync] [--off A,B]
import { writeFileSync } from "node:fs";
import { transformWithEsbuild } from "vite";
import { FIXTURES, measure } from "./slices.mjs";

const [fixture, outfile, ...rest] = process.argv.slice(2);
const sync = rest.includes("--sync");
const off = rest.includes("--off") ? rest[rest.indexOf("--off") + 1].split(",") : [];
const r = await measure(FIXTURES[fixture].replace("SIG", sync ? "sigsrc-sync" : "sigsrc"), {
  asyncCapability: !sync,
  off
});
writeFileSync(outfile, r.code);
const min = await transformWithEsbuild(r.code, "out.js", { minify: true, mangleProps: /^_/ });
writeFileSync(outfile.replace(/\.js$/, ".min.js"), min.code);
console.log(
  `${fixture}${sync ? " (sync)" : ""}${off.length ? ` off=${off}` : ""}: ${r.min} B min, ${r.gz} B gz`
);
