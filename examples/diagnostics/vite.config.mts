/// <reference types="vitest" />

import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";

/**
 * Export conditions by posture:
 *
 * - `observe` (`vite build --mode observe`) → the shippable tier that keeps
 *   the diagnostic and attribution channels. The only place this config
 *   overrides resolution for a build.
 * - `production` (`vite build`) → Vite's own defaults, so a plain build is a
 *   plain build: diagnostics are stripped, exactly as in any other app.
 * - anything else (`vite`, vitest's `test` mode) → the dev runtime, which is
 *   what the demo and its suites need; `browser` also keeps the client
 *   runtime under vitest's node process.
 */
function conditionsFor(mode: string): string[] | undefined {
  if (mode === "observe") return ["observe", "browser"];
  if (mode === "production") return undefined;
  return ["development", "browser"];
}

export default defineConfig(({ mode }) => {
  const conditions = conditionsFor(mode);
  return {
    // The demo renders owner paths from the diagnostics channel, and the HMR
    // transform would show them as `<[solid-refresh]StoryCard>`. Nothing here
    // needs hot reloading — the page rebuilds its graphs from the toolbar.
    plugins: [solid({ refresh: { disabled: true } })],
    server: { port: 3009 },
    preview: { port: 3009 },
    ...(conditions ? { resolve: { conditions } } : {}),
    test: {
      environment: "jsdom",
      globals: true,
      dir: "./tests",
      pool: "threads"
    }
  };
});
