import { defineConfig } from "vitest/config";
import codspeedPlugin from "@codspeed/vitest-plugin";

// Vitest sets mode to "benchmark" for `vitest bench`. Benchmarks measure dev
// semantics but must not pay the __TEST__-only invariant machinery
// (per-write tracking + quiescence sweeps) — that cost regressed the whole
// CodSpeed suite by 5-21% when it ran under the test defines.
//
// SIGNALS_TIER selects the build tier the source is compiled as (see
// src/globals.d.ts): "dev" (default — checks + wiring), "observe" (wiring
// only: what a production observability build pays with no hooks
// installed), "prod" (neither). Meant for `vitest bench`; the test suite
// asserts dev-tier behaviour and is not expected to pass under other tiers.
const tier = process.env.SIGNALS_TIER ?? "dev";
// SIGNALS_ASYNC=false compiles the async-free core (the `@solidjs/signals/sync`
// entry); its dedicated suite is tests/sync-entry/ (see vite.config.sync.ts).
const asyncCapability = process.env.SIGNALS_ASYNC !== "false";
if (tier !== "dev" && tier !== "observe" && tier !== "prod")
  throw new Error(`SIGNALS_TIER must be dev | observe | prod, got "${tier}"`);

export default defineConfig(({ mode }) => ({
  plugins: [codspeedPlugin()],
  define: {
    __DEV__: String(tier === "dev"),
    __OBSERVE__: String(tier !== "prod"),
    __TEST__: mode === "benchmark" || tier !== "dev" ? "false" : "true",
    __ASYNC__: String(asyncCapability),
    // Oracle arms only fire for nodes that opt in with CONFIG_ORACLE_* bits;
    // tests/heuristic-oracles.test.ts exercises (and breaks) them.
    __ORACLE__: "true"
  },
  test: {
    globals: true,
    dir: "./tests",
    pool: "threads",
    // Track A stage 2: the async capability census (see tests/setup).
    setupFiles: process.env.SIGNALS_CENSUS
      ? ["./tests/setup/async-census.ts"]
      : process.env.SIGNALS_SYNC_SUBSET
        ? ["./tests/setup/sync-subset.ts"]
        : []
  }
}));
