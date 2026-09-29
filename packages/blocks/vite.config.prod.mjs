import { defineConfig } from "vitest/config";
import solidPlugin from "@solidjs/vite-plugin";
import { resolve } from "node:path";

// Production builds (no development condition, __DEV__ false): the same
// suite minus the dev-only checks. Test JSX compiles with the native compiler by default;
// `JSX_COMPILER=babel` switches to the Babel transform.
const compiler = process.env.JSX_COMPILER === "babel" ? "babel" : "native";
const src = resolve(import.meta.dirname, "src");

export default defineConfig({
  plugins: [solidPlugin({ compiler })],
  define: { __DEV__: "false", __SERVER__: "false" },
  test: {
    environment: "jsdom",
    pool: "threads",
    globals: true,
    include: ["test/**/*.spec.ts", "test/**/*.spec.tsx"],
    exclude: ["**/node_modules/**", "test/server/**"]
  },
  resolve: {
    conditions: ["browser"],
    alias: [
      { find: /^@solidjs\/blocks$/, replacement: resolve(src, "index.ts") },
      { find: /^@solidjs\/blocks\/h$/, replacement: resolve(src, "h.ts") },
      { find: /^@solidjs\/blocks\/html$/, replacement: resolve(src, "html.ts") },
      { find: /^@solidjs\/blocks\/jsx-runtime$/, replacement: resolve(src, "jsx-runtime.ts") },
      // @solidjs/h's jsx-runtime imports its package by name
      { find: /^@solidjs\/h$/, replacement: resolve(import.meta.dirname, "../h/dist/h.js") }
    ]
  }
});
