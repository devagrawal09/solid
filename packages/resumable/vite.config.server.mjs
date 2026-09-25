/// <reference types="vitest" />
// Node environment: builds the fixtures, server-renders them, and writes the
// page artifacts the client (jsdom) project consumes.
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/server/**/*.spec.js"],
    pool: "threads",
    testTimeout: 60000,
    hookTimeout: 60000
  },
  resolve: { conditions: ["node"] }
});
