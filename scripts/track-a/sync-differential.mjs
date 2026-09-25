#!/usr/bin/env node
// Track A stage 2: differential test of the async-free runtime.
//
//   node scripts/track-a/sync-differential.mjs [--out file.json]
//
// 1. Runs the whole @solidjs/signals suite on the FULL runtime with the async
//    capability census on: every test records whether it touched any async
//    capability (async results, pending status, NotReadyError, transactions,
//    optimistic state, the async-only APIs).
// 2. Runs the same suite compiled as the ASYNC-FREE runtime
//    (`SIGNALS_ASYNC=false`, i.e. `__ASYNC__ = false`) twice:
//    a. everything — async tests are expected to fail there (their capability
//       is gone, often loudly through [ASYNC_IN_SYNC_GRAPH]), and a failing
//       async test can leave state that cascades into later tests of its
//       file;
//    b. the synchronous subset only (census-marked tests skipped).
// 3. Every test that never touched an async capability must pass in (b).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ROOT } from "./compile.mjs";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .split("--")
    .filter(Boolean)
    .map(pair => pair.trim().split(/\s+/))
);
const pkg = join(ROOT, "packages/signals");
const work = join(ROOT, "node_modules/.cache/track-a/differential");
mkdirSync(work, { recursive: true });
const census = join(work, "census.jsonl");
const syncJson = join(work, "sync.json");
const subsetJson = join(work, "sync-subset.json");
rmSync(census, { force: true });

const vitest = (env, extra) => {
  try {
    execFileSync("npx", ["vitest", "run", ...extra], {
      cwd: pkg,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "ignore"]
    });
  } catch {
    // Failures are the data.
  }
};
vitest({ SIGNALS_CENSUS: census }, []);
vitest({ SIGNALS_ASYNC: "false" }, ["--reporter=json", `--outputFile=${syncJson}`]);
vitest({ SIGNALS_ASYNC: "false", SIGNALS_SYNC_SUBSET: census }, [
  "--reporter=json",
  `--outputFile=${subsetJson}`
]);
if (!existsSync(census) || !existsSync(syncJson) || !existsSync(subsetJson))
  throw new Error("vitest produced no results");

const key = (file, name) => `${relative(pkg, file)}::${name}`;
const touched = new Map();
for (const line of readFileSync(census, "utf8").split("\n").filter(Boolean)) {
  const { file, fullName, asyncCapability } = JSON.parse(line);
  touched.set(key(file, fullName), asyncCapability);
}
function rowsOf(file) {
  const rows = [];
  for (const result of JSON.parse(readFileSync(file, "utf8")).testResults) {
    for (const test of result.assertionResults) {
      const k = key(result.name, test.fullName);
      rows.push({ key: k, status: test.status, asyncCapability: touched.get(k) });
    }
  }
  return rows;
}
const all = rowsOf(syncJson);
const subset = rowsOf(subsetJson);
const syncAll = all.filter(r => r.asyncCapability === false);
const asyncAll = all.filter(r => r.asyncCapability === true);
const syncSubset = subset.filter(r => r.asyncCapability === false);
const result = {
  total: all.length,
  census: { synchronousBehaviour: syncAll.length, asyncCapability: asyncAll.length },
  fullSuiteUnderSync: {
    synchronousPassed: syncAll.filter(r => r.status === "passed").length,
    synchronousFailedByCascade: syncAll.filter(r => r.status === "failed").length,
    asyncFailed: asyncAll.filter(r => r.status === "failed").length,
    asyncPassed: asyncAll.filter(r => r.status === "passed").length
  },
  synchronousSubsetUnderSync: {
    total: syncSubset.length,
    passed: syncSubset.filter(r => r.status === "passed").length,
    failed: syncSubset.filter(r => r.status === "failed").length
  },
  unmatched: all
    .filter(r => r.asyncCapability === undefined && r.status !== "skipped")
    .map(r => r.key),
  regressions: syncSubset.filter(r => r.status === "failed").map(r => r.key)
};
const outFile = args.out ?? join(work, "differential.json");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(result, null, 2));
console.log(
  JSON.stringify(
    { ...result, unmatched: result.unmatched.length, regressions: result.regressions },
    null,
    2
  )
);
