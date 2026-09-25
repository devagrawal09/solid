/**
 * Server → hydrate hand-off: each server mode's complete streamed output,
 * one small committed file per (scenario, server mode).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServerArtifact } from "./runner.js";

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../__artifacts__");

function file(scenario: string, mode: string): string {
  return resolve(dir, `${scenario}.${mode.replace("/", "-")}.html`);
}

export function writeArtifact(scenario: string, mode: string, artifact: ServerArtifact): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file(scenario, mode), artifact.output + "\n");
}

export function readArtifact(scenario: string, mode: string): ServerArtifact {
  const path = file(scenario, mode);
  if (!existsSync(path)) {
    throw new Error(
      `[conformance] missing server artifact ${path}; run the server project first: ` +
        "vitest run --config vite.config.server.mjs test/server/conformance.spec.tsx"
    );
  }
  return { output: readFileSync(path, "utf8").replace(/\n$/, "") };
}
