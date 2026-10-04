# @solidjs/vite-plugin-blocks

The JSX transform's one rule for [`@solidjs/blocks`](../blocks) (D-003): inside a JSX expression or attribute value, `yield* e` becomes `perform(e)`, imported from `@solidjs/blocks`. Each read is then its own hole, and the view generator runs once. Nothing else is lowered. Published as `vite-plugin-solid-blocks` at extraction (D-011).

This is the strict dialect's transform; the compiler route (`experiment/iterable-signals`) is the ergonomic one.

## Use

```js
// vite.config.mjs
import blocks from "@solidjs/vite-plugin-blocks";
import solid from "@solidjs/vite-plugin";

export default { plugins: [blocks(), solid()] };
```

`blocks()` runs `enforce: "pre"`, before the JSX compiler. It skips a module whose source has no `function*` without parsing it, and returns `null` (no change) for a module with no hole. Its source map is chained by Vite with the compiler's, so a runtime error maps back to the authored line and column. Options: `blocksModule`, and `filter(file)` (by default `.js`/`.jsx`/`.ts`/`.tsx` and their `m`/`c` forms, outside `node_modules`).

## Exports

- `blocks` (also the default export): the Vite plugin.
- `babelPluginBlocks`: the rule as a Babel plugin, run before the JSX transform. Option: `blocksModule`.
- `transform(code, { filename, blocksModule })`: the rule applied to source text. It returns `{ code, map }`, or `null` when the module has no `yield*` in JSX.
- `blocksRule(program)`: the rule as one function. It classifies every `yield` of a Babel program that sits in JSX into holes and refusals. `applyBlocksRule` applies it to the AST.
- `REFUSALS`, `BlocksRuleError`, `DEFAULT_BLOCKS_MODULE`.

## The rule

| Position                                                                                                       | Result                                                               |
| -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `{yield* e}` as a child, `a={yield* e}` as an attribute, of a DOM element or a foreign Solid component (D-067) | `perform(e)`                                                         |
| a block-component call in a hole, `{yield* Card({ todo })}` (D-062)                                            | one hole: `perform(Card({ todo }))`; the argument is left as written |
| a `yield*` inside a nested function in JSX                                                                     | that function's own; not a hole of this JSX                          |
| an event prop (`onClick`, `on:click`, `oncapture:…`)                                                           | refused: `BLOCKS_YIELD_IN_EVENT`                                     |
| `ref`                                                                                                          | refused: `BLOCKS_YIELD_IN_REF`                                       |
| a spread attribute                                                                                             | refused: `BLOCKS_YIELD_IN_SPREAD`                                    |
| a spread child                                                                                                 | refused: `BLOCKS_YIELD_IN_SPREAD_CHILD`                              |
| a plain `yield` in JSX                                                                                         | refused: `BLOCKS_PLAIN_YIELD_IN_JSX`                                 |

A refusal throws a `BlocksRuleError` whose message lists each refusal as `[CODE] message (line:column)`, the compiler's format. The rule does not know hosts. A hole performed while a setup runs is the runtime's `[JSX_IN_SETUP]` (D-041).

`transform()` edits only the rewritten spans. TypeScript, formatting and comments stay as written, and the source map is exact.

## The `perform` import's line

While the fork's Rust rule is the parity oracle, `import { perform as _$perform } from "@solidjs/blocks";` takes its own first line, as the compiler's rule inserts it. If it shared line 1 with the code, a first-line comment would become the import's trailing comment, and the compiled output would no longer be byte-identical to the rule's. So compiler error messages in files with holes are one line late. Runtime stack traces are exact, because the source map carries the shift. After D-043 removes the Rust rule, the import is placed without shifting lines and the checked-in outputs are regenerated.

## Fixture parity

`test/fixtures/` holds outputs generated once from the fork's Rust compiler while it carried the rule (`test/fixtures/generate.mjs`):

- the rule's 15 cases (7 accepted, 8 refused) with their 5 refusal codes;
- one source file per JSX twin, compiled in `dom` and `ssr` (hydratable) modes.

The test compiles the plugin's output and compares it to those outputs byte for byte, with nothing normalized. Refusals must match the compiler's message, position included.
