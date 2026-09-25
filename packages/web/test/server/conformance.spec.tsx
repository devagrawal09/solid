/**
 * Semantic conformance — server environment (SSR). Stream-renders every
 * SSR-enabled scenario through each server mode, compares traces (markup,
 * hydration keys, serialized records, render-time reads/runs/tasks), and
 * writes each mode's complete output to test/conformance/__artifacts__/ for
 * the hydrate environment (test/hydration/conformance.spec.tsx). `pnpm test`
 * runs this project before the hydrate project, so artifacts are always
 * regenerated from the current compiler and runtime; they are committed so
 * markup and hydration-key changes show up in review. See
 * test/conformance/README.md.
 */
import * as solid from "solid-js";
import * as web from "@solidjs/web";
import { hydrationRecordKeys } from "../harness/hydration-records.js";
import { registerEnvironment } from "../conformance/harness/register.js";
import { observeServer } from "../conformance/harness/runner.js";
import { writeArtifact } from "../conformance/harness/artifacts.js";
import { scenarios } from "../conformance/scenarios/index.js";
// The resumable-events server helpers (experimental, private) a
// `server/resumable` compile imports; resolved from source so its `solid-js`
// and `@solidjs/web` imports hit this project's aliases.
import * as resumableServer from "../../../resumable/src/server.js";

registerEnvironment("server", scenarios, async (scenario, mode) => {
  const observation = await observeServer(
    scenario,
    mode,
    { solid, web, modules: { "@solidjs/resumable/server": resumableServer } },
    hydrationRecordKeys
  );
  writeArtifact(scenario.name, mode.id, observation.artifact);
  return observation;
});
