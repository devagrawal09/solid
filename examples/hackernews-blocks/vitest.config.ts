import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import solid from "@solidjs/vite-plugin";

const examples = fileURLToPath(new URL("..", import.meta.url));

/**
 * `~/…` resolves against the `src/` of the example the importer lives in, so
 * the parity test can load examples/hackernews (the original) and this twin
 * side by side, each with its own `~/lib/views` and routes.
 */
function exampleAlias(): Plugin {
  return {
    name: "example-tilde-alias",
    enforce: "pre",
    async resolveId(source, importer) {
      if (!source.startsWith("~/") || !importer) return null;
      const example = relative(examples, dirname(importer)).split(sep)[0];
      return this.resolve(join(examples, example, "src", source.slice(2)), importer, {
        skipSelf: true
      });
    }
  };
}

// The tests run the apps client-only in jsdom: no `start` entries, no server
// functions. `~/lib/views` is then an ordinary module, so each route's
// `dynamic(() => getStory(id))` resolves the server component in-process and
// renders it here — the `toggle` slot included — with `fetch` stubbed by the
// fixtures (tests/fixtures). The frames transport (SSR, hydration, streamed
// morphs) is covered by the browser check (scripts/example-blocks/browser.mjs).
export default defineConfig({
  plugins: [exampleAlias(), solid()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    pool: "threads"
  }
});
