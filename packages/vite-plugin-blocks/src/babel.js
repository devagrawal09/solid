// @ts-check
/**
 * `babelPluginBlocks`: the rule as a Babel plugin, for a Babel pipeline
 * (`@solidjs/vite-plugin`'s `babel` option, a Babel-only build). Run it
 * before the JSX transform. Option: `blocksModule` (default
 * `@solidjs/blocks`).
 *
 * `file.metadata.blocks` records what changed: `{ holes }` (a boolean).
 */
import { DEFAULT_BLOCKS_MODULE, applyBlocksRule } from "./rule.js";

/**
 * @param {typeof import("@babel/core")} api
 * @param {{ blocksModule?: string }} [options]
 * @returns {import("@babel/core").PluginObj}
 */
export default function babelPluginBlocks(api, options = {}) {
  const t = api.types;
  const blocksModule = options.blocksModule ?? DEFAULT_BLOCKS_MODULE;
  return {
    name: "solid-blocks",
    visitor: {
      Program(program, state) {
        const holes = applyBlocksRule(program, t, blocksModule);
        Object.assign(state.file.metadata, { blocks: { holes } });
      }
    }
  };
}
