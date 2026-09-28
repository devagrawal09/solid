// App and variant definitions for measure.mjs. Paths are relative to
// scripts/ssr-redesign (entries) or to the repo root (swaps, rewrites).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const HN_STORY = JSON.stringify(JSON.parse(readFileSync(join(ROOT, "examples/hackernews-spa/src/lib/story-30186326.json"), "utf8"))).replace(/</g, "\\u003c");

const TODOS_SEED = Array.from({ length: 100 }, (_, i) => ({
  id: String(100000 + i),
  title: `todo item number ${i}`,
  completed: i % 3 === 0
}));

// Browser-side helpers are plain functions serialized into the page.
async function waitUntil(pred) {
  for (let i = 0; i < 2000 && !pred(); i++) await (i < 200 ? Promise.resolve() : new Promise(r => setTimeout(r, 0)));
}

const TOGGLE_SWAP = "examples/hackernews-spa/src/components/toggle.tsx";
// The tier-1 island kernel (documentation/plans/island-runtime-tiers.md).
const KERNEL = join(ROOT, "packages/signals/src/kernel/index.ts");

export const APPS = {
  hn: {
    // The 1,406-comment story page of examples/hackernews-spa.
    tildeRoot: join(ROOT, "examples/hackernews-spa/src"),
    render: srv => srv.render(),
    session: [
      () => document.querySelectorAll(".toggle a")[0].click(),
      () => document.querySelectorAll(".toggle a")[5].click(),
      () => document.querySelectorAll(".toggle a")[0].click(),
      () => document.querySelectorAll(".toggle a")[40].click()
    ],
    stepWait: 150,
    markIdentity: () => {
      globalThis.__id = [document.querySelectorAll(".toggle")[5], document.querySelectorAll("li.comment")[100], document.querySelector("h1")];
    },
    checkIdentity: () =>
      globalThis.__id.every(n => n && n.isConnected) &&
      document.querySelectorAll(".toggle")[5] === globalThis.__id[0] &&
      document.querySelectorAll("li.comment")[100] === globalThis.__id[1],
    firstInteraction: new Function(
      `return (async () => { ${waitUntil.toString()}
        const a = document.querySelectorAll(".toggle a")[3]; const root = a.parentElement;
        const t = performance.now(); a.click();
        await waitUntil(() => !root.classList.contains("open"));
        return performance.now() - t; })()`
    ),
    variants: {
      // Today: hydrate the whole page from the serialized story.
      A: { server: "apps/hn/server.tsx", client: "apps/hn/client.tsx" },
      // P2 on its own: adopt the serialized story without re-running its
      // compute (the story memo's read set is empty).
      "A+adopt": {
        server: "apps/hn/server.tsx",
        client: "apps/hn/client.tsx",
        oracles: ["adopt"],
        rewrites: {
          "scripts/ssr-redesign/apps/hn/story.tsx": [
            [
              "createMemo(() => (globalThis as any).__loadStory() as Promise<StoryDefinition>)",
              "createMemo(() => (globalThis as any).__loadStory() as Promise<StoryDefinition>, { adopt: true } as any)"
            ]
          ]
        }
      },
      // Reference: client render from inline JSON (SPA; no server markup).
      CSR: {
        server: "apps/hn/server.tsx",
        client: "apps/hn/csr.tsx",
        hydratable: false,
        reference: true,
        page: () => `<div id="root"></div><script>window.__story=${HN_STORY}</script>`
      },
      // P1 on today's runtime: inert page, one hydrate() per Toggle island.
      "P1-rt": {
        server: "apps/hn/islands-rt/server.tsx",
        serverSwaps: { [TOGGLE_SWAP]: "scripts/ssr-redesign/apps/hn/islands-rt/toggle.server.tsx" },
        client: "apps/hn/islands-rt/client.tsx"
      },
      // P1 compiled activation (static addresses, no keys), all at load.
      "P1-eager": {
        server: "apps/hn/islands-static/server.tsx",
        serverSwaps: { [TOGGLE_SWAP]: "scripts/ssr-redesign/apps/hn/islands-static/toggle.server.tsx" },
        client: "apps/hn/islands-static/client-eager.ts"
      },
      // P1 compiled activation, per instance on its first event.
      "P1-lazy": {
        server: "apps/hn/islands-static/server.tsx",
        serverSwaps: { [TOGGLE_SWAP]: "scripts/ssr-redesign/apps/hn/islands-static/toggle.server.tsx" },
        client: "apps/hn/islands-static/client-lazy.ts",
        splitting: true
      },
      // Island runtime tiers (documentation/plans/island-runtime-tiers.md).
      // P1-eager / P1-lazy above are tier 2 (the full core). Tier 1 is the
      // same activation code bound to the kernel; tier 0 needs no runtime.
      "T1-eager": {
        server: "apps/hn/islands-static/server.tsx",
        serverSwaps: { [TOGGLE_SWAP]: "scripts/ssr-redesign/apps/hn/islands-static/toggle.server.tsx" },
        client: "apps/hn/islands-static/client-eager.ts",
        aliases: { "@solidjs/signals": KERNEL }
      },
      "T1-lazy": {
        server: "apps/hn/islands-static/server.tsx",
        serverSwaps: { [TOGGLE_SWAP]: "scripts/ssr-redesign/apps/hn/islands-static/toggle.server.tsx" },
        client: "apps/hn/islands-static/client-lazy.ts",
        splitting: true,
        aliases: { "@solidjs/signals": KERNEL }
      },
      "T0-eager": {
        server: "apps/hn/islands-static/server.tsx",
        serverSwaps: { [TOGGLE_SWAP]: "scripts/ssr-redesign/apps/hn/islands-static/toggle.server.tsx" },
        client: "apps/hn/islands-static/client-eager-t0.ts"
      },
      "T0-lazy": {
        server: "apps/hn/islands-static/server.tsx",
        serverSwaps: { [TOGGLE_SWAP]: "scripts/ssr-redesign/apps/hn/islands-static/toggle.server.tsx" },
        client: "apps/hn/islands-static/client-lazy-t0.ts",
        splitting: true
      },
      // Compiler emission (ssr-hydration-redesign.md, "Compiler emission"):
      // the same page written with generator blocks v2 (apps/hn-blocks),
      // gated against A (the markup is identical). C-* are `compileIslands`
      // output — the string-template server module and the generated
      // entry/chunks — at the tier the compiler chose (tier 0 for Toggle), or
      // raised with minTier to compare with T1/P1 above. A-blocks is the v2
      // source through today's pipeline (hydrate from the serialized story).
      "A-blocks": { server: "apps/hn-blocks/server.tsx", client: "apps/hn-blocks/client.tsx" },
      "C-eager": { server: "apps/hn-blocks/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "apps/hn-blocks/story.tsx", mode: "eager" } },
      "C-lazy": { server: "apps/hn-blocks/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "apps/hn-blocks/story.tsx", mode: "auto" }, splitting: true },
      "C-T1-eager": { server: "apps/hn-blocks/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "apps/hn-blocks/story.tsx", mode: "eager", minTier: 1 } },
      "C-T1-lazy": { server: "apps/hn-blocks/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "apps/hn-blocks/story.tsx", mode: "auto", minTier: 1 }, splitting: true },
      "C-T2-eager": { server: "apps/hn-blocks/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "apps/hn-blocks/story.tsx", mode: "eager", minTier: 2 } },
      "C-T2-lazy": { server: "apps/hn-blocks/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "apps/hn-blocks/story.tsx", mode: "auto", minTier: 2 }, splitting: true }
    }
  },
  sync: {
    // examples/sync-blocks: a small, fully interactive, async-free page.
    render: srv => srv.render(),
    session: [
      () => document.querySelector("button.warmer").click(),
      () => {
        const input = document.querySelector("input.draft");
        input.value = "first";
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      },
      () => document.querySelector("form.add").requestSubmit(),
      () => document.querySelector("ul.items label").click()
    ],
    stepWait: 50,
    markIdentity: () => {
      globalThis.__id = [document.querySelector("p.converter span"), document.querySelector("input.draft")];
    },
    checkIdentity: () => globalThis.__id.map(n => (n && n.isConnected ? 1 : 0)).join(""),
    firstInteraction: new Function(
      `return (async () => { ${waitUntil.toString()}
        const b = document.querySelector("button.warmer"); const span = document.querySelector("p.converter span"); const before = span.textContent;
        const t = performance.now(); b.click();
        await waitUntil(() => span.textContent !== before);
        return performance.now() - t; })()`
    ),
    variants: {
      A: { server: "apps/sync/server.tsx", client: "apps/sync/client.tsx" },
      CSR: { server: "apps/sync/server.tsx", client: "apps/sync/csr.tsx", hydratable: false, bytesOnly: true }
    }
  },
  todos: {
    // examples/todos-blocks (generator blocks v2), 100 todos.
    render: srv => srv.render(TODOS_SEED),
    init: `localStorage.setItem("TODOS", ${JSON.stringify(JSON.stringify(TODOS_SEED))}); Math.random = () => 0.5;`,
    session: [
      () => document.querySelectorAll("input.toggle")[1].click(),
      () => document.querySelectorAll("button.destroy")[2].click(),
      () => document.querySelector("input.toggle-all").click(),
      () => {
        location.hash = "#/active";
      },
      () => {
        const input = document.querySelector("input.new-todo");
        input.value = "a new one";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      },
      () => {
        location.hash = "#/";
      },
      () => document.querySelector("button.clear-completed").click()
    ],
    stepWait: 1100,
    markIdentity: () => {
      globalThis.__id = [document.querySelectorAll("li.todo")[5], document.querySelector("header")];
    },
    checkIdentity: () => globalThis.__id.map(n => (n && n.isConnected ? 1 : 0)).join(""),
    firstInteraction: new Function(
      `return (async () => { ${waitUntil.toString()}
        const input = document.querySelectorAll("input.toggle")[4]; const li = input.closest("li");
        const t = performance.now(); input.click();
        await waitUntil(() => li.classList.contains("pending"));
        return performance.now() - t; })()`
    ),
    variants: {
      A: { server: "apps/todos/server.tsx", client: "apps/todos/client.tsx" },
      // P2: the todos projection reads no reactive source before its await
      // (its compute is `api.getTodos()` + a plain side table), so its
      // serialized value is adopted without re-running the compute.
      "A+adopt": {
        server: "apps/todos/server.tsx",
        client: "apps/todos/client.tsx",
        oracles: ["adopt"],
        rewrites: {
          "examples/todos-blocks/src/todos.ts": [["  }, []);\n\n  const actions = {", "  }, [], { adopt: true } as any);\n\n  const actions = {"]]
        }
      },
      // Reference bundle: the same app client-rendered (what hydration adds).
      CSR: { server: "apps/todos/server.tsx", client: "apps/todos/csr.tsx", hydratable: false, bytesOnly: true },
      // Runtime-only on-interaction hydration of the whole app.
      "A-lazy": { server: "apps/todos/server.tsx", client: "apps/todos/client-lazy.ts", splitting: true },
      // Compiler emission: `compileIslands` on todos-blocks' app module, with
      // its imported factories inlined (cross-module): one island group at
      // tier 2 (an optimistic async store adopted from the server's value,
      // actions, a hash filter), lazy (the loader activates it on the first
      // event, or on `hashchange`); `C-eager` activates it at load.
      C: { server: "apps/todos/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "../../examples/todos-blocks/src/app.tsx", mode: "auto" }, splitting: true },
      "C-eager": { server: "apps/todos/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "../../examples/todos-blocks/src/app.tsx", mode: "eager" } }
    }
  },
  "todos-local": {
    // The todos-blocks UI over a synchronous local store (apps/todos-local),
    // for the island runtime tiers: the same 100 todos and session.
    render: srv => srv.render(TODOS_SEED),
    init: `localStorage.setItem("TODOS", ${JSON.stringify(JSON.stringify(TODOS_SEED))}); Math.random = () => 0.5;`,
    session: [
      () => document.querySelectorAll("input.toggle")[1].click(),
      () => document.querySelectorAll("button.destroy")[2].click(),
      () => document.querySelector("input.toggle-all").click(),
      () => {
        location.hash = "#/active";
      },
      () => {
        const input = document.querySelector("input.new-todo");
        input.value = "a new one";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      },
      () => document.querySelectorAll("input.toggle")[0].click(),
      () => {
        location.hash = "#/";
      },
      () => document.querySelector("button.clear-completed").click()
    ],
    stepWait: 50,
    markIdentity: () => {
      globalThis.__id = [document.querySelectorAll("li.todo")[5], document.querySelector("header")];
    },
    checkIdentity: () => globalThis.__id.map(n => (n && n.isConnected ? 1 : 0)).join(""),
    firstInteraction: new Function(
      `return (async () => { ${waitUntil.toString()}
        const input = document.querySelectorAll("input.toggle")[4]; const li = input.closest("li");
        const t = performance.now(); input.click();
        await waitUntil(() => { const l = document.querySelectorAll("li.todo")[4]; return l && l.classList.contains("completed"); });
        return performance.now() - t; })()`
    ),
    variants: {
      // Today: hydrate the whole app.
      A: { server: "apps/todos-local/server.tsx", client: "apps/todos-local/client.tsx" },
      CSR: { server: "apps/todos-local/server.tsx", client: "apps/todos-local/csr.tsx", hydratable: false, bytesOnly: true },
      // Compiled activation of the one island group (islands.ts), at load:
      // tier 2 binds it to the full core, tier 1 to the kernel.
      "T2-eager": { server: "apps/todos-local/server-islands.tsx", client: "apps/todos-local/client-eager.ts" },
      "T1-eager": { server: "apps/todos-local/server-islands.tsx", client: "apps/todos-local/client-eager.ts", aliases: { "@solidjs/signals": KERNEL } },
      // The same, on the first interaction (the loader replays it).
      "T2-lazy": { server: "apps/todos-local/server-islands.tsx", client: "apps/todos-local/client-lazy.ts", splitting: true },
      "T1-lazy": { server: "apps/todos-local/server-islands.tsx", client: "apps/todos-local/client-lazy.ts", splitting: true, aliases: { "@solidjs/signals": KERNEL } },
      // Outside the tier-0 rule (a keyed list, branches, memos): direct
      // updates written by hand, as the floor a list-aware tier 0 could reach.
      "T0*-eager": { server: "apps/todos-local/server-islands.tsx", client: "apps/todos-local/client-eager-t0.ts" },
      // Compiler emission: the same app written with generator blocks v2
      // (apps/todos-local-blocks), compiled by `compileIslands` — one island
      // group at tier 1 (kernel); T2 binds the same chunk to the core.
      "C-eager": { server: "apps/todos-local-blocks/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "apps/todos-local-blocks/app.tsx", mode: "eager" } },
      "C-lazy": { server: "apps/todos-local-blocks/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "apps/todos-local-blocks/app.tsx", mode: "lazy" }, splitting: true },
      "C-T2-eager": { server: "apps/todos-local-blocks/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "apps/todos-local-blocks/app.tsx", mode: "eager", minTier: 2 } },
      "C-T2-lazy": { server: "apps/todos-local-blocks/server-islands.ts", client: "apps/islands-client.ts", islands: { root: "apps/todos-local-blocks/app.tsx", mode: "lazy", minTier: 2 }, splitting: true }
    }
  }
};
