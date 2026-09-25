/**
 * @vitest-environment jsdom
 *
 * Semantic conformance — hydrate environment. Applies each server mode's
 * recorded output (test/conformance/__artifacts__/, written by
 * test/server/conformance.spec.tsx), hydrates the same component compiled
 * for the client, checks node identity, then drives the scenario's steps.
 * See test/conformance/README.md.
 */
import * as solid from "solid-js";
import * as web from "@solidjs/web";
import { registerEnvironment } from "../conformance/harness/register.js";
import { observeHydrate } from "../conformance/harness/runner.js";
import { readArtifact } from "../conformance/harness/artifacts.js";
import { scenarios } from "../conformance/scenarios/index.js";

registerEnvironment("hydrate", scenarios, (scenario, mode) =>
  observeHydrate(scenario, mode, { solid, web }, readArtifact(scenario.name, mode.pairedWith!))
);
