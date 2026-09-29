/**
 * Cross-runtime flush order (documentation/plans/island-runtime-tiers.md,
 * "Cross-runtime flush"). One page can run islands on different reactive
 * runtimes: tier 0 (the t0 helper), tier 1 (the kernel) and tier 2 (the
 * core). Islands never share a cell, but one event can reach two islands on
 * different runtimes, and an effect in one can read the other's DOM. In the
 * single-runtime oracle both islands' writes land in one flush: every render
 * effect (DOM write) runs before any user effect. These scenarios pin that
 * contract for split runtimes.
 *
 * Every step lets the page flush on its own (no `ctx.flush()` between the
 * event and the observation): `ctx.settle()` drains microtasks in their
 * natural order first, so the order in which the runtimes' microtasks run
 * is what the trace sees.
 *
 * `islands.spec.ts` runs each at the compiler's tiers (asserted:
 * `islandTiers`), raised to tier 1, and raised to tier 2 (the control);
 * `islandsOptions.tier1Core` binds tier-1 groups to the core.
 */
import type { DriverContext, Scenario } from "../harness/types.js";

/** Run, let every runtime flush on its own microtasks, record the DOM. */
const step = (name: string, run: (ctx: DriverContext) => void | Promise<void>) => ({
  name,
  run: async (ctx: DriverContext) => {
    await run(ctx);
    await ctx.settle();
    ctx.html();
  }
});

// --- nested anchors: the outer island's effect reads the inner island's DOM ------------

const outerReadsInnerReference = `
import { createEffect } from "solid-js";
import { h } from "conformance";
function Inner() {
  const [a, setA] = h.signal("a", 1);
  return <button class="inner" onClick={() => setA(x => x + 1)}>{a()}</button>;
}
export function App() {
  const [b, setB] = h.signal("b", 10);
  createEffect(
    () => b(),
    v => {
      h.value("effect b", v);
      h.value("effect sees inner", document.querySelector(".inner").textContent);
    }
  );
  return (
    <div class="outer" onClick={() => setB(x => x + 10)}>
      <p class="b">{b()}</p>
      <Inner />
    </div>
  );
}
`;
const outerReadsInnerIslands = `
import { $component, $event, $effect } from "solid-js";
import { h } from "conformance";
const Inner = $component(function* () {
  const [a, setA] = h.signal("a", 1);
  const inc = $event(function* () { setA(x => x + 1); });
  return function* () {
    return <button class="inner" onClick={inc}>{yield* a}</button>;
  };
});
export const App = $component(function* () {
  const [b, setB] = h.signal("b", 10);
  const bump = $event(function* () { setB(x => x + 10); });
  yield* $effect(function* () {
    const v = yield* b;
    h.value("effect b", v);
    h.value("effect sees inner", document.querySelector(".inner").textContent);
  });
  return function* () {
    return (
      <div class="outer" onClick={bump}>
        <p class="b">{yield* b}</p>
        <Inner />
      </div>
    );
  };
});
`;
const outerReadsInnerSteps = [
  { name: "initial", run: (ctx: DriverContext) => ctx.html() },
  step("click inner (both islands write)", ctx => ctx.click(".inner")),
  step("click outer only", ctx => ctx.click(".b")),
  step("click inner again", ctx => ctx.click(".inner"))
];

export const islandsTiersOuterReadsInner: Scenario = {
  name: "islands-tiers-outer-reads-inner",
  covers: [
    "one click reaches a tier-0 island (inner) and a tier-1 island (outer)",
    "the outer island's user effect reads the inner island's DOM"
  ],
  entry: { component: "App" },
  sources: { reference: outerReadsInnerReference, islands: outerReadsInnerIslands },
  islandTiers: { Inner: 0, App: 1 },
  steps: outerReadsInnerSteps
};

export const islandsTiersOuterReadsInnerCore: Scenario = {
  ...islandsTiersOuterReadsInner,
  name: "islands-tiers-outer-reads-inner-core",
  covers: ["the same with the outer island bound to the core (tier 1 on the core, `tier1Core`)"],
  islandsOptions: { tier1Core: true }
};

// --- nested anchors: the inner island's effect reads the outer island's DOM ------------
// The inner handler runs first (bubbling), so the inner runtime's microtask is
// queued first: split runtimes flush the effect before the outer DOM write.

const innerReadsOuterReference = (tier2: boolean) => `
import { createEffect${tier2 ? ", createStore" : ""} } from "solid-js";
import { h } from "conformance";
function Inner() {
  const [b, setB] = h.signal("b", 10);
${tier2 ? `  const [log, setLog] = createStore({ clicks: 0 });\n` : ""}  createEffect(
    () => b(),
    v => {
      h.value("effect b", v);
      h.value("effect sees outer", document.querySelector(".a").textContent);
    }
  );
  return (
    <button class="inner" onClick={() => { setB(x => x + 10);${tier2 ? " setLog(s => { s.clicks++; });" : ""} }}>
      {b()}${tier2 ? "{log.clicks}" : ""}
    </button>
  );
}
export function App() {
  const [a, setA] = h.signal("a", 1);
  return (
    <div class="outer" onClick={() => setA(x => x + 1)}>
      <p class="a">{a()}</p>
      <Inner />
    </div>
  );
}
`;
const innerReadsOuterIslands = (tier2: boolean) => `
import { $component, $event, $effect${tier2 ? ", $store, readStore" : ""} } from "solid-js";
import { h } from "conformance";
const Inner = $component(function* () {
  const [b, setB] = h.signal("b", 10);
${tier2 ? `  const [log, setLog] = yield* $store({ clicks: 0 });\n` : ""}  const bump = $event(function* () { setB(x => x + 10);${tier2 ? " setLog(s => { s.clicks++; });" : ""} });
  yield* $effect(function* () {
    const v = yield* b;
    h.value("effect b", v);
    h.value("effect sees outer", document.querySelector(".a").textContent);
  });
  return function* () {
    return <button class="inner" onClick={bump}>{yield* b}${tier2 ? "{yield* readStore(log, s => s.clicks)}" : ""}</button>;
  };
});
export const App = $component(function* () {
  const [a, setA] = h.signal("a", 1);
  const inc = $event(function* () { setA(x => x + 1); });
  return function* () {
    return (
      <div class="outer" onClick={inc}>
        <p class="a">{yield* a}</p>
        <Inner />
      </div>
    );
  };
});
`;
const innerReadsOuterSteps = [
  { name: "initial", run: (ctx: DriverContext) => ctx.html() },
  step("click inner (both islands write)", ctx => ctx.click(".inner")),
  step("click outer only", ctx => ctx.click(".a")),
  step("click inner again", ctx => ctx.click(".inner"))
];

export const islandsTiersInnerReadsOuter: Scenario = {
  name: "islands-tiers-inner-reads-outer",
  covers: [
    "one click reaches a tier-1 island (inner, its handler runs first) and a tier-0 island (outer)",
    "the inner island's user effect reads the outer island's DOM"
  ],
  entry: { component: "App" },
  sources: { reference: innerReadsOuterReference(false), islands: innerReadsOuterIslands(false) },
  islandTiers: { App: 0, Inner: 1 },
  steps: innerReadsOuterSteps
};

export const islandsTiersInnerReadsOuterCore: Scenario = {
  ...islandsTiersInnerReadsOuter,
  name: "islands-tiers-inner-reads-outer-core",
  covers: ["the same with the inner island bound to the core (`tier1Core`)"],
  islandsOptions: { tier1Core: true }
};

export const islandsTiersInnerReadsOuterTier2: Scenario = {
  name: "islands-tiers-inner-reads-outer-tier2",
  covers: ["the same with the inner island on the core at tier 2 (a store)"],
  entry: { component: "App" },
  sources: { reference: innerReadsOuterReference(true), islands: innerReadsOuterIslands(true) },
  islandTiers: { App: 0, Inner: 2 },
  steps: innerReadsOuterSteps
};

// --- sibling islands ---------------------------------------------------------------------

/** One component, two cells: two islands on one anchor, t0 (outer handler) and kernel. */
export const islandsTiersSameAnchor: Scenario = {
  name: "islands-tiers-same-anchor",
  covers: [
    "two islands of one component on one anchor (tier 0 and tier 1)",
    "the kernel island's handler runs first; its effect reads the tier-0 island's DOM"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createEffect } from "solid-js";
import { h } from "conformance";
export function App() {
  const [a, setA] = h.signal("a", 1);
  const [b, setB] = h.signal("b", 10);
  createEffect(
    () => b(),
    v => h.value("effect sees a", document.querySelector(".a").textContent)
  );
  return (
    <div class="outer" onClick={() => setA(x => x + 1)}>
      <p class="a">{a()}</p>
      <button class="inner" onClick={() => setB(x => x + 10)}>{b()}</button>
    </div>
  );
}
`,
    islands: `
import { $component, $event, $effect } from "solid-js";
import { h } from "conformance";
export const App = $component(function* () {
  const [a, setA] = h.signal("a", 1);
  const [b, setB] = h.signal("b", 10);
  const incA = $event(function* () { setA(x => x + 1); });
  const incB = $event(function* () { setB(x => x + 10); });
  yield* $effect(function* () {
    const v = yield* b;
    h.value("effect sees a", document.querySelector(".a").textContent);
  });
  return function* () {
    return (
      <div class="outer" onClick={incA}>
        <p class="a">{yield* a}</p>
        <button class="inner" onClick={incB}>{yield* b}</button>
      </div>
    );
  };
});
`
  },
  islandTiers: { "App.a": 0, "App.b": 1 },
  steps: [
    { name: "initial", run: ctx => ctx.html() },
    step("click inner (both islands write)", ctx => ctx.click(".inner")),
    step("click inner again", ctx => ctx.click(".inner"))
  ]
};

/**
 * DOM siblings: a kernel island listening on `window` (a settled listener)
 * and a tier-0 island's button. One click runs the tier-0 handler (target),
 * then the window listener.
 */
export const islandsTiersWindowSibling: Scenario = {
  name: "islands-tiers-window-sibling",
  covers: [
    "sibling islands reacting to one event: a tier-0 button and a kernel window listener",
    "the kernel island's effect reads the tier-0 island's DOM"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createEffect, onCleanup } from "solid-js";
import { h } from "conformance";
function Counter() {
  const [a, setA] = h.signal("a", 1);
  return <button class="inner" onClick={() => setA(x => x + 1)}>{a()}</button>;
}
function Watcher() {
  const [b, setB] = h.signal("b", 10);
  const bump = () => setB(x => x + 10);
  window.addEventListener("click", bump);
  onCleanup(() => window.removeEventListener("click", bump));
  createEffect(
    () => b(),
    v => h.value("effect sees inner", document.querySelector(".inner").textContent)
  );
  return <p class="b">{b()}</p>;
}
export function App() {
  return (
    <div>
      <Watcher />
      <Counter />
    </div>
  );
}
`,
    islands: `
import { $component, $event, $effect, $settled, $cleanup } from "solid-js";
import { h } from "conformance";
const Counter = $component(function* () {
  const [a, setA] = h.signal("a", 1);
  const inc = $event(function* () { setA(x => x + 1); });
  return function* () {
    return <button class="inner" onClick={inc}>{yield* a}</button>;
  };
});
const Watcher = $component(function* () {
  const [b, setB] = h.signal("b", 10);
  const bump = $event(function* () { setB(x => x + 10); });
  yield* $settled(function* () {
    window.addEventListener("click", bump);
    yield* $cleanup(() => window.removeEventListener("click", bump));
  });
  yield* $effect(function* () {
    const v = yield* b;
    h.value("effect sees inner", document.querySelector(".inner").textContent);
  });
  return function* () {
    return <p class="b">{yield* b}</p>;
  };
});
export const App = $component(function* () {
  return function* () {
    return (
      <div>
        <Watcher />
        <Counter />
      </div>
    );
  };
});
`
  },
  islandTiers: { Counter: 0, Watcher: 1 },
  steps: [
    { name: "initial", run: ctx => ctx.html() },
    step("click the button (both islands write)", ctx => ctx.click(".inner")),
    step("click elsewhere (the window listener only)", ctx => ctx.click(".b"))
  ]
};

// --- activation order ------------------------------------------------------------------------
// The inner-reads-outer shape with no island active at mount. The cells are
// untraced and the effect records only after a change, so activation itself
// is silent at every tier (the oracle's mount is outside the steps); the
// effect's DOM read is the observation.

const activationReference = `
import { createEffect, createSignal } from "solid-js";
import { h } from "conformance";
function Inner() {
  const [b, setB] = createSignal(10);
  createEffect(
    () => b(),
    v => { if (v !== 10) h.value("effect sees outer", document.querySelector(".a").textContent); }
  );
  return <button class="inner" onClick={() => setB(x => x + 10)}>{b()}</button>;
}
export function App() {
  const [a, setA] = createSignal(1);
  return (
    <div class="outer" onClick={() => setA(x => x + 1)}>
      <p class="a">{a()}</p>
      <Inner />
    </div>
  );
}
`;
const activationIslands = `
import { $component, $event, $effect, $signal } from "solid-js";
import { h } from "conformance";
const Inner = $component(function* () {
  const [b, setB] = yield* $signal(10);
  const bump = $event(function* () { setB(x => x + 10); });
  yield* $effect(function* () {
    const v = yield* b;
    if (v !== 10) h.value("effect sees outer", document.querySelector(".a").textContent);
  });
  return function* () {
    return <button class="inner" onClick={bump}>{yield* b}</button>;
  };
});
export const App = $component(function* () {
  const [a, setA] = yield* $signal(1);
  const inc = $event(function* () { setA(x => x + 1); });
  return function* () {
    return (
      <div class="outer" onClick={inc}>
        <p class="a">{yield* a}</p>
        <Inner />
      </div>
    );
  };
});
`;
/** Island ids as the compiler assigns them for `activationIslands` (asserted by `islandTiers`). */
const T0_ISLAND = "i1",
  K_ISLAND = "i0";
const activate = (id: string, what: string) => ({
  name: `activate ${id} (${what})`,
  run: (ctx: DriverContext) => {
    ctx.activate?.(id);
    ctx.html();
  }
});
const activation = (name: string, what: string, steps: Scenario["steps"]): Scenario => ({
  name,
  covers: [`activation order: ${what}`, "then one click reaches both islands"],
  entry: { component: "App" },
  manualActivation: true,
  sources: { reference: activationReference, islands: activationIslands },
  islandTiers: { App: 0, Inner: 1 },
  islandIds: { App: T0_ISLAND, Inner: K_ISLAND },
  steps: [
    ...steps,
    step("click inner (both islands write)", ctx => ctx.click(".inner")),
    step("click inner again", ctx => ctx.click(".inner"))
  ]
});

export const islandsTiersActivateKernelFirst = activation(
  "islands-tiers-activate-kernel-first",
  "the kernel island first, then the tier-0 island",
  [activate(K_ISLAND, "kernel"), activate(T0_ISLAND, "tier 0")]
);
export const islandsTiersActivateT0First = activation(
  "islands-tiers-activate-t0-first",
  "the tier-0 island first, then the kernel island",
  [activate(T0_ISLAND, "tier 0"), activate(K_ISLAND, "kernel")]
);
/**
 * The loader's first-event path: the kernel island is active (a hot island
 * activates at load); the tier-0 island activates on the first click, whose
 * event the loader stops and replays after `activate(el); flush()`.
 */
export const islandsTiersFirstEvent = activation(
  "islands-tiers-first-event",
  "the kernel island at load, the tier-0 island on the first click (activate, flush, replay)",
  [
    activate(K_ISLAND, "kernel, at load"),
    step("first click: tier-0 island activates, the click replays", ctx => {
      ctx.activate?.(T0_ISLAND);
      ctx.click(".inner");
    })
  ]
);
/** The reverse first-event path: tier 0 active, the kernel island activates on the click. */
export const islandsTiersFirstEventKernel = activation(
  "islands-tiers-first-event-kernel",
  "the tier-0 island first, the kernel island on the first click (activate, flush, replay)",
  [
    activate(T0_ISLAND, "tier 0"),
    step("first click: kernel island activates, the click replays", ctx => {
      ctx.activate?.(K_ISLAND);
      ctx.click(".inner");
    })
  ]
);

// --- explicit flush, async continuations ----------------------------------------------------------

/**
 * `$flush()` in a handler must flush the page: the inner (tier-0) handler
 * ran first and its write is pending when the outer handler flushes.
 */
export const islandsTiersFlushInHandler: Scenario = {
  name: "islands-tiers-flush-in-handler",
  covers: [
    "an explicit `$flush()` in a kernel handler after another runtime's write",
    "the effect it runs and the handler after it read the other island's DOM"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createEffect, flush } from "solid-js";
import { h } from "conformance";
function Inner() {
  const [a, setA] = h.signal("a", 1);
  return <button class="inner" onClick={() => setA(x => x + 1)}>{a()}</button>;
}
export function App() {
  const [b, setB] = h.signal("b", 10);
  createEffect(
    () => b(),
    v => h.value("effect sees inner", document.querySelector(".inner").textContent)
  );
  const bump = () => {
    setB(x => x + 10);
    flush();
    h.value("handler sees inner", document.querySelector(".inner").textContent);
  };
  return (
    <div class="outer" onClick={bump}>
      <p class="b">{b()}</p>
      <Inner />
    </div>
  );
}
`,
    islands: `
import { $component, $event, $effect, $flush } from "solid-js";
import { h } from "conformance";
const Inner = $component(function* () {
  const [a, setA] = h.signal("a", 1);
  const inc = $event(function* () { setA(x => x + 1); });
  return function* () {
    return <button class="inner" onClick={inc}>{yield* a}</button>;
  };
});
export const App = $component(function* () {
  const [b, setB] = h.signal("b", 10);
  const bump = $event(function* () {
    setB(x => x + 10);
    yield* $flush();
    h.value("handler sees inner", document.querySelector(".inner").textContent);
  });
  yield* $effect(function* () {
    const v = yield* b;
    h.value("effect sees inner", document.querySelector(".inner").textContent);
  });
  return function* () {
    return (
      <div class="outer" onClick={bump}>
        <p class="b">{yield* b}</p>
        <Inner />
      </div>
    );
  };
});
`
  },
  islandTiers: { Inner: 0, App: 1 },
  steps: [
    { name: "initial", run: ctx => ctx.html() },
    step("click inner (inner writes, outer writes and flushes)", ctx => ctx.click(".inner")),
    step("click outer only", ctx => ctx.click(".b"))
  ]
};

/**
 * Async `$event`s: one click starts a flight in each island (tier 0 inner,
 * kernel outer); both flights settle in one step, and each continuation
 * writes its own island's cell. The outer settles first.
 */
export const islandsTiersAsyncContinuations: Scenario = {
  name: "islands-tiers-async-continuations",
  covers: [
    "async `$event` continuations in two islands on different runtimes, settled together",
    "the kernel island's effect reads the tier-0 island's DOM after both continuations"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createEffect } from "solid-js";
import { h } from "conformance";
function Inner() {
  const [a, setA] = h.signal("a", 1);
  const inc = async () => {
    const v = await h.task("inner");
    setA(x => x + v);
  };
  return <button class="inner" onClick={inc}>{a()}</button>;
}
export function App() {
  const [b, setB] = h.signal("b", 10);
  createEffect(
    () => b(),
    v => h.value("effect sees inner", document.querySelector(".inner").textContent)
  );
  const bump = async () => {
    const v = await h.task("outer");
    setB(x => x + v);
  };
  return (
    <div class="outer" onClick={bump}>
      <p class="b">{b()}</p>
      <Inner />
    </div>
  );
}
`,
    islands: `
import { $component, $event, $effect, attempt } from "solid-js";
import { h } from "conformance";
const Inner = $component(function* () {
  const [a, setA] = h.signal("a", 1);
  const inc = $event(function* () {
    const v = yield* attempt(() => h.task("inner"));
    setA(x => x + v);
  });
  return function* () {
    return <button class="inner" onClick={inc}>{yield* a}</button>;
  };
});
export const App = $component(function* () {
  const [b, setB] = h.signal("b", 10);
  const bump = $event(function* () {
    const v = yield* attempt(() => h.task("outer"));
    setB(x => x + v);
  });
  yield* $effect(function* () {
    const v = yield* b;
    h.value("effect sees inner", document.querySelector(".inner").textContent);
  });
  return function* () {
    return (
      <div class="outer" onClick={bump}>
        <p class="b">{yield* b}</p>
        <Inner />
      </div>
    );
  };
});
`
  },
  islandTiers: { Inner: 0, App: 1 },
  steps: [
    { name: "initial", run: ctx => ctx.html() },
    step("click inner (two flights start)", ctx => ctx.click(".inner")),
    step("both flights settle (outer first)", ctx => {
      ctx.tasks.resolve("outer#1", 10);
      ctx.tasks.resolve("inner#1", 1);
    }),
    step("click inner again", ctx => ctx.click(".inner")),
    step("both flights settle (inner first)", ctx => {
      ctx.tasks.resolve("inner#2", 1);
      ctx.tasks.resolve("outer#2", 10);
    })
  ]
};

export const islandsTierScenarios: Scenario[] = [
  islandsTiersOuterReadsInner,
  islandsTiersOuterReadsInnerCore,
  islandsTiersInnerReadsOuter,
  islandsTiersInnerReadsOuterCore,
  islandsTiersInnerReadsOuterTier2,
  islandsTiersSameAnchor,
  islandsTiersWindowSibling,
  islandsTiersActivateKernelFirst,
  islandsTiersActivateT0First,
  islandsTiersFirstEvent,
  islandsTiersFirstEventKernel,
  islandsTiersFlushInHandler,
  islandsTiersAsyncContinuations
];
