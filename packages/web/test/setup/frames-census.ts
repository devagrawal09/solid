// Frames client switch census (FRAMES_CENSUS=<file>): which switchable
// features of the frames client each test touched (markFeature in
// frames/src). See frames-features.mjs.
import { appendFileSync } from "node:fs";
import { afterEach, beforeEach } from "vitest";

const out = process.env.FRAMES_CENSUS!;

const fullName = (ctx: any) => {
  const titles: string[] = [];
  for (let suite: any = ctx.task.suite; suite && suite.type === "suite"; suite = suite.suite)
    if (suite.name) titles.unshift(suite.name);
  titles.push(ctx.task.name);
  return titles.join(" ");
};

beforeEach(() => {
  (globalThis as any).__FRAMES_CENSUS__ = new Set<string>();
});

afterEach(ctx => {
  appendFileSync(
    out,
    JSON.stringify({
      file: ctx.task.file?.filepath,
      fullName: fullName(ctx),
      features: [...((globalThis as any).__FRAMES_CENSUS__ ?? [])]
    }) + "\n"
  );
});
