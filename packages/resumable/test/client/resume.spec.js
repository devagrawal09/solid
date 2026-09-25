// Client half (jsdom): installs the inline bootstrap over the server's page
// artifacts, drives events, and asserts the semantics the prototype claims —
// without ever importing or running a component.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promises as fs } from "node:fs";
import { install as installBootstrap } from "../../src/bootstrap.js";
import { readArtifact, splitScripts, outDir, packageDir } from "../helpers/artifacts.js";

let componentCalls = 0;
globalThis.__resumableComponentCalls = () => componentCalls++;

/** Mount a page artifact: markup into the document, records evaluated as the browser would. */
function mount(artifact) {
  const { markup, scripts } = splitScripts(artifact.html);
  const container = document.createElement("div");
  container.innerHTML = markup;
  document.body.appendChild(container);
  // The bootstrap is inline before the body: install first, then the
  // records the server emitted after the content (as the browser runs them).
  const failures = [];
  const loads = [];
  const controller = installBootstrap(artifact.manifest, {
    window: globalThis,
    document,
    dev: true,
    report: failure => failures.push(failure),
    load: url => {
      loads.push(url);
      return import(pathToFileURL(path.join(artifact.outDir, url)).href);
    }
  });
  for (const script of scripts) (0, eval)(script);
  return { container, controller, failures, loads };
}

function click(node, init = {}) {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, ...init });
  node.dispatchEvent(event);
  return event;
}

function input(node, value) {
  node.value = value;
  const event = new InputEvent("input", { bubbles: true, cancelable: true });
  node.dispatchEvent(event);
  return event;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

/** Intercept server-function calls by id (the client stub's local-answer seam). */
async function interceptActions() {
  const sf = await import("@solidjs/web/server-functions");
  const calls = [];
  sf.configureServerFunctionsClient({
    responseHandler: {
      intercept({ id, args }) {
        calls.push({ id, args });
        return Promise.resolve({ ok: true });
      }
    }
  });
  return calls;
}

let mounted;
beforeEach(() => {
  componentCalls = 0;
});
afterEach(() => {
  if (mounted) {
    mounted.controller?.uninstall();
    mounted.container.remove();
    mounted = undefined;
  }
});

describe("fixture 1: event-only handler with serializable captures", () => {
  it("runs the first cold click exactly once after the event module loads, with the prelude applied live", async () => {
    const artifact = await readArtifact("buy");
    const calls = await interceptActions();
    mounted = mount(artifact);
    const { container, controller, failures } = mounted;
    const link = container.querySelector(".link");
    const event = click(link, { clientX: 42 });
    // Synchronous prelude on the live event, before any module loaded.
    expect(event.defaultPrevented).toBe(true);
    expect(controller.stats.cold).toBe(1);
    expect(calls).toEqual([]);
    await controller.settled();
    await tick();
    expect(calls.length).toBe(1);
    expect(calls[0].id).toMatch(/^track-[0-9a-f]+$/);
    expect(calls[0].args).toEqual(["a", 5, { kind: "click", x: 42, trusted: false }]);
    expect(failures).toEqual([]);
    expect(componentCalls).toBe(0);
    // Later clicks run synchronously inside the dispatch, with the live event.
    click(link, { clientX: 7 });
    expect(calls.length).toBe(2);
    expect(calls[1].args).toEqual(["a", 5, { kind: "click", x: 7, trusted: false }]);
    expect(controller.stats).toMatchObject({ cold: 1, warm: 1, loads: 1, dropped: 0 });
  });

  it("queues several cold events in dispatch order with distinct snapshots", async () => {
    const artifact = await readArtifact("buy");
    const calls = await interceptActions();
    mounted = mount(artifact);
    const { container, controller, failures } = mounted;
    const [first, second] = container.querySelectorAll(".buy");
    const qty = first.querySelector(".qty");
    input(qty, "1");
    input(qty, "12");
    click(second.querySelector(".link"), { clientX: 3 });
    input(qty, "123");
    expect(calls).toEqual([]);
    await controller.settled();
    await tick();
    expect(calls.map(c => c.args[2])).toEqual([
      { kind: "input", value: "1" },
      { kind: "input", value: "12" },
      { kind: "click", x: 3, trusted: false },
      { kind: "input", value: "123" }
    ]);
    expect(calls.map(c => c.args[0])).toEqual(["a", "a", "b</script><!-- -->", "a"]);
    expect(failures).toEqual([]);
    expect(controller.stats).toMatchObject({ cold: 4, warm: 0, loads: 1 });
  });

  it("drops an event the compiled guard rejects, before queueing", async () => {
    const artifact = await readArtifact("buy");
    const calls = await interceptActions();
    mounted = mount(artifact);
    const { container, controller } = mounted;
    const link = container.querySelector(".link");
    const event = click(link, { button: 1 });
    expect(event.defaultPrevented).toBe(true);
    expect(controller.stats).toMatchObject({ guarded: 1, cold: 0, loads: 0 });
    await tick();
    expect(calls).toEqual([]);
  });

  it("applies stopPropagation live at the delegation root: eager ancestors below it already ran, listeners above it do not", async () => {
    const artifact = await readArtifact("buy");
    const calls = await interceptActions();
    mounted = mount(artifact);
    const { container, controller } = mounted;
    let body = 0;
    let above = 0;
    const onBody = () => body++;
    const onWindow = () => above++;
    document.body.addEventListener("click", onBody);
    window.addEventListener("click", onWindow);
    try {
      const stop = container.querySelector(".stop");
      click(stop);
      // Documented ordering: the bootstrap listens at `document` (where
      // ordinary Solid delegation listens too), so a native listener between
      // the target and the document ran before the prelude, cold or warm.
      expect(body).toBe(1);
      expect(above).toBe(0);
      await controller.settled();
      await tick();
      expect(calls.map(c => c.args[2])).toEqual([{ kind: "stop" }]);
      // warm: same shape, the body listener still precedes the handler
      click(stop);
      expect(body).toBe(2);
      expect(above).toBe(0);
      expect(calls.length).toBe(2);
    } finally {
      document.body.removeEventListener("click", onBody);
      window.removeEventListener("click", onWindow);
    }
  });

  it("drops queued work for a scope disposed or detached before the module arrives", async () => {
    const artifact = await readArtifact("buy");
    const calls = await interceptActions();
    mounted = mount(artifact);
    const { container, controller, failures } = mounted;
    const [first, second, third] = container.querySelectorAll(".buy");
    click(first.querySelector(".link"));
    click(second.querySelector(".link"));
    click(third.querySelector(".link"));
    // first: explicitly disposed; second: DOM replaced (a frame morph); third: live
    controller.dispose(first.querySelector(".link").getAttribute("data-sr").split("/")[0]);
    second.remove();
    await controller.settled();
    await tick();
    expect(calls.map(c => c.args[0])).toEqual(["outside"]);
    expect(controller.stats).toMatchObject({ cold: 3, dropped: 2 });
    expect(failures).toEqual([]);
  });

  it("routes a synchronous throw and an async rejection to the nearest recorded boundary", async () => {
    const artifact = await readArtifact("buy");
    await interceptActions();
    mounted = mount(artifact);
    const { container, controller, failures } = mounted;
    const runtime = await import(
      pathToFileURL(path.join(artifact.outDir, artifact.manifest.runtime)).href
    );
    const routed = [];
    const [inside, , outside] = container.querySelectorAll(".buy");
    const { markup, scripts } = splitScripts(artifact.html);
    void markup;
    const boundary = scripts.join("").match(/b:"([^"]+)"/)[1];
    const unregister = runtime.registerBoundary(boundary, (error, info) =>
      routed.push({ message: error.message, info })
    );
    click(inside.querySelector(".fail"));
    click(inside.querySelector(".reject"));
    click(outside.querySelector(".fail"));
    await controller.settled();
    await tick();
    await tick();
    expect(routed.map(r => r.message)).toEqual(["sync boom a", "async boom a"]);
    expect(routed.every(r => r.info.boundary === boundary)).toBe(true);
    // outside the boundary: no receiver, so the failure is surfaced, not swallowed
    expect(failures.map(f => [f.kind, f.boundary])).toEqual([["handler-error", null]]);
    expect(failures[0].error.message).toBe("sync boom outside");
    unregister();
    // warm sync throw after load routes the same way
    click(inside.querySelector(".fail"));
    expect(failures.length).toBe(2);
    expect(failures[1].boundary).toBe(boundary);
  });

  it("refuses a stale manifest, a stale record and a stale module, visibly", async () => {
    const artifact = await readArtifact("buy");
    const calls = await interceptActions();
    // schema mismatch: nothing installs
    const failures = [];
    expect(
      installBootstrap(
        { ...artifact.manifest, schema: 2 },
        { window: globalThis, document, report: f => failures.push(f) }
      )
    ).toBeNull();
    expect(failures.map(f => f.kind)).toEqual(["stale-manifest"]);

    // a record naming a scope the manifest no longer has
    mounted = mount({ ...artifact, manifest: { ...artifact.manifest, scopes: [] } });
    click(mounted.container.querySelector(".link"));
    expect(mounted.failures.map(f => f.kind)).toEqual(["stale-record"]);
    expect(mounted.controller.stats.loads).toBe(0);
    mounted.controller.uninstall();
    mounted.container.remove();

    // a module whose handler source hash differs from the manifest (a stale build)
    const stale = structuredClone(artifact.manifest);
    stale.handlers[0].source = "deadbeef";
    mounted = mount({ ...artifact, manifest: stale });
    click(mounted.container.querySelector(".link"));
    await mounted.controller.settled();
    await tick();
    expect(mounted.failures.map(f => f.kind)).toEqual(["chunk-failed"]);
    expect(mounted.failures[0].message).toContain("stale build");
    expect(calls).toEqual([]);
    // the module is not retried: it is stale, not unavailable
    click(mounted.container.querySelector(".link"));
    expect(mounted.failures.map(f => f.kind)).toEqual(["chunk-failed", "stale-module"]);
  });

  it("surfaces a chunk load failure for every queued event and retries on the next", async () => {
    const artifact = await readArtifact("buy");
    const calls = await interceptActions();
    let fail = true;
    const failures = [];
    const { markup, scripts } = splitScripts(artifact.html);
    const container = document.createElement("div");
    container.innerHTML = markup;
    document.body.appendChild(container);
    const controller = installBootstrap(artifact.manifest, {
      window: globalThis,
      document,
      report: f => failures.push(f),
      load: url => {
        if (fail && !url.endsWith("runtime.js")) return Promise.reject(new Error("network down"));
        return import(pathToFileURL(path.join(artifact.outDir, url)).href);
      }
    });
    for (const script of scripts) (0, eval)(script);
    mounted = { container, controller, failures };
    const link = container.querySelector(".link");
    click(link);
    click(link);
    await controller.settled();
    await tick();
    expect(failures.map(f => f.kind)).toEqual(["chunk-failed", "chunk-failed"]);
    expect(failures[0].error.message).toBe("network down");
    expect(controller.stats.failed).toBe(2);
    fail = false;
    click(link);
    await controller.settled();
    await tick();
    expect(calls.length).toBe(1);
  });

  it("never loads the component, and the initial page carries no handler body", async () => {
    const artifact = await readArtifact("buy");
    mounted = mount(artifact);
    const { loads, controller, container } = mounted;
    expect(loads).toEqual([]);
    click(container.querySelector(".link"));
    await controller.settled();
    expect(loads.sort()).toEqual([
      "./client/" + Object.keys(artifact.manifest.modules)[0] + ".js",
      "./client/runtime.js"
    ]);
    const chunk = await fs.readFile(path.join(artifact.outDir, loads[0]), "utf8");
    expect(chunk).not.toContain("function Buy");
    expect(chunk).not.toContain("_$template");
    expect(artifact.html).not.toContain('kind: "click"');
    expect(componentCalls).toBe(0);
  });

  it("keeps the action identity: the stub called is the id the manifest and the server registered", async () => {
    const artifact = await readArtifact("buy");
    const calls = await interceptActions();
    mounted = mount(artifact);
    click(mounted.container.querySelector(".link"));
    await mounted.controller.settled();
    await tick();
    const expected = artifact.manifest.handlers[0].captures.find(c => c.kind === "import").id;
    expect(calls[0].id).toBe(expected);
    const serverModule = await fs.readFile(
      path.join(artifact.outDir, "server", "buy", "actions.js"),
      "utf8"
    );
    expect(serverModule).toMatch(new RegExp(`registerServerReference_1\\(\\s*"${expected}"`));
  });
});

describe("fixture 2: local counter (signal + exact text binding reconstruction)", () => {
  it("first click updates 0 → 1 exactly once without invoking the component or re-rendering", async () => {
    const artifact = await readArtifact("counter");
    mounted = mount(artifact);
    const { container, controller, failures } = mounted;
    const [first, second] = container.querySelectorAll(".counter");
    const firstText = first.firstChild;
    expect(first.textContent).toBe("0");
    click(first);
    expect(first.textContent).toBe("0");
    await controller.settled();
    await tick();
    expect(first.textContent).toBe("1");
    expect(second.textContent).toBe("0");
    // the server's text node is the one updated: no re-created template
    expect(first.firstChild).toBe(firstText);
    expect(first.childNodes.length).toBe(1);
    // Two synchronous warm clicks read the same settled value, exactly as
    // handwritten Solid does (conformance golden: "click twice" → +1).
    click(first);
    click(first);
    await tick();
    expect(first.textContent).toBe("2");
    click(first);
    await tick();
    expect(first.textContent).toBe("3");
    click(second);
    await tick();
    expect(second.textContent).toBe("1");
    expect(failures).toEqual([]);
    expect(componentCalls).toBe(0);
    expect(controller.stats).toMatchObject({ cold: 1, warm: 4, loads: 1 });
  });

  it("binds a marked text hole and shares one signal between two handlers", async () => {
    const artifact = await readArtifact("counter");
    mounted = mount(artifact);
    const { container, controller, failures } = mounted;
    const labeled = container.querySelector(".labeled");
    const count = labeled.querySelector(".count");
    expect(count.textContent).toBe("Count: 10");
    click(labeled.querySelector(".inc"));
    click(labeled.querySelector(".inc"));
    click(labeled.querySelector(".dec"));
    await controller.settled();
    await tick();
    expect(count.textContent).toBe("Count: 11");
    expect(count.innerHTML).toBe("Count: <!--$-->11<!--/-->");
    click(labeled.querySelector(".dec"));
    await tick();
    expect(count.textContent).toBe("Count: 10");
    expect(failures).toEqual([]);
  });

  it("emits no hydration warnings or errors", async () => {
    const artifact = await readArtifact("counter");
    const warnings = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = (...args) => warnings.push(["warn", ...args]);
    console.error = (...args) => warnings.push(["error", ...args]);
    try {
      mounted = mount(artifact);
      click(mounted.container.querySelector(".counter"));
      await mounted.controller.settled();
      await tick();
    } finally {
      console.warn = warn;
      console.error = error;
    }
    expect(warnings).toEqual([]);
    expect(mounted.container.querySelector(".counter").textContent).toBe("1");
  });

  it("fails closed when the DOM no longer matches the scope descriptor", async () => {
    const artifact = await readArtifact("counter");
    mounted = mount(artifact);
    const { container, controller, failures } = mounted;
    const labeled = container.querySelector(".labeled");
    labeled.querySelector(".count").remove();
    click(labeled.querySelector(".inc"));
    await controller.settled();
    await tick();
    expect(failures.map(f => f.kind)).toEqual(["reconstruct-failed"]);
    expect(failures[0].message).toContain("has no text node");
  });
});

describe("prod / dev parity", () => {
  it("observable outcomes match; dev adds the prelude invariant report only", async () => {
    const artifact = await readArtifact("counter");
    const outcomes = [];
    for (const dev of [false, true]) {
      const { markup, scripts } = splitScripts(artifact.html);
      const container = document.createElement("div");
      container.innerHTML = markup;
      document.body.appendChild(container);
      const failures = [];
      const controller = installBootstrap(artifact.manifest, {
        window: globalThis,
        document,
        dev,
        report: f => failures.push(f.kind),
        load: url => import(pathToFileURL(path.join(artifact.outDir, url)).href)
      });
      for (const script of scripts) (0, eval)(script);
      const button = container.querySelector(".counter");
      click(button);
      click(button);
      await controller.settled();
      await tick();
      click(button);
      await tick();
      outcomes.push({ dev, text: button.textContent, failures, stats: { ...controller.stats } });
      controller.uninstall();
      container.remove();
    }
    // two cold clicks: the drain settles each one's writes before the next
    // runs (two native tasks), then one warm click
    expect(outcomes[0].text).toBe("3");
    expect(outcomes[1].text).toBe("3");
    expect(outcomes[0].failures).toEqual([]);
    expect(outcomes[1].failures).toEqual([]);
    expect(outcomes[0].stats).toEqual(outcomes[1].stats);
  });
});

describe("mutation tests: the suite detects a swallowed or duplicated first click", () => {
  async function mutant(name, edits) {
    const source = await fs.readFile(path.join(packageDir, "src", "bootstrap.js"), "utf8");
    let mutated = source;
    for (const [from, to] of edits) {
      const first = mutated.indexOf(from);
      expect(first, `edit must match: ${from}`).toBeGreaterThanOrEqual(0);
      expect(mutated.indexOf(from, first + 1), `edit must match once: ${from}`).toBe(-1);
      mutated = mutated.replace(from, to);
    }
    const dir = path.join(outDir, "mutants");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `bootstrap-${name}.js`);
    await fs.writeFile(file, mutated);
    return (await import(pathToFileURL(file).href)).install;
  }

  /** How many times the first cold click's action ran, and the counter text it produced. */
  async function firstClickProbe(install) {
    const calls = await interceptActions();
    const buy = await readArtifact("buy");
    const counter = await readArtifact("counter");
    const results = [];
    for (const artifact of [buy, counter]) {
      const { markup, scripts } = splitScripts(artifact.html);
      const container = document.createElement("div");
      container.innerHTML = markup;
      document.body.appendChild(container);
      const controller = install(artifact.manifest, {
        window: globalThis,
        document,
        report: () => {},
        load: url => import(pathToFileURL(path.join(artifact.outDir, url)).href)
      });
      for (const script of scripts) (0, eval)(script);
      const target = container.querySelector(".link") || container.querySelector(".counter");
      click(target);
      await controller.settled();
      await tick();
      results.push(target.textContent);
      controller.uninstall();
      container.remove();
    }
    return { actionCalls: calls.length, counterText: results[1] };
  }

  it("swallowed first click is caught", async () => {
    const install = await mutant("swallow", [
      [
        "state.runtime.invoke(instance, handler, entry.module[handler.export], item.snapshot, false);",
        "void instance;"
      ]
    ]);
    const probe = await firstClickProbe(install);
    expect(probe.actionCalls).not.toBe(1);
    expect(probe.counterText).not.toBe("1");
  });

  it("duplicated first click is caught", async () => {
    const install = await mutant("duplicate", [
      [
        "state.runtime.invoke(instance, handler, entry.module[handler.export], item.snapshot, false);",
        "state.runtime.invoke(instance, handler, entry.module[handler.export], item.snapshot, false); state.runtime.invoke(instance, handler, entry.module[handler.export], item.snapshot, false);"
      ]
    ]);
    const probe = await firstClickProbe(install);
    expect(probe.actionCalls).not.toBe(1);
  });

  it("the unmutated bootstrap passes the same probe", async () => {
    const probe = await firstClickProbe(installBootstrap);
    expect(probe.actionCalls).toBe(1);
    expect(probe.counterText).toBe("1");
  });
});
