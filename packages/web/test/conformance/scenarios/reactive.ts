/**
 * Synchronous reactive-core scenarios (no DOM): initial values, rerun
 * order, equality suppression, dynamic subscriptions, cleanup, nesting.
 */
import type { Scenario } from "../harness/types.js";

export const memoEffectOrder: Scenario = {
  name: "memo-effect-order",
  covers: ["initial values", "rerun order", "equality suppression", "memo/effect scheduling"],
  entry: { root: "setup" },
  sources: {
    reference: `
import { createMemo, createEffect } from "solid-js";
import { h } from "conformance";
export let setCount;
export function setup() {
  const [count, set] = h.signal("count", 1);
  setCount = set;
  const double = createMemo(() => {
    h.run("double");
    return count() * 2;
  });
  const big = createMemo(() => {
    h.run("big");
    return double() > 4;
  });
  createEffect(
    () => {
      h.run("effect.compute");
      return big();
    },
    value => h.value("effect", value)
  );
}
`,
    generator: `
import { $, createMemo, createEffect } from "solid-js";
import { h } from "conformance";
export let setCount;
export function setup() {
  const [count, set] = h.signal("count", 1);
  setCount = set;
  const double = createMemo(
    $(function* () {
      h.run("double");
      return (yield* count) * 2;
    })
  );
  const big = createMemo(
    $(function* () {
      h.run("big");
      return (yield* double) > 4;
    })
  );
  createEffect(
    $(function* () {
      h.run("effect.compute");
      return yield* big;
    }),
    value => h.value("effect", value)
  );
}
`
  },
  steps: [
    {
      name: "write 2 (big stays false: effect suppressed)",
      run: ({ app, flush }) => {
        app.setCount(2);
        flush();
      }
    },
    {
      name: "write 2 again (signal equality)",
      run: ({ app, flush }) => {
        app.setCount(2);
        flush();
      }
    },
    {
      name: "write 3 (big flips)",
      run: ({ app, flush }) => {
        app.setCount(3);
        flush();
      }
    }
  ]
};

export const dynamicSubscriptions: Scenario = {
  name: "dynamic-subscriptions",
  covers: [
    "unconditional subscriptions",
    "branch-sensitive subscriptions",
    "unsubscribe / resubscribe"
  ],
  entry: { root: "setup" },
  sources: {
    reference: `
import { createMemo, createEffect } from "solid-js";
import { h } from "conformance";
export let setFlag, setA, setB;
export function setup() {
  const [flag, f] = h.signal("flag", true);
  const [a, sa] = h.signal("a", 1);
  const [b, sb] = h.signal("b", 10);
  setFlag = f;
  setA = sa;
  setB = sb;
  const pick = createMemo(() => {
    h.run("pick");
    return flag() ? a() : b();
  });
  const sum = createMemo(() => {
    h.run("sum");
    return a() + b();
  });
  createEffect(pick, v => h.value("pick", v));
  createEffect(sum, v => h.value("sum", v));
}
`,
    generator: `
import { $, createMemo, createEffect } from "solid-js";
import { h } from "conformance";
export let setFlag, setA, setB;
export function setup() {
  const [flag, f] = h.signal("flag", true);
  const [a, sa] = h.signal("a", 1);
  const [b, sb] = h.signal("b", 10);
  setFlag = f;
  setA = sa;
  setB = sb;
  const pick = createMemo(
    $(function* () {
      h.run("pick");
      return (yield* flag) ? yield* a : yield* b;
    })
  );
  const sum = createMemo(
    $(function* () {
      h.run("sum");
      return (yield* a) + (yield* b);
    })
  );
  createEffect(pick, v => h.value("pick", v));
  createEffect(sum, v => h.value("sum", v));
}
`
  },
  steps: [
    {
      name: "write b while flag (pick not subscribed to b)",
      run: ({ app, flush }) => {
        app.setB(11);
        flush();
      }
    },
    {
      name: "write a while flag",
      run: ({ app, flush }) => {
        app.setA(2);
        flush();
      }
    },
    {
      name: "flip flag off (unsubscribe a, subscribe b)",
      run: ({ app, flush }) => {
        app.setFlag(false);
        flush();
      }
    },
    {
      name: "write a after unsubscribe",
      run: ({ app, flush }) => {
        app.setA(3);
        flush();
      }
    },
    {
      name: "write b after subscribe",
      run: ({ app, flush }) => {
        app.setB(12);
        flush();
      }
    },
    {
      name: "flip flag on (resubscribe a)",
      run: ({ app, flush }) => {
        app.setFlag(true);
        flush();
      }
    },
    {
      name: "write b after unsubscribe",
      run: ({ app, flush }) => {
        app.setB(13);
        flush();
      }
    }
  ]
};

export const ownedChildren: Scenario = {
  name: "owned-children",
  covers: [
    "cleanup on recomputation",
    "child-owner disposal across recomputation",
    "nested computations",
    "disposal order"
  ],
  entry: { root: "setup" },
  sources: {
    reference: `
import { createMemo, createEffect } from "solid-js";
import { h } from "conformance";
export let setOuter, setInner;
export function setup() {
  const [outer, so] = h.signal("outer", 1);
  const [inner, si] = h.signal("inner", 1);
  setOuter = so;
  setInner = si;
  const parent = createMemo(() => {
    const o = outer();
    h.run("parent(" + o + ")");
    h.cleanup("parent(" + o + ")");
    const child = createMemo(() => {
      const i = inner();
      h.run("child(" + o + "," + i + ")");
      h.cleanup("child(" + o + "," + i + ")");
      return o * 100 + i;
    });
    createEffect(child, v => {
      h.value("child", v);
      return () => h.log("effect-cleanup", "child(" + v + ")");
    });
    return o;
  });
  createEffect(parent, v => h.value("parent", v));
}
`,
    generator: `
import { $, createMemo, createEffect } from "solid-js";
import { h } from "conformance";
export let setOuter, setInner;
export function setup() {
  const [outer, so] = h.signal("outer", 1);
  const [inner, si] = h.signal("inner", 1);
  setOuter = so;
  setInner = si;
  const parent = createMemo(
    $(function* () {
      const o = yield* outer;
      h.run("parent(" + o + ")");
      h.cleanup("parent(" + o + ")");
      const child = createMemo(
        $(function* () {
          const i = yield* inner;
          h.run("child(" + o + "," + i + ")");
          h.cleanup("child(" + o + "," + i + ")");
          return o * 100 + i;
        })
      );
      createEffect(child, v => {
        h.value("child", v);
        return () => h.log("effect-cleanup", "child(" + v + ")");
      });
      return o;
    })
  );
  createEffect(parent, v => h.value("parent", v));
}
`
  },
  steps: [
    {
      name: "write inner (child reruns, parent does not)",
      run: ({ app, flush }) => {
        app.setInner(2);
        flush();
      }
    },
    {
      name: "write outer (parent reruns, old child disposed)",
      run: ({ app, flush }) => {
        app.setOuter(2);
        flush();
      }
    },
    {
      name: "write inner again (only the new child)",
      run: ({ app, flush }) => {
        app.setInner(3);
        flush();
      }
    }
  ]
};

export const ownerRouting: Scenario = {
  name: "owner-routing",
  covers: ["owner identity", "context through owners", "untrack keeps the owner"],
  entry: { root: "setup" },
  sources: {
    reference: `
import { createMemo, createEffect, createContext, useContext, untrack } from "solid-js";
import { h } from "conformance";
const Theme = createContext("default");
export let setN;
export function setup() {
  h.owner("root");
  h.where("setup");
  const [n, sn] = h.signal("n", 1);
  setN = sn;
  const m = createMemo(() => {
    h.owner("memo");
    h.where("memo body");
    const v = n();
    untrack(() => h.where("memo untrack"));
    h.value("theme in memo", useContext(Theme));
    return v;
  });
  createEffect(
    () => {
      h.owner("effect");
      h.where("effect compute");
      return m();
    },
    v => {
      h.where("effect callback");
      h.value("m", v);
    }
  );
}
`,
    generator: `
import { $, createMemo, createEffect, createContext, useContext, untrack } from "solid-js";
import { h } from "conformance";
const Theme = createContext("default");
export let setN;
export function setup() {
  h.owner("root");
  h.where("setup");
  const [n, sn] = h.signal("n", 1);
  setN = sn;
  const m = createMemo(
    $(function* () {
      h.owner("memo");
      h.where("memo body");
      const v = yield* n;
      untrack(() => h.where("memo untrack"));
      h.value("theme in memo", useContext(Theme));
      return v;
    })
  );
  createEffect(
    $(function* () {
      h.owner("effect");
      h.where("effect compute");
      return yield* m;
    }),
    v => {
      h.where("effect callback");
      h.value("m", v);
    }
  );
}
`
  },
  steps: [
    {
      name: "rerun",
      run: ({ app, flush }) => {
        app.setN(2);
        flush();
      }
    }
  ]
};

export const reactiveScenarios: Scenario[] = [
  memoEffectOrder,
  dynamicSubscriptions,
  ownedChildren,
  ownerRouting
];
