// Core runtime slicing — run only the tests a slice must keep passing
// (enabled by SIGNALS_FEATURE_SUBSET=<census.jsonl>, with the switches off in
// SIGNALS_FEATURES_OFF): tests the census marked with any switched-off
// feature (or with the async capability, when SIGNALS_ASYNC=false) are
// skipped, so a test that fails because its feature is gone cannot leave
// state behind that fails the unrelated tests after it in the same file.
import { readFileSync } from "node:fs";
import { beforeEach } from "vitest";

const off = new Set((process.env.SIGNALS_FEATURES_OFF ?? "").split(",").filter(Boolean));
const asyncOff = process.env.SIGNALS_ASYNC === "false";
const skipped = new Set<string>();
for (const line of readFileSync(process.env.SIGNALS_FEATURE_SUBSET!, "utf8").split("\n")) {
  if (!line) continue;
  const { file, fullName, asyncCapability, features = [] } = JSON.parse(line);
  if ((asyncOff && asyncCapability) || features.some((f: string) => off.has(f)))
    skipped.add(`${file}::${fullName}`);
}

beforeEach(ctx => {
  const titles: string[] = [];
  for (let suite: any = ctx.task.suite; suite && suite.type === "suite"; suite = suite.suite) {
    if (suite.name) titles.unshift(suite.name);
  }
  titles.push(ctx.task.name);
  if (skipped.has(`${ctx.task.file?.filepath}::${titles.join(" ")}`)) ctx.skip();
});
