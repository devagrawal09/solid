/// <reference types="vitest" />

import { defineConfig } from "vitest/config";
// Test JSX compiles with the native Rust compiler by default;
// `JSX_COMPILER=babel` switches to the Babel transform for A/B.
import solidPlugin from "@solidjs/vite-plugin";

const compiler = process.env.JSX_COMPILER === "babel" ? "babel" : "native";
// Track D slice 5: server-authoritative memo sealing (on by default for the
// harness; `SOLID_SERVER_AUTHORITY=0` is the A/B baseline). Both configs must
// agree, and share the cross-module authority summary.
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
import { resolve } from "path";

const rootDir = resolve(import.meta.dirname);

export default defineConfig({
  plugins: [
    solidPlugin({
      compiler,
      solid: {
        generate: "ssr",
        hydratable: true,
        serverAuthority,
        authoritySummary,
        inertRegions
      }
    })
  ],
  test: {
    environment: "node",
    include: ["test/server/**/*.spec.tsx"],
    globals: true,
    pool: "threads",
  },
  resolve: {
    conditions: ["node"],
    alias: {
      "@solidjs/web/server-functions/server": resolve(rootDir, "server-functions/dist/server.js"),
      "@solidjs/web/server-functions/client": resolve(rootDir, "server-functions/dist/client.js"),
      "@solidjs/web/frames/server": resolve(rootDir, "frames/dist/server.js"),
      // the transport's lazy codec imports — without these the bare
      // "@solidjs/web" alias below swallows the subpath
      "@solidjs/web/serialization/decode": resolve(rootDir, "serialization/dist/decode.js"),
      "@solidjs/web/serialization": resolve(rootDir, "serialization/dist/serialization.js"),
      "@solidjs/web": resolve(rootDir, "src/index.server.ts"),
      "solid-js": resolve(rootDir, "../solid/src/server/index.ts"),
    }
  }
});
