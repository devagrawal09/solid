// @ts-check
/**
 * `@solidjs/vite-plugin-blocks` (published as `vite-plugin-solid-blocks`,
 * D-011): the JSX transform's one block rule for `@solidjs/blocks`, as a Babel
 * plugin and a plain `transform()`. See `documentation/plans/blocks-library.md`
 * §5.
 */
export { default as babelPluginBlocks } from "./babel.js";
export { transform, parserPlugins } from "./transform.js";
export {
  REFUSALS,
  DEFAULT_BLOCKS_MODULE,
  BlocksRuleError,
  blocksRule,
  applyBlocksRule
} from "./rule.js";
