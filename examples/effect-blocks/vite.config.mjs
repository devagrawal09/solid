import { defineConfig } from "vitest/config";
import solid from "@solidjs/vite-plugin";

export default defineConfig({
  plugins: [solid()],
  server: { port: 3007 },
  preview: { port: 3007 },
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    pool: "threads"
  }
});
