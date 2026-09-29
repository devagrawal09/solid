import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import solid from "@solidjs/vite-plugin";

const examples = fileURLToPath(new URL("..", import.meta.url));

/**
 * `~/…` resolves against the `src/` of the example the importer lives in, so
 * the parity test can load examples/notes (the original) and this twin side
 * by side, each with its own `~/lib`, `~/server` and routes.
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
// functions. `~/server/*` are then ordinary modules: the server components
// and the actions run in-process against each app's own in-memory store, so
// the routes, the router, the actions and every component run here; SSR,
// hydration and frame morphs are covered by the browser check
// (scripts/example-blocks/browser.mjs), mutations only here (see the
// README). (The anchors are all created by
// plain components — EditButton, SidebarNoteContent: see the README — so the
// dev runtime works; ../hackernews-spa-blocks shows why that matters.)
export default defineConfig({
  plugins: [exampleAlias(), solid()],
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    pool: "threads"
  }
});
