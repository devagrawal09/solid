import type { FrameworkInfo } from "./util/frameworkTypes";
import { solidLocal_prod } from "./frameworks/solidLocal_prod";
import { solidLocal_h5 } from "./frameworks/solidLocal_h5";
import { solidLocal_r0 } from "./frameworks/solidLocal_r0";
import { solidLocal_r1b } from "./frameworks/solidLocal_r1b";

// Heuristic-oracles Tier-2 run: this repo's @solidjs/signals builds only.
// JSRB_ONLY=<name> keeps one (each build runs in its own process).
const all: FrameworkInfo[] = [
  { framework: solidLocal_prod, testPullCounts: true },
  { framework: solidLocal_h5, testPullCounts: true },
  { framework: solidLocal_r0, testPullCounts: true },
  { framework: solidLocal_r1b, testPullCounts: true }
];
const only = (globalThis as any).process?.env?.JSRB_ONLY;
export const frameworkInfo: FrameworkInfo[] = only
  ? all.filter(f => f.framework.name === only)
  : all;
