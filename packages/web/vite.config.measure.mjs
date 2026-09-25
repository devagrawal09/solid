/// <reference types="vitest" />

// Track D measurement config: hydrates the harness artifacts against the
// PRODUCTION client builds (solid-js / @solidjs/signals / @solidjs/web
// `dist`, no "development" condition) with the compiler's prod output, in a
// forked process with `--expose-gc` for allocation readings. Specs under
// test/measure/ only run when TRACK_D_MEASURE=1. The server half of the
// harness (vite.config.server.mjs) must have written the artifacts with the
// same SOLID_SERVER_AUTHORITY / SOLID_INERT_REGIONS settings.
import { defineConfig } from "vitest/config";
import solidPlugin from "@solidjs/vite-plugin";
import { resolve } from "path";

const rootDir = resolve(import.meta.dirname);

const serverAuthority = process.env.SOLID_SERVER_AUTHORITY !== "0";
// Track D slice 6: inert-region elimination, opt-in (`SOLID_INERT_REGIONS=1`,
// see the `test:track-d` script): it drops hydration keys from static
// components, which existing specs assert literally.
const inertRegions = process.env.SOLID_INERT_REGIONS === "1";
const authoritySummary = {
  "./track-d-api.js": {
    fetchCatalog: "server",
    byPrice: "pure",
    formatPrice: "pure"
  }
};

export default defineConfig({
  plugins: [
    solidPlugin({
      hot: false,
      solid: {
        dev: false,
        hydratable: true,
        serverAuthority,
        authoritySummary,
        inertRegions
      }
    })
  ],
  test: {
    environment: "jsdom",
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true, execArgv: ["--expose-gc", "--max-semi-space-size=64"] }
    },
    execArgv: ["--expose-gc", "--max-semi-space-size=64"],
    include: ["test/measure/**/*.spec.tsx"],
    testTimeout: 600000
  },
  resolve: {
    conditions: ["browser"],
    // Pin the production bundles: vitest adds a "development" condition in
    // test mode, which would select the dev builds.
    alias: [
      { find: /^solid-js$/, replacement: resolve(rootDir, "../solid/dist/solid.js") },
      {
        find: /^@solidjs\/signals$/,
        replacement: resolve(rootDir, "../signals/dist/prod/index.js")
      },
      { find: /^@solidjs\/web$/, replacement: resolve(rootDir, "dist/web.js") }
    ]
  }
});
