/// <reference types="vitest" />

import { defineConfig } from "vitest/config";
import solidPlugin from "@solidjs/vite-plugin";
import { resolve } from "path";

// Production-build run of the capability-selected hydration matrix
// (optimization slice 7): the positive cases hydrate against the PROD
// runtime — solid-js/@solidjs/signals prod artifacts and @solidjs/web source
// with its build flags folded to false — where an omitted capability's slot
// is empty (no development guard in it). Violation cases are dev-only.
const compiler = process.env.JSX_COMPILER === "babel" ? "babel" : "native";
const rootDir = resolve(import.meta.dirname);

const foldBuildFlags = {
  name: "fold-solid-build-flags",
  enforce: "pre",
  transform(code, id) {
    if (!id.startsWith(resolve(rootDir, "src"))) return null;
    if (!code.includes('"_SOLID_DEV_"') && !code.includes('"_SOLID_OBSERVE_"')) return null;
    return code.replaceAll('"_SOLID_DEV_"', "false").replaceAll('"_SOLID_OBSERVE_"', "false");
  }
};

export default defineConfig({
  plugins: [
    foldBuildFlags,
    solidPlugin({ compiler, hot: false, solid: { dev: false, hydratable: true } })
  ],
  test: {
    environment: "jsdom",
    pool: "threads",
    globals: true,
    include: ["test/hydration/capability-matrix.spec.tsx"],
    env: { CAPABILITY_MATRIX_PROD: "1" }
  },
  resolve: {
    conditions: ["browser"],
    // Explicit artifacts: Vite adds its own development|production condition
    // in test mode, which would otherwise select the dev builds.
    alias: [
      { find: /^solid-js$/, replacement: resolve(rootDir, "../solid/dist/solid.js") },
      {
        find: /^@solidjs\/signals$/,
        replacement: resolve(rootDir, "../signals/dist/prod/index.js")
      },
      { find: /^@solidjs\/web$/, replacement: resolve(rootDir, "src/index.ts") }
    ]
  }
});
