#!/usr/bin/env node
// Frames client link-time switches: differential test (frames/src/features.ts;
// documentation/plans/core-runtime-slicing.md, "Frames client switches") —
// the same protocol as @solidjs/signals' scripts/slices-differential.mjs.
//
//   node scripts/frames-differential.mjs [--out file.json]
//
// 1. Runs the whole frames client suite (every client spec that loads the
//    frames runtime, in the default and hydrate configs) with the census on:
//    each test records the switchable features it touched (markFeature).
// 2. For each switch configuration, runs the suite with those switches off
//    (FRAMES_FEATURES_OFF), skipping the tests the census marked with a
//    switched-off feature (FRAMES_FEATURE_SUBSET).
// 3. Every test that never touched a switched-off feature must pass
//    unchanged — the switch contract. A sensitivity run without the skip
//    counts how many feature-using tests then fail (the switch really
//    removes the behavior).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const outFile = args.includes("--out") ? resolve(args[args.indexOf("--out") + 1]) : null;
const work = join(pkg, "node_modules/.cache/frames-slices");
mkdirSync(work, { recursive: true });
const census = join(work, "census.jsonl");
rmSync(census, { force: true });

export const SWITCHES = [
  "FRAGMENTS",
  "ASSETS",
  "SLOT_DATA",
  "ASYNC_ARGS",
  "CONTAINERS",
  "LIVE_PROPS",
  "SINGLE_FLIGHT",
  "FULL_CODEC",
  "HYDRATION_CLAIMS"
];

// The frames client suite: every client-side spec that loads frames/src.
const SUITES = [
  {
    config: "vite.config.mjs",
    files: [
      "test/frames-",
      "test/lifecycle-matrix",
      "test/preload-links-frame-client.spec.ts",
      "test/runtime/preload-links.spec.js"
    ]
  },
  { config: "vite.config.hydrate.mjs", files: ["test/hydration/adopted-"] },
  // The client half of single flight runs against a real server response.
  { config: "vite.config.server.mjs", files: ["test/server/frames-single-flight-client"] }
];

const CONFIGS = [
  ...SWITCHES.map(s => ({ name: `−${s}`, off: [s] })),
  { name: "−all", off: SWITCHES }
];

const vitest = (env, reporterFile) => {
  const outputs = [];
  SUITES.forEach(({ config, files }, i) => {
    const out = reporterFile && reporterFile.replace(/\.json$/, `.${i}.json`);
    if (out) rmSync(out, { force: true });
    try {
      execFileSync(
        "npx",
        [
          "vitest",
          "run",
          "--config",
          config,
          "--maxWorkers=2",
          ...(out ? ["--reporter=json", `--outputFile=${out}`] : []),
          ...files
        ],
        {
          cwd: pkg,
          env: { ...process.env, ...env },
          stdio: ["ignore", "ignore", "ignore"],
          timeout: 10 * 60_000,
          killSignal: "SIGKILL"
        }
      );
    } catch {
      // Failures are the data.
    }
    if (out) outputs.push(existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null);
  });
  return outputs;
};

vitest({ FRAMES_CENSUS: census });
if (!existsSync(census)) throw new Error("census run produced no results");
const key = (file, name) => `${relative(pkg, file)}::${name}`;
// Per test, the features it touched; and per test, the features touched by
// the tests BEFORE it in its file (`earlier`): specs share module state
// (hydration ledgers, host stores), so skipping an earlier feature-using test
// can move a later one onto a different path. A failure there is a cascade
// of the skip, reported apart from regressions.
const marks = new Map();
const earlier = new Map();
const seenInFile = new Map();
for (const line of readFileSync(census, "utf8").split("\n").filter(Boolean)) {
  const { file, fullName, features = [] } = JSON.parse(line);
  const before = seenInFile.get(file) ?? new Set();
  marks.set(key(file, fullName), features);
  earlier.set(key(file, fullName), [...before]);
  for (const f of features) before.add(f);
  seenInFile.set(file, before);
}
const featureCounts = {};
for (const features of marks.values())
  for (const f of features) featureCounts[f] = (featureCounts[f] ?? 0) + 1;

const results = [];
for (const config of CONFIGS) {
  const base = join(work, `${config.name.replace(/\W+/g, "_")}.json`);
  const runs = vitest(
    { FRAMES_FEATURES_OFF: config.off.join(","), FRAMES_FEATURE_SUBSET: census },
    base
  );
  if (runs.some(r => !r)) throw new Error(`${config.name}: vitest produced no results`);
  let passed = 0,
    skipped = 0;
  const regressions = [];
  const cascades = [];
  for (const run of runs)
    for (const file of run.testResults)
      for (const test of file.assertionResults) {
        const k = key(file.name, test.fullName);
        const m = marks.get(k);
        const touched = !m || m.some(f => config.off.includes(f));
        if (test.status === "passed") passed++;
        else if (test.status === "skipped" || test.status === "pending") skipped++;
        else if (touched) skipped++;
        else if (earlier.get(k)?.some(f => config.off.includes(f))) cascades.push(k);
        else regressions.push(k);
      }
  // Sensitivity: the same switches without the census skip.
  const all = vitest(
    { FRAMES_FEATURES_OFF: config.off.join(",") },
    base.replace(/\.json$/, ".all.json")
  );
  let users = 0,
    failedUsers = 0;
  const hung = all.some(r => !r);
  for (const run of all)
    if (run)
      for (const file of run.testResults)
        for (const test of file.assertionResults) {
          const m = marks.get(key(file.name, test.fullName));
          if (!m || !m.some(f => config.off.includes(f))) continue;
          users++;
          if (test.status === "failed") failedUsers++;
        }
  results.push({
    config: config.name,
    off: config.off,
    passed,
    skipped,
    regressions,
    cascades,
    sensitivity: hung ? { hung: true } : { featureUsers: users, failWithSwitchOff: failedUsers }
  });
  console.log(
    `${config.name}: ${passed} passed, ${skipped} skipped (feature used), ${regressions.length} regressions, ${cascades.length} skip cascades; ` +
      (hung
        ? "the unskipped run hung"
        : `${failedUsers}/${users} feature-using tests fail with the switch off`)
  );
  for (const r of regressions) console.log(`  REGRESSION ${r}`);
  for (const r of cascades)
    console.log(`  cascade (an earlier test in the file used the feature) ${r}`);
}
const report = { tests: marks.size, featureCounts, results };
if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ tests: marks.size, featureCounts }, null, 2));
if (results.some(r => r.regressions.length)) process.exitCode = 1;
