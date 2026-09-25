// Track A stage 2 — run only the synchronous-behaviour subset of the suite
// (enabled by SIGNALS_SYNC_SUBSET=<census.jsonl>): tests the async capability
// census marked are skipped, so an async test that fails under the
// async-free runtime (as it must) cannot leave state behind that fails the
// synchronous tests after it in the same file.
import { readFileSync } from "node:fs";
import { beforeEach } from "vitest";

const asyncTests = new Set<string>();
for (const line of readFileSync(process.env.SIGNALS_SYNC_SUBSET!, "utf8").split("\n")) {
  if (!line) continue;
  const { file, fullName, asyncCapability } = JSON.parse(line);
  if (asyncCapability) asyncTests.add(`${file}::${fullName}`);
}

beforeEach(ctx => {
  const titles: string[] = [];
  for (let suite: any = ctx.task.suite; suite && suite.type === "suite"; suite = suite.suite) {
    if (suite.name) titles.unshift(suite.name);
  }
  titles.push(ctx.task.name);
  if (asyncTests.has(`${ctx.task.file?.filepath}::${titles.join(" ")}`)) ctx.skip();
});
