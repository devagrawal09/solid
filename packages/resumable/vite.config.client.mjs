/// <reference types="vitest" />
// jsdom environment: loads the server artifacts, installs the inline
// bootstrap and drives events; event modules and the runtime are imported
// from the built client chunks.
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "jsdom",
    include: ["test/client/**/*.spec.js"],
    pool: "threads",
    testTimeout: 60000,
    hookTimeout: 60000
  },
  resolve: { conditions: ["browser", "development"] }
});
