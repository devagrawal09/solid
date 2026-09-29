/**
 * The type linker as a Vite plugin (modeled on TanStack Router's route-tree
 * generator):
 * - dev: summarizes every module at startup, then watches the file system
 *   and re-summarizes only the saved module (cached by content hash),
 *   re-solves and rewrites the generated file when the facts changed;
 * - build: regenerates in memory and fails the build when the committed
 *   file is stale (run `solid-link` to update it), so CI never ships types
 *   that disagree with the code.
 */
import path from "node:path";
import { createLinker } from "./index.js";

/** @param {Parameters<typeof createLinker>[0] & { log?: boolean }} options */
export default function solidLink(options = {}) {
  let linker;
  let command = "serve";
  const log = options.log !== false;
  return {
    name: "solid-blocks-linker",
    enforce: "pre",
    configResolved(config) {
      command = config.command;
      linker = createLinker({ ...options, root: options.root || config.root });
    },
    buildStart() {
      linker.scan();
      if (command === "build") {
        const { stale, diagnostics } = linker.check();
        for (const d of diagnostics) this.warn(`[${d.code}] ${d.message}`);
        if (stale)
          this.error(
            `[LINK_STALE] ${path.relative(linker.root, linker.out)} is stale: run \`solid-link\` (or start the dev server) and commit it.`
          );
      } else {
        const { changed } = linker.write();
        if (changed && log)
          console.log(`[solid-link] wrote ${path.relative(linker.root, linker.out)}`);
      }
    },
    configureServer(server) {
      const onChange = file => {
        const started = performance.now();
        if (!linker.update(file)) return;
        const { changed } = linker.write();
        if (changed && log)
          console.log(
            `[solid-link] ${path.relative(linker.root, file)} → ${path.relative(linker.root, linker.out)} (${(performance.now() - started).toFixed(1)} ms)`
          );
      };
      server.watcher.on("change", onChange);
      server.watcher.on("add", onChange);
      server.watcher.on("unlink", onChange);
    }
  };
}
export { solidLink };
