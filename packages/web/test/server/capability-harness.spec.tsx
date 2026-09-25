/**
 * @jsxImportSource @solidjs/web
 *
 * Server half of the capability-selected hydration matrix (optimization
 * slice 7). Renders every fixture graph from test/harness/capability-apps.ts
 * with the ssr generate, prepends the bootstrap script composed from the
 * graph's positive fixture manifest (`composeServerHydrationOptions` — the
 * server half of the composer), and writes the artifacts that
 * test/hydration/capability-matrix.spec.tsx replays.
 *
 * It also checks the fixture producer against reality: every record kind the
 * server emitted must be adoptable by a capability the manifest selects.
 * (The converse — that the manifest selects nothing the graph could do
 * without — is what the matrix's violation cases pin.)
 */
import { describe, expect, test } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStream, generateHydrationScript } from "@solidjs/web";
import { capabilityApps } from "../harness/capability-apps.js";
import { hydrationRecordKeys } from "../harness/hydration-records.js";
import { fixtureManifestProducer } from "../hydration-capabilities/fixture-producer.js";
import {
  assertHydrationManifest,
  composeServerHydrationOptions
} from "../../hydration-manifest/src/index.js";

const artifactsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../harness/__capability_artifacts__"
);
mkdirSync(artifactsDir, { recursive: true });

function collectChunks(code: () => any, options: any): Promise<{ shell: string; rest: string }> {
  return new Promise(resolvePromise => {
    const chunks: string[] = [];
    let shell = "";
    let shellDone = false;
    renderToStream(code, {
      ...options,
      onCompleteShell() {
        shellDone = true;
      }
    }).pipe({
      write(chunk: string) {
        chunks.push(chunk);
        if (shellDone && !shell) shell = chunks.join("");
      },
      end() {
        const full = chunks.join("");
        if (!shell) shell = full;
        resolvePromise({ shell, rest: full.slice(shell.length) });
      }
    });
  });
}

describe("capability-selected hydration — server render", () => {
  for (const app of capabilityApps) {
    test(app.name, async () => {
      const manifest = assertHydrationManifest(fixtureManifestProducer.produce(app.name));
      const App = await app.load();
      const { shell, rest } = await collectChunks(() => <App />, app.serverOptions);
      const bootstrap = generateHydrationScript(composeServerHydrationOptions(manifest));
      const records = hydrationRecordKeys(shell + rest);

      const caps = manifest.capabilities;
      for (const key of records) {
        if (key.endsWith("_fr")) expect(caps.streamLedger, `${key} needs streamLedger`).toBe(true);
        else if (key.endsWith("_assets"))
          expect(caps.lazyAssets, `${key} needs lazyAssets`).toBe(true);
        else
          expect(
            caps.asyncResults || caps.storeAdapters || caps.errorMarkers || caps.loadingMarkers,
            `record ${key} needs an adopting capability`
          ).toBe(true);
      }
      // The bootstrap captures exactly the manifest's delegated event types.
      for (const name of caps.delegatedEvents) expect(bootstrap).toContain(`"${name}"`);

      writeFileSync(
        resolve(artifactsDir, `${app.name}.json`),
        JSON.stringify({ name: app.name, records, shell: bootstrap + shell, rest }, null, 2) + "\n"
      );
    });
  }
});
