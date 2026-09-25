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
import { observeHydrate, observeResume } from "../conformance/harness/runner.js";
import { readArtifact } from "../conformance/harness/artifacts.js";
import { scenarios } from "../conformance/scenarios/index.js";
// The resumable-events client pieces (experimental, private): the inline
// bootstrap and the event-domain runtime, from source.
import { install } from "../../../resumable/src/bootstrap.js";
import * as resumeRuntime from "../../../resumable/src/runtime.js";

registerEnvironment("hydrate", scenarios, (scenario, mode) =>
  mode.resume
    ? observeResume(
        scenario,
        mode,
        { solid, web },
        { install, runtime: resumeRuntime },
        readArtifact(scenario.name, mode.pairedWith!)
      )
    : observeHydrate(scenario, mode, { solid, web }, readArtifact(scenario.name, mode.pairedWith!))
);
