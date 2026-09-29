// Run only the tests a frames-client slice must keep passing
// (FRAMES_FEATURE_SUBSET=<census.jsonl> with FRAMES_FEATURES_OFF): tests the
// census marked with a switched-off feature are skipped, so a test failing
// because its feature is gone cannot leave state behind that fails the
// unrelated tests after it. See frames-features.mjs.
import { readFileSync } from "node:fs";
import { beforeEach } from "vitest";

const off = new Set((process.env.FRAMES_FEATURES_OFF ?? "").split(",").filter(Boolean));
const skipped = new Set<string>();
for (const line of readFileSync(process.env.FRAMES_FEATURE_SUBSET!, "utf8").split("\n")) {
  if (!line) continue;
  const { file, fullName, features = [] } = JSON.parse(line);
  if (features.some((f: string) => off.has(f))) skipped.add(`${file}::${fullName}`);
}

beforeEach(ctx => {
  const titles: string[] = [];
  for (let suite: any = ctx.task.suite; suite && suite.type === "suite"; suite = suite.suite)
    if (suite.name) titles.unshift(suite.name);
  titles.push(ctx.task.name);
  if (skipped.has(`${ctx.task.file?.filepath}::${titles.join(" ")}`)) ctx.skip();
});
