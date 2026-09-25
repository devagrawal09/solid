import type { Scenario } from "../harness/types.js";
import { boundaryScenarios } from "./boundaries.js";
import { eventScenarios } from "./events.js";
import { pathScenarios } from "./paths.js";
import { reactiveScenarios } from "./reactive.js";
import { resumableScenarios } from "./resumable.js";
import { ssrScenarios } from "./ssr.js";

export const scenarios: Scenario[] = [
  ...reactiveScenarios,
  ...boundaryScenarios,
  ...eventScenarios,
  ...pathScenarios,
  ...ssrScenarios,
  ...resumableScenarios
];
