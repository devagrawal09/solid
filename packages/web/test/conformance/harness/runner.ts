/**
 * Mode execution: turn (scenario, mode) into an Observation in the current
 * vitest environment. The spec for each environment passes in the
 * `solid-js` / `@solidjs/web` namespaces its project resolved, so compiled
 * scenario code runs against exactly that build.
 */
import { compile, evaluate } from "./module.js";
import { Recorder, controller, drain, format, probe, NotFound, Forbidden } from "./trace.js";
import type { DriverContext, ModeAdapter, Observation, Scenario } from "./types.js";

export interface Runtime {
  solid: any;
  web: any;
}

/** The server markup a hydrate mode consumes (written by the server spec). */
export interface ServerArtifact {
  /** Complete streamed output (shell + late chunks), scripts included. */
  output: string;
}

function load(scenario: Scenario, mode: ModeAdapter, runtime: Runtime, recorder: Recorder) {
  const source = scenario.sources[mode.source];
  if (source === undefined) {
    throw new Error(`[conformance] ${scenario.name} has no ${mode.source} source for ${mode.id}`);
  }
  const compiled = compile(source, mode.compile);
  const h = probe(recorder, runtime.solid);
  const app = evaluate(compiled.code, {
    "solid-js": runtime.solid,
    "@solidjs/web": runtime.web,
    conformance: { h, NotFound, Forbidden }
  });
  return { app, stats: compiled.stats, code: compiled.code };
}

/**
 * A module that fails to compile or evaluate is an observation too (e.g. a
 * lowering that emits invalid JavaScript): record it instead of throwing so
 * a scenario can pin it as a known defect.
 */
function tryLoad(scenario: Scenario, mode: ModeAdapter, runtime: Runtime, recorder: Recorder) {
  try {
    return load(scenario, mode, runtime, recorder);
  } catch (error) {
    recorder.raw(`uncaught load = ${format(error)}`);
    return undefined;
  }
}

/**
 * Console output during a run is observable behaviour (dev warnings,
 * hydration mismatch reports, uncaught-error logs). Record the first line of
 * each call so traces stay stable.
 */
function captureConsole(recorder: Recorder): () => void {
  const originals = { warn: console.warn, error: console.error };
  for (const level of ["warn", "error"] as const) {
    console[level] = (...args: unknown[]) => {
      const text = args
        .map(a => (typeof a === "string" ? a : format(a)))
        .join(" ")
        .split("\n", 1)[0]
        .trim();
      recorder.raw(`console.${level} = ${text}`);
    };
  }
  return () => Object.assign(console, originals);
}

async function drive(scenario: Scenario, recorder: Recorder, ctx: DriverContext): Promise<void> {
  for (const step of scenario.steps) {
    if (step.environments && !step.environments.includes(ctx.environment)) continue;
    recorder.raw(`## ${step.name}`);
    try {
      await step.run(ctx);
    } catch (error) {
      recorder.raw(`uncaught ${step.name} = ${format(error)}`);
      recorder.raw("## aborted");
      return;
    }
  }
}

function context(
  scenario: Scenario,
  runtime: Runtime,
  recorder: Recorder,
  app: Record<string, any>,
  container: HTMLElement | null,
  environment: DriverContext["environment"],
  dispose: () => void
): DriverContext {
  const { solid } = runtime;
  return {
    app,
    environment,
    tasks: controller(recorder),
    flush: () => solid.flush(),
    async settle() {
      await drain();
      solid.flush();
    },
    html() {
      if (!container) throw new Error(`[conformance] ${scenario.name}: html() without a container`);
      recorder.raw(`html = ${container.innerHTML}`);
    },
    click(selector) {
      if (!container)
        throw new Error(`[conformance] ${scenario.name}: click() without a container`);
      const target = container.querySelector<HTMLElement>(selector);
      if (!target) throw new Error(`no element matches ${selector}`);
      target.click();
    },
    observe(label, value) {
      recorder.push("value", label, value);
    },
    dispose
  };
}

/** Client environment: fresh render (component) or createRoot (root). */
export async function observeClient(
  scenario: Scenario,
  mode: ModeAdapter,
  runtime: Runtime
): Promise<Observation> {
  const { solid, web } = runtime;
  const recorder = new Recorder();
  const restore = captureConsole(recorder);
  let container: HTMLElement | null = null;
  let disposeRoot: (() => void) | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeRoot?.();
    solid.flush();
  };
  try {
    const loaded = tryLoad(scenario, mode, runtime, recorder);
    if (!loaded) return { scenario: scenario.name, mode: mode.id, trace: recorder.events };
    const { app, stats } = loaded;
    recorder.raw("## mount");
    try {
      if ("component" in scenario.entry) {
        const Component = app[scenario.entry.component];
        container = document.createElement("div");
        document.body.appendChild(container);
        disposeRoot = web.render(() => web.createComponent(Component, {}), container);
      } else {
        const entry = app[scenario.entry.root];
        solid.createRoot((d: () => void) => {
          disposeRoot = d;
          entry();
        });
      }
      solid.flush();
    } catch (error) {
      recorder.raw(`uncaught mount = ${format(error)}`);
      return { scenario: scenario.name, mode: mode.id, trace: recorder.events, stats };
    }
    await drive(
      scenario,
      recorder,
      context(scenario, runtime, recorder, app, container, "client", dispose)
    );
    if (!disposed) {
      recorder.raw("## teardown");
      dispose();
    }
    const pending = controller(recorder).pending();
    if (pending.length) recorder.raw(`unsettled = ${pending.join(", ")}`);
    return { scenario: scenario.name, mode: mode.id, trace: recorder.events, stats };
  } finally {
    restore();
    container?.remove();
    await drain();
    // A run that halted reactivity (an uncaught computation error) must not
    // poison the next mode's run in this process.
    solid.resetErrorHalt?.();
  }
}

/**
 * Server environment: stream-render the component and record the markup,
 * hydration keys, serialized records, and the probe trace of the render.
 */
export async function observeServer(
  scenario: Scenario,
  mode: ModeAdapter,
  runtime: Runtime,
  recordKeys: (html: string) => string[]
): Promise<Observation & { artifact: ServerArtifact }> {
  const { web } = runtime;
  if (!("component" in scenario.entry)) throw new Error(`${scenario.name} is not a component`);
  const recorder = new Recorder();
  const restore = captureConsole(recorder);
  try {
    const loaded = tryLoad(scenario, mode, runtime, recorder);
    if (!loaded) {
      return {
        scenario: scenario.name,
        mode: mode.id,
        trace: recorder.events,
        artifact: { output: "" }
      };
    }
    const { app, stats } = loaded;
    const Component = app[scenario.entry.component];
    recorder.raw("## render");
    const chunks: string[] = [];
    const done = new Promise<void>((resolve, reject) => {
      try {
        web
          .renderToStream(() => web.createComponent(Component, {}))
          .pipe({
            write: (chunk: string) => void chunks.push(chunk),
            end: () => resolve()
          });
      } catch (error) {
        reject(error);
      }
    });
    const tasks = controller(recorder);
    let rendered = false;
    done.then(() => (rendered = true));
    await drain();
    // Async SSR: settle each flight the render started, in start order, with
    // the value the scenario declared. Never timer-driven.
    for (const [name, value] of Object.entries(scenario.ssr?.resolve ?? {})) {
      if (rendered) break;
      try {
        if (value instanceof Error) tasks.reject(name, value);
        else tasks.resolve(name, value);
      } catch (error) {
        // e.g. the render never started the flight the scenario expects
        recorder.raw(`uncaught settle ${name} = ${format(error)}`);
        break;
      }
      await drain();
    }
    try {
      await done;
    } catch (error) {
      recorder.raw(`uncaught render = ${format(error)}`);
    }
    const output = chunks.join("");
    const markup = output.replace(/<script[\s\S]*?<\/script>/g, "");
    const keys = [...markup.matchAll(/\s_hk="?([^"\s>]+)"?/g)].map(m => m[1]);
    recorder.raw(`markup = ${markup}`);
    recorder.raw(`hydration-keys = ${JSON.stringify(keys)}`);
    recorder.raw(`serialized = ${JSON.stringify(recordKeys(output).sort())}`);
    const pending = tasks.pending();
    if (pending.length) recorder.raw(`unsettled = ${pending.join(", ")}`);
    return {
      scenario: scenario.name,
      mode: mode.id,
      trace: recorder.events,
      stats,
      artifact: { output }
    };
  } finally {
    restore();
  }
}

/**
 * Hydrate environment: apply the paired server mode's complete output (the
 * "loaded" page case), hydrate the same component compiled for the client,
 * then verify node identity and drive the scenario's steps.
 */
export async function observeHydrate(
  scenario: Scenario,
  mode: ModeAdapter,
  runtime: Runtime,
  artifact: ServerArtifact
): Promise<Observation> {
  const { solid, web } = runtime;
  if (!("component" in scenario.entry)) throw new Error(`${scenario.name} is not a component`);
  const recorder = new Recorder();
  const restore = captureConsole(recorder);
  const container = document.createElement("div");
  document.body.appendChild(container);
  let disposeRoot: (() => void) | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disposeRoot?.();
    solid.flush();
  };
  (globalThis as any)._$HY = { events: [], completed: new WeakSet(), r: {}, fe() {} };
  try {
    const loaded = tryLoad(scenario, mode, runtime, recorder);
    if (!loaded) return { scenario: scenario.name, mode: mode.id, trace: recorder.events };
    const { app, stats } = loaded;
    const Component = app[scenario.entry.component];
    const scriptRe = /<script(?:[^>]*)>([\s\S]*?)<\/script>/g;
    container.innerHTML = artifact.output.replace(scriptRe, "");
    for (const [, script] of artifact.output.matchAll(scriptRe)) (0, eval)(script);
    const serverNodes = [...container.querySelectorAll("[_hk]")].map(
      node => [node.getAttribute("_hk")!, node] as const
    );
    const before = new Set(container.querySelectorAll("*"));
    recorder.raw("## hydrate");
    try {
      disposeRoot = web.hydrate(() => web.createComponent(Component, {}), container);
      solid.flush();
      // hydration completes on a microtask
      await drain();
      solid.flush();
    } catch (error) {
      recorder.raw(`uncaught hydrate = ${format(error)}`);
      return { scenario: scenario.name, mode: mode.id, trace: recorder.events, stats };
    }
    // Node identity: server-keyed nodes must survive hydration, and the
    // client must not insert elements of its own. (A key miss builds a
    // detached element and leaves the server node in place, so key misses
    // show up as the runtime's console warnings and as dead updates in
    // later steps, not here.)
    const removed = serverNodes.filter(([, node]) => !node.isConnected).map(([key]) => key);
    const inserted = [...container.querySelectorAll("*")].filter(node => !before.has(node));
    recorder.raw(
      `hydration server-nodes ${serverNodes.length - removed.length}/${serverNodes.length} kept, ${inserted.length} client-inserted`
    );
    if (removed.length) recorder.raw(`hydration removed = ${JSON.stringify(removed)}`);
    await drive(
      scenario,
      recorder,
      context(scenario, runtime, recorder, app, container, "hydrate", dispose)
    );
    if (!disposed) {
      recorder.raw("## teardown");
      dispose();
    }
    const pending = controller(recorder).pending();
    if (pending.length) recorder.raw(`unsettled = ${pending.join(", ")}`);
    return { scenario: scenario.name, mode: mode.id, trace: recorder.events, stats };
  } finally {
    restore();
    await drain();
    container.remove();
    delete (globalThis as any)._$HY;
    solid.resetErrorHalt?.();
  }
}
