#!/usr/bin/env node
// Core runtime slicing: differential test of the link-time feature switches
// (src/core/features.ts; documentation/plans/core-runtime-slicing.md).
//
//   node scripts/slices-differential.mjs [--out file.json]
//
// 1. Runs the whole suite on the FULL runtime with the census on: every test
//    records the async capability (Track A) and every switchable feature it
//    touched (markFeature, __TEST__ only).
// 2. For each slice configuration, runs the suite compiled with those
//    switches off (SIGNALS_FEATURES_OFF; SIGNALS_ASYNC=false for the
//    async-free runtime), skipping the tests the census marked with a
//    switched-off feature (SIGNALS_FEATURE_SUBSET).
// 3. Every test that never touched a switched-off feature must pass
//    unchanged: that is the switch's contract ("only removes code a graph
//    that does not use the feature never reaches").
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outFile = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : null;
const work = join(pkg, "node_modules/.cache/slices");
mkdirSync(work, { recursive: true });
const census = join(work, "census.jsonl");
rmSync(census, { force: true });

const vitest = (env, extra = [], timeout = undefined) => {
  try {
    execFileSync("npx", ["vitest", "run", ...extra], {
      cwd: pkg,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "ignore"],
      timeout,
      killSignal: "SIGKILL"
    });
  } catch {
    // Failures are the data.
  }
};

// OPTIMISTIC off implies VERDICTS off (companions are optimistic nodes).
const CONFIGS = [
  { name: "full −OPTIMISTIC (and VERDICTS)", off: ["OPTIMISTIC", "VERDICTS"] },
  { name: "full −VERDICTS", off: ["VERDICTS"] },
  { name: "full −STORES", off: ["STORES"] },
  { name: "full −SNAPSHOTS", off: ["SNAPSHOTS"] },
  { name: "full −ITERABLE", off: ["ITERABLE"] },
  { name: "full −COMPILED_SEAMS", off: ["COMPILED_SEAMS"] },
  {
    name: "full −all",
    off: ["OPTIMISTIC", "VERDICTS", "STORES", "SNAPSHOTS", "ITERABLE", "COMPILED_SEAMS"]
  },
  { name: "sync −all", off: ["STORES", "SNAPSHOTS", "ITERABLE", "COMPILED_SEAMS"], sync: true }
];

vitest({ SIGNALS_CENSUS: census });
if (!existsSync(census)) throw new Error("census run produced no results");
const key = (file, name) => `${relative(pkg, file)}::${name}`;
const marks = new Map();
for (const line of readFileSync(census, "utf8").split("\n").filter(Boolean)) {
  const { file, fullName, asyncCapability, features = [] } = JSON.parse(line);
  marks.set(key(file, fullName), { asyncCapability, features });
}
const featureCounts = {};
for (const { features } of marks.values())
  for (const f of features) featureCounts[f] = (featureCounts[f] ?? 0) + 1;

const results = [];
for (const config of CONFIGS) {
  const json = join(work, `${config.name.replace(/\W+/g, "_")}.json`);
  rmSync(json, { force: true });
  vitest(
    {
      SIGNALS_FEATURES_OFF: config.off.join(","),
      SIGNALS_FEATURE_SUBSET: census,
      ...(config.sync ? { SIGNALS_ASYNC: "false" } : {})
    },
    ["--reporter=json", `--outputFile=${json}`]
  );
  if (!existsSync(json)) throw new Error(`${config.name}: vitest produced no results`);
  let passed = 0,
    skipped = 0;
  const regressions = [];
  for (const file of JSON.parse(readFileSync(json, "utf8")).testResults) {
    for (const test of file.assertionResults) {
      const k = key(file.name, test.fullName);
      const m = marks.get(k);
      const touched =
        !m || (config.sync && m.asyncCapability) || m.features.some(f => config.off.includes(f));
      if (test.status === "passed") passed++;
      else if (test.status === "skipped" || test.status === "pending") skipped++;
      else if (!touched) regressions.push(k);
      else skipped++;
    }
  }
  // Sensitivity: the same configuration WITHOUT the census skip. Tests that
  // use a switched-off feature should now fail (the switch really removes
  // behaviour); `failedUsers` counts them. Unmarked failures here come from
  // cascades inside a file, which the subset run above rules out.
  const fullJson = json.replace(/\.json$/, ".all.json");
  rmSync(fullJson, { force: true });
  vitest(
    {
      SIGNALS_FEATURES_OFF: config.off.join(","),
      ...(config.sync ? { SIGNALS_ASYNC: "false" } : {})
    },
    ["--reporter=json", `--outputFile=${fullJson}`],
    // A test whose feature is gone may never settle (a store read that now
    // throws inside a promise chain): bound the run and report it as hung.
    10 * 60_000
  );
  let failedUsers = 0,
    users = 0;
  const hung = !existsSync(fullJson);
  if (existsSync(fullJson))
    for (const file of JSON.parse(readFileSync(fullJson, "utf8")).testResults)
      for (const test of file.assertionResults) {
        const m = marks.get(key(file.name, test.fullName));
        if (!m || !m.features.some(f => config.off.includes(f))) continue;
        users++;
        if (test.status === "failed") failedUsers++;
      }
  const row = {
    config: config.name,
    off: config.off,
    passed,
    skipped,
    regressions,
    sensitivity: hung ? { hung: true } : { featureUsers: users, failWithSwitchOff: failedUsers }
  };
  results.push(row);
  console.log(
    `${config.name}: ${passed} passed, ${skipped} skipped (feature used), ${regressions.length} regressions; ` +
      (hung
        ? "the unskipped run hung (a feature-using test never settled)"
        : `${failedUsers}/${users} feature-using tests fail with the switch off`)
  );
  for (const r of regressions) console.log(`  REGRESSION ${r}`);
}
const report = { tests: marks.size, featureCounts, results };
if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ tests: marks.size, featureCounts }, null, 2));
if (results.some(r => r.regressions.length)) process.exitCode = 1;
