import type { Scenario } from "../harness/types.js";
import { blocksScenarios } from "./blocks.js";
import { boundaryScenarios } from "./boundaries.js";
import { eventScenarios } from "./events.js";
import { pathScenarios } from "./paths.js";
import { reactiveScenarios } from "./reactive.js";
import { ssrScenarios } from "./ssr.js";

export const scenarios: Scenario[] = [
  ...reactiveScenarios,
  ...boundaryScenarios,
  ...eventScenarios,
  ...pathScenarios,
  ...ssrScenarios,
  ...blocksScenarios
];
