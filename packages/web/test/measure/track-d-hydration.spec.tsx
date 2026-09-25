/**
 * @jsxImportSource @solidjs/web
 * @vitest-environment jsdom
 *
 * Track D measurement: hydration CPU and allocation of harness artifacts
 * against production client builds. Opt-in (`TRACK_D_MEASURE=1`); run via
 * vite.config.measure.mjs after the server harness wrote the artifacts with
 * the same compile settings. Prints one `[track-d measure]` JSON line per
 * scenario with raw samples.
 */
import { expect, test } from "vitest";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV, flush } from "solid-js";
import { hydrate } from "@solidjs/web";
import { scenarios } from "../harness/scenarios.jsx";

const run = process.env.TRACK_D_MEASURE === "1";
const names = (process.env.TRACK_D_SCENARIOS || "authority-bulk").split(",");
const ITERATIONS = Number(process.env.TRACK_D_ITERATIONS || 40);
const WARMUP = 8;
const artifactsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../harness/__artifacts__");
const gc = (globalThis as any).gc as (() => void) | undefined;

function applyChunk(container: HTMLElement, chunk: string, first: boolean) {
  const scriptRe = /<script(?:[^>]*)>([\s\S]*?)<\/script>/g;
  const scripts = [...chunk.matchAll(scriptRe)].map(m => m[1]);
  const stripped = chunk.replace(scriptRe, "");
  if (first) container.innerHTML = stripped;
  else container.insertAdjacentHTML("beforeend", stripped);
  for (const s of scripts) (0, eval)(s);
}

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  return { min: s[0], median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
};

for (const name of names) {
  test.runIf(run)(`measure ${name}`, async () => {
    const scenario = scenarios.find(s => s.name === name)!;
    const { shell, rest } = JSON.parse(readFileSync(resolve(artifactsDir, `${name}.json`), "utf8"));
    const html = shell + rest;
    const ms: number[] = [];
    const bytes: number[] = [];
    for (let i = 0; i < WARMUP + ITERATIONS; i++) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      (globalThis as any)._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
      applyChunk(container, shell, true);
      if (rest) applyChunk(container, rest, false);
      gc?.();
      const heap0 = process.memoryUsage().heapUsed;
      const t0 = performance.now();
      const dispose = hydrate(() => <scenario.App />, container);
      flush();
      const t1 = performance.now();
      const heap1 = process.memoryUsage().heapUsed;
      if (i === WARMUP) expect(container.textContent).toBe(scenario.expectedText);
      dispose();
      container.remove();
      await new Promise(r => setTimeout(r, 0));
      if (i >= WARMUP) {
        ms.push(t1 - t0);
        bytes.push(heap1 - heap0);
      }
    }
    const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
    console.log(
      "[track-d measure] " +
        JSON.stringify({
          scenario: name,
          serverAuthority: process.env.SOLID_SERVER_AUTHORITY !== "0",
          inertRegions: process.env.SOLID_INERT_REGIONS === "1",
          prodBuild: !DEV,
          gc: !!gc,
          iterations: ITERATIONS,
          hydrateMs: stats(ms),
          allocatedBytes: stats(bytes),
          htmlBytes: html.replace(/<script[\s\S]*?<\/script>/g, "").length,
          scriptBytes: scripts.join("").length,
          scriptGzipBytes: gzipSync(scripts.join("")).length,
          htmlGzipBytes: gzipSync(html.replace(/<script[\s\S]*?<\/script>/g, "")).length,
          rawMs: ms.map(v => +v.toFixed(3)),
          rawBytes: bytes
        })
    );
  });
}
