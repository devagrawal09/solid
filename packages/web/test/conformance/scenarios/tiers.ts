/**
 * Island runtime tiers (documentation/plans/island-runtime-tiers.md).
 *
 * Ordinary scenarios (reference oracle + blocks source) whose shapes are the
 * graphs the tiers compile: a self-contained toggle island (tier 0), two
 * cells with overlapping holes (tier 0: hole order and batching), two
 * islands sharing a cell through props with a memo and a branch (tier 1),
 * and a DOM-free diamond with render and user effects (the kernel). They run
 * in every applicable mode like any scenario; `tiers.spec.ts` additionally
 * runs them through the tier-0 / tier-1 activation stand-ins and through the
 * kernel, against the same oracle.
 */
import type { Scenario } from "../harness/types.js";

const clickFlush =
  (selector: string) => (ctx: { click(s: string): void; flush(): void; html(): void }) => {
    ctx.click(selector);
    ctx.flush();
    ctx.html();
  };

export const tierToggle: Scenario = {
  name: "tier-toggle",
  covers: [
    "tier 0: one cell written only by its own handler",
    "holes read unconditionally (class, text, style)",
    "writes batched until the flush",
    "a toggled-back batch still recomputes the holes"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { h } from "conformance";
export function App() {
  const [open, setOpen] = h.signal("open", true);
  return (
    <div>
      <div class={["toggle", { open: open() }]}>
        <a onClick={() => setOpen(o => !o)}>{open() ? "[-]" : "[+] comments collapsed"}</a>
      </div>
      <ul class="comment-children" style={{ display: open() ? "block" : "none" }}>
        <li>reply</li>
      </ul>
    </div>
  );
}
`,
    blocks: `
import { $component, $event } from "solid-js";
import { h } from "conformance";
export const App = $component(function* () {
  const [open, setOpen] = h.signal("open", true);
  const toggle = $event(function* () {
    setOpen(o => !o);
  });
  return function* () {
    return (
      <div>
        <div class={["toggle", { open: yield* open }]}>
          <a onClick={toggle}>{(yield* open) ? "[-]" : "[+] comments collapsed"}</a>
        </div>
        <ul class="comment-children" style={{ display: (yield* open) ? "block" : "none" }}>
          <li>reply</li>
        </ul>
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    { name: "click", run: clickFlush(".toggle a") },
    {
      name: "click (DOM unchanged until the flush)",
      run: ctx => {
        ctx.click(".toggle a");
        ctx.html();
        ctx.flush();
        ctx.html();
      }
    },
    {
      name: "two clicks in one batch",
      run: ctx => {
        ctx.click(".toggle a");
        ctx.click(".toggle a");
        ctx.flush();
        ctx.html();
      }
    }
  ]
};

export const tierTwoCells: Scenario = {
  name: "tier-two-cells",
  covers: [
    "tier 0: two cells, holes reading one or both",
    "hole order after a batch: first-written cell's holes first, each hole once",
    "handler reads see the committed value",
    "equal writes are no-ops"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { h } from "conformance";
export function App() {
  const [a, setA] = h.signal("a", 1);
  const [b, setB] = h.signal("b", 10);
  return (
    <p>
      <span class="h1">{b()}</span>
      <span class="h2">{a()}</span>
      <span class="h3">{a() + b()}</span>
      <button class="ab" onClick={() => { setA(x => x + 1); setB(x => x + 10); }} />
      <button class="ba" onClick={() => { setB(x => x + 10); setA(x => x + 1); }} />
      <button class="same" onClick={() => setA(a())} />
      <button class="peek" onClick={() => { setA(x => x + 1); h.value("a in handler", a()); }} />
    </p>
  );
}
`,
    blocks: `
import { $component, $event } from "solid-js";
import { h } from "conformance";
export const App = $component(function* () {
  const [a, setA] = h.signal("a", 1);
  const [b, setB] = h.signal("b", 10);
  const ab = $event(function* () { setA(x => x + 1); setB(x => x + 10); });
  const ba = $event(function* () { setB(x => x + 10); setA(x => x + 1); });
  const same = $event(function* () { setA(yield* a); });
  const peek = $event(function* () { setA(x => x + 1); h.value("a in handler", yield* a); });
  return function* () {
    return (
      <p>
        <span class="h1">{yield* b}</span>
        <span class="h2">{yield* a}</span>
        <span class="h3">{(yield* a) + (yield* b)}</span>
        <button class="ab" onClick={ab} />
        <button class="ba" onClick={ba} />
        <button class="same" onClick={same} />
        <button class="peek" onClick={peek} />
      </p>
    );
  };
});
`
  },
  modes: {
    "client/blocks-uncompiled": {
      status: "not-applicable",
      reason:
        "Hole order is the subject here, and the uncompiled view is one computation (every hole re-runs together, in view order), so it has no per-hole order to compare."
    }
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    { name: "write a then b", run: clickFlush(".ab") },
    { name: "write b then a", run: clickFlush(".ba") },
    { name: "equal write", run: clickFlush(".same") },
    { name: "read after write in a handler", run: clickFlush(".peek") }
  ]
};

export const tierShared: Scenario = {
  name: "tier-shared",
  covers: [
    "tier 1: a cell shared by two islands through props",
    "memo over the shared cell",
    "a branch over the memo (dynamic structure), cleanup when it closes"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo, Show } from "solid-js";
import { h } from "conformance";
function Counter(props) {
  return (
    <p class="counter">
      <button class="inc" onClick={() => props.set(c => c + 1)} />
      <button class="reset" onClick={() => props.set(0)} />
    </p>
  );
}
function Display(props) {
  const doubled = createMemo(() => {
    h.run("doubled");
    return props.count() * 2;
  });
  return (
    <p class="display">
      <span class="count">{props.count()}</span>
      <span class="doubled">{doubled()}</span>
      <Show when={doubled() > 4}>
        {(() => {
          h.run("big");
          h.cleanup("big");
          return <b>big</b>;
        })()}
      </Show>
    </p>
  );
}
export function App() {
  const [count, setCount] = h.signal("count", 1);
  return (
    <div>
      <Counter set={setCount} />
      <Display count={count} />
    </div>
  );
}
`,
    // Blocks v2 for the compiled-islands mode (islands.spec.ts): the branch
    // body is its own component (its setup runs when the branch opens).
    islands: `
import { $component, $event, $memo, Show } from "solid-js";
import { h } from "conformance";
const Counter = $component(function* (props) {
  const inc = $event(function* () { props.set(c => c + 1); });
  const reset = $event(function* () { props.set(0); });
  return function* () {
    return (
      <p class="counter">
        <button class="inc" onClick={inc} />
        <button class="reset" onClick={reset} />
      </p>
    );
  };
});
const Big = $component(function* () {
  h.run("big");
  h.cleanup("big");
  return function* () {
    return <b>big</b>;
  };
});
const Display = $component(function* (props) {
  const doubled = yield* $memo(function* () {
    h.run("doubled");
    return (yield* props.count) * 2;
  });
  return function* () {
    return (
      <p class="display">
        <span class="count">{yield* props.count}</span>
        <span class="doubled">{yield* doubled}</span>
        <Show when={(yield* doubled) > 4}>
          <Big />
        </Show>
      </p>
    );
  };
});
export const App = $component(function* () {
  const [count, setCount] = h.signal("count", 1);
  return function* () {
    return (
      <div>
        <Counter set={setCount} />
        <Display count={count} />
      </div>
    );
  };
});
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    { name: "inc (2)", run: clickFlush(".inc") },
    { name: "inc (3: branch opens)", run: clickFlush(".inc") },
    { name: "inc (4: branch stays)", run: clickFlush(".inc") },
    { name: "reset (branch closes, cleanup)", run: clickFlush(".reset") }
  ]
};

export const tierDiamond: Scenario = {
  name: "tier-diamond",
  covers: [
    "glitch-free diamond (each memo and effect once per batch)",
    "render effects before user effects",
    "effect cleanups before the next run",
    "a batch that returns to the committed value"
  ],
  entry: { root: "setup" },
  sources: {
    reference: `
import { createMemo, createEffect, createRenderEffect } from "solid-js";
import { h } from "conformance";
export let setA, setB;
export function setup() {
  const [a, sa] = h.signal("a", 1);
  const [b, sb] = h.signal("b", 1);
  setA = sa;
  setB = sb;
  const sum = createMemo(() => {
    h.run("sum");
    return a() + b();
  });
  const prod = createMemo(() => {
    h.run("prod");
    return a() * b();
  });
  createEffect(
    () => sum(),
    v => {
      h.value("user", v);
      return () => h.log("cleanup", "user " + v);
    }
  );
  createRenderEffect(
    () => {
      const pair = [sum(), prod()];
      h.value("render pair", pair);
      return pair[0] + pair[1];
    },
    v => {
      h.value("render", v);
      return () => h.log("cleanup", "render " + v);
    }
  );
}
`
  },
  steps: [
    {
      name: "write a and b in one batch",
      run: ({ app, flush }) => {
        app.setA(2);
        app.setB(3);
        flush();
      }
    },
    {
      name: "write a (sum and prod change)",
      run: ({ app, flush }) => {
        app.setA(3);
        flush();
      }
    },
    {
      name: "write a away and back in one batch",
      run: ({ app, flush }) => {
        app.setA(4);
        app.setA(3);
        flush();
      }
    },
    {
      name: "equal writes (no-op)",
      run: ({ app, flush }) => {
        app.setA(3);
        app.setB(3);
        flush();
      }
    }
  ]
};

export const tierScenarios = [tierToggle, tierTwoCells, tierShared, tierDiamond];
