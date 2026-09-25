// Track A stage 2 — async capability census (enabled by SIGNALS_CENSUS=<file>).
// Records, per test, whether it touched any async capability of the full
// runtime (markAsyncCapability, __TEST__ only). The sync-entry differential
// (scripts/track-a/sync-differential.mjs) requires every untouched test to
// pass unchanged under the async-free runtime.
import { appendFileSync } from "node:fs";
import { afterEach, beforeEach } from "vitest";

const out = process.env.SIGNALS_CENSUS!;

beforeEach(() => {
  (globalThis as any).__SOLID_ASYNC_CAPABILITY__ = false;
});

afterEach(ctx => {
  const titles: string[] = [];
  for (let suite: any = ctx.task.suite; suite && suite.type === "suite"; suite = suite.suite) {
    if (suite.name) titles.unshift(suite.name);
  }
  titles.push(ctx.task.name);
  appendFileSync(
    out,
    JSON.stringify({
      file: ctx.task.file?.filepath,
      fullName: titles.join(" "),
      asyncCapability: (globalThis as any).__SOLID_ASYNC_CAPABILITY__ === true
    }) + "\n"
  );
});
