// Runtime-speculation DOM variants: the SAME compiled baseline programs as the
// rows and list suites, bundled against runtime builds from build.mjs. The
// compiler oracle each speculation tries to replace runs beside it.
//
//   baseline  prod signals + shipped web
//   R1b       memos promoted to status-free after a clean run (signals bit 16;
//             R1, bit 1, fails the signals suite and is not measured here)
//   R3        insert text fast path (web bit 4)            rows: vs H7-text
//   R2        all-node list results skip flatten (bits 2)  list: vs L1-nodes
//   R-all     R1b + R2 + R3 (signals 18, web 6)
import { join } from "node:path";
import { ROOT } from "../common.mjs";

const CACHE = join(ROOT, "node_modules/.cache/heuristics/rspec");
const sig = b => join(CACHE, `signals-r${b}`, "index.js");
const web = b => join(CACHE, `web-r${b}.js`);

export async function rspecVariants(suite) {
  if (suite === "rows") {
    const { DOM_VARIANTS: v } = await import("../dom/variants.mjs");
    const base = v.baseline.source;
    return {
      baseline: v.baseline,
      "web-r0": { source: base, signals: sig(0), web: web(0) }, // rebuilt-from-worktree control
      R1b: { source: base, signals: sig(16), web: web(0) },
      R3: { source: base, signals: sig(0), web: web(4) },
      "R-all": { source: base, signals: sig(18), web: web(6) },
      "H7-text": v["H7-text"]
    };
  }
  if (suite === "list") {
    const { LIST_VARIANTS: v } = await import("../dom/list/variants.mjs");
    const base = v.baseline.source;
    return {
      baseline: v.baseline,
      "web-r0": { source: base, signals: sig(0), web: web(0) },
      R1b: { source: base, signals: sig(16), web: web(0) },
      R2: { source: base, signals: sig(2), web: web(2) },
      R3: { source: base, signals: sig(0), web: web(4) },
      "R-all": { source: base, signals: sig(18), web: web(6) },
      "L1-nodes": v["L1-nodes"]
    };
  }
  throw new Error(`unknown rspec suite ${suite}`);
}
