/**
 * The mode registry. Adding a mode is adding an adapter here (see
 * ../README.md, "Adding a mode"); scenarios and specs pick it up by
 * environment.
 */
import { compile } from "./module.js";
import type { Environment, ModeAdapter, ModeId } from "./types.js";

function compilerSupports(option: string): string | undefined {
  try {
    compile("export const x = 1;", { generate: "dom", [option]: true }, "probe.js");
    return undefined;
  } catch (error) {
    return `the native compiler rejects \`${option}\`: ${(error as Error).message}`;
  }
}

export const modes: ModeAdapter[] = [
  // --- client: fresh render in jsdom ------------------------------------------
  {
    id: "client/reference",
    title: "handwritten Solid",
    environment: "client",
    source: "reference",
    compile: { generate: "dom" }
  },
  {
    id: "client/runtime",
    title: "`$` via runtime generator driver (compat fallback; no lowering)",
    environment: "client",
    source: "generator",
    compile: { generate: "dom", generators: false },
    reference: "client/reference"
  },
  {
    id: "client/compiled",
    title: "`$` lowered by the compiler (call-form blocks)",
    environment: "client",
    source: "generator",
    compile: { generate: "dom" },
    reference: "client/reference"
  },
  {
    id: "client/fused",
    title: "`$` lowered + host fusion / block erasure",
    environment: "client",
    source: "generator",
    compile: { generate: "dom", hostFusion: true },
    reference: "client/reference",
    available: () => compilerSupports("hostFusion")
  },
  // --- server: SSR ---------------------------------------------------------------
  {
    id: "server/reference",
    title: "handwritten Solid, SSR",
    environment: "server",
    source: "reference",
    compile: { generate: "ssr", hydratable: true }
  },
  {
    id: "server/runtime",
    title: "`$` runtime driver, SSR",
    environment: "server",
    source: "generator",
    compile: { generate: "ssr", hydratable: true, generators: false },
    reference: "server/reference"
  },
  {
    id: "server/compiled",
    title: "`$` lowered, SSR",
    environment: "server",
    source: "generator",
    compile: { generate: "ssr", hydratable: true },
    reference: "server/reference"
  },
  {
    id: "server/fused",
    title: "`$` lowered + host fusion, SSR",
    environment: "server",
    source: "generator",
    compile: { generate: "ssr", hydratable: true, hostFusion: true },
    reference: "server/reference",
    available: () => compilerSupports("hostFusion")
  },
  // --- hydrate: client hydrating the matching server mode's markup ---------------
  {
    id: "hydrate/reference",
    title: "handwritten Solid, hydration",
    environment: "hydrate",
    source: "reference",
    compile: { generate: "dom", hydratable: true },
    pairedWith: "server/reference"
  },
  {
    id: "hydrate/runtime",
    title: "`$` runtime driver, hydration",
    environment: "hydrate",
    source: "generator",
    compile: { generate: "dom", hydratable: true, generators: false },
    reference: "hydrate/reference",
    pairedWith: "server/runtime"
  },
  {
    id: "hydrate/compiled",
    title: "`$` lowered, hydration",
    environment: "hydrate",
    source: "generator",
    compile: { generate: "dom", hydratable: true },
    reference: "hydrate/reference",
    pairedWith: "server/compiled"
  },
  {
    id: "hydrate/fused",
    title: "`$` lowered + host fusion, hydration",
    environment: "hydrate",
    source: "generator",
    compile: { generate: "dom", hydratable: true, hostFusion: true },
    reference: "hydrate/reference",
    pairedWith: "server/fused",
    available: () => compilerSupports("hostFusion")
  }
];

/**
 * Modes that are part of the proposal but cannot run in this checkout. They
 * appear in the coverage matrix as unavailable so the gap is explicit.
 */
export const plannedModes: { id: ModeId; title: string; blocker: string }[] = [
  {
    id: "client/strict",
    title: "non-generator strict frontend",
    blocker: 'no strict source frontend or `mode: "strict"` compiler option exists yet'
  },
  {
    id: "client/proxy-free-stores",
    title: "proxy-free store lowering",
    blocker: "stores are always proxies; no compiler/runtime option selects another representation"
  },
  {
    id: "client/cold-events",
    title: "cold event-domain extraction",
    blocker: "proposal only (typed-generator-compiler.md, App Bundle Prototype Priorities)"
  },
  {
    id: "hydrate/runtime-selected",
    title: "runtime-selected / resumable hydration",
    blocker: "hydration always re-executes the component tree; no selection manifest exists"
  },
  {
    id: "server/server-components",
    title: "server components",
    blocker:
      "harness gap, not a platform gap: the compiler's `serverComponents` option and @solidjs/web frames exist, but running a scenario as a server-component tree needs a frame-streaming runner and client-reference boundaries this harness does not implement yet"
  }
];

export function modesFor(environment: Environment): ModeAdapter[] {
  return modes.filter(mode => mode.environment === environment);
}

export function mode(id: ModeId): ModeAdapter {
  const found = modes.find(m => m.id === id);
  if (!found) throw new Error(`[conformance] unknown mode ${id}`);
  return found;
}
