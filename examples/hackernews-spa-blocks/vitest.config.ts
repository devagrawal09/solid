import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vitest/config";
import solid from "@solidjs/vite-plugin";

const examples = fileURLToPath(new URL("..", import.meta.url));

/**
 * `~/…` resolves against the `src/` of the example the importer lives in, so
 * the parity test can load examples/chat (the original) and this twin side
 * by side, each with its own `~/lib/ai` and `~/components/status`.
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

const runtime = (path: string) => fileURLToPath(new URL(`../../packages/${path}`, import.meta.url));

// The tests run the apps client-only in jsdom: no `start` entries, no server
// functions. `~/lib/hn` is then an ordinary module whose `fetch` the tests
// stub with fixtures, so the routes, the router and every component run
// in-process; SSR and hydration are covered by the browser check
// (scripts/example-blocks/browser.mjs).
//
// Against the PRODUCTION runtime (`solid-js` / `@solidjs/web` aliased to their
// prod builds, the router inlined so it sees the same copies): under the dev
// runtime every `<a href>` a `$component` view creates throws
// DIRECT_READ_IN_BLOCK — @solidjs/router's link claims read the location
// synchronously while the anchor is created, i.e. inside the view block with
// the strict read guard up (see the README). `DEV_RUNTIME=1` runs the dev
// runtime to show it.
const prod = !process.env.DEV_RUNTIME;
export default defineConfig({
  plugins: [exampleAlias(), solid()],
  resolve: prod
    ? {
        alias: [
          { find: /^solid-js$/, replacement: runtime("solid/dist/solid.js") },
          { find: /^@solidjs\/web$/, replacement: runtime("web/dist/web.js") },
          { find: /^@solidjs\/signals$/, replacement: runtime("signals/dist/prod/index.js") }
        ]
      }
    : undefined,
  test: {
    environment: "jsdom",
    include: ["tests/**/*.test.tsx"],
    pool: "threads",
    server: { deps: { inline: [/@solidjs[+/]router/] } }
  }
});
