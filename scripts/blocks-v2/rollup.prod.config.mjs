// Only the production tree of packages/signals (what the benchmarks load):
//   cd packages/signals && npx rollup -c ../../scripts/blocks-v2/rollup.prod.config.mjs \
//     && node ./scripts/mangle-props.mjs dist/prod
// A full `pnpm build` rebuilds every tier; this is the fast inner loop.
import configs from "../../packages/signals/rollup.config.js";

export default configs.filter(c => c.output && c.output.dir === "dist/prod");
