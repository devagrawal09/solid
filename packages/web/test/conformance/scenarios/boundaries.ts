/**
 * Error routing and async scenarios: synchronous throws, typed failures,
 * boundary reset, pending / resolve / reject, superseded flights, disposal
 * before settlement, continuation ownership.
 */
import { NotFound } from "../harness/trace.js";
import { forModes } from "../harness/expect.js";
import type { Scenario } from "../harness/types.js";

/**
 * Intentional: the `$` driver cancels a superseded or disposed run — its
 * pending `wait` closes the generator instead of resuming it
 * (generator.ts, `resume`: [BLOCK_SUPERSEDED]) — whereas a handwritten
 * async function keeps executing after `await` and Solid discards its
 * result. Blocks that `wait` are not lowered, so every generator mode
 * shares this behaviour.
 */
const CANCELLED_CONTINUATION =
  "`$` closes a superseded/disposed run's generator at its pending `wait`; an async function continues after `await` (its result is discarded)";

export const errorRouting: Scenario = {
  name: "error-routing",
  covers: [
    "synchronous throw",
    "typed failure (raise)",
    "untyped failure (attempt)",
    "local recovery (try/catch)",
    "error-boundary routing and reset"
  ],
  entry: { component: "App" },
  sources: {
    reference: `
import { createMemo, Errored } from "solid-js";
import { h, NotFound } from "conformance";
export let setMode, reset;
const parse = text => {
  throw new SyntaxError("cannot parse " + text);
};
export function App() {
  const [mode, sm] = h.signal("mode", "ok");
  setMode = sm;
  const value = createMemo(() => {
    const m = mode();
    h.run("value(" + m + ")");
    if (m === "typed") throw new NotFound("typed");
    if (m === "sync") parse("{");
    if (m === "recover") {
      try {
        throw new NotFound("inner");
      } catch (e) {
        return "recovered " + e.name;
      }
    }
    return m;
  });
  return (
    <Errored
      fallback={(err, r) => {
        reset = r;
        h.caught("boundary", err());
        return <p class="err">{err().name}</p>;
      }}
    >
      <p>{value()}</p>
    </Errored>
  );
}
`,
    generator: `
import { $, createMemo, raise, attempt, Errored } from "solid-js";
import { h, NotFound } from "conformance";
export let setMode, reset;
const parse = text => {
  throw new SyntaxError("cannot parse " + text);
};
export function App() {
  const [mode, sm] = h.signal("mode", "ok");
  setMode = sm;
  const value = createMemo(
    $(function* () {
      const m = yield* mode;
      h.run("value(" + m + ")");
      if (m === "typed") yield* raise(new NotFound("typed"));
      if (m === "sync") yield* attempt(() => parse("{"), SyntaxError);
      if (m === "recover") {
        try {
          yield* raise(new NotFound("inner"));
        } catch (e) {
          return "recovered " + e.name;
        }
      }
      return m;
    })
  );
  return (
    <Errored
      fallback={(err, r) => {
        reset = r;
        h.caught("boundary", err());
        return <p class="err">{err().name}</p>;
      }}
    >
      <p>{value()}</p>
    </Errored>
  );
}
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "recover locally",
      run: ({ app, flush, html }) => {
        app.setMode("recover");
        flush();
        html();
      }
    },
    {
      name: "typed failure routes to boundary",
      run: ({ app, flush, html }) => {
        app.setMode("typed");
        flush();
        html();
      }
    },
    {
      name: "fix source and reset boundary",
      run: ({ app, flush, html }) => {
        app.setMode("ok");
        app.reset();
        flush();
        html();
      }
    },
    {
      name: "synchronous throw routes to boundary",
      run: ({ app, flush, html }) => {
        app.setMode("sync");
        flush();
        html();
      }
    }
  ]
};

const asyncReference = `
import { createMemo, Loading, Errored } from "solid-js";
import { h } from "conformance";
export let setId;
export function App() {
  const [id, si] = h.signal("id", 1);
  setId = si;
  const user = createMemo(async () => {
    const i = id();
    h.owner("user memo");
    h.run("user(" + i + ")");
    h.where("before wait(" + i + ")");
    const v = await h.task("load", i);
    h.where("after wait(" + i + ")");
    return v;
  });
  return (
    <Errored
      fallback={err => {
        h.caught("boundary", err());
        return <p class="err">{err().name}</p>;
      }}
    >
      <Loading fallback={<p class="loading">loading</p>}>
        <p class="user">{user()}</p>
      </Loading>
    </Errored>
  );
}
`;

const asyncGenerator = `
import { $, createMemo, wait, Loading, Errored } from "solid-js";
import { h, NotFound } from "conformance";
export let setId;
export function App() {
  const [id, si] = h.signal("id", 1);
  setId = si;
  const user = createMemo(
    $(function* () {
      const i = yield* id;
      h.owner("user memo");
      h.run("user(" + i + ")");
      h.where("before wait(" + i + ")");
      const v = yield* wait(h.task("load", i), NotFound);
      h.where("after wait(" + i + ")");
      return v;
    })
  );
  return (
    <Errored
      fallback={err => {
        h.caught("boundary", err());
        return <p class="err">{err().name}</p>;
      }}
    >
      <Loading fallback={<p class="loading">loading</p>}>
        <p class="user">{user()}</p>
      </Loading>
    </Errored>
  );
}
`;

export const asyncFlights: Scenario = {
  name: "async-flights",
  covers: [
    "async pending",
    "async resolve",
    "superseded stale flight",
    "async reject → boundary",
    "continuation ownership",
    "loading/error markers"
  ],
  entry: { component: "App" },
  sources: { reference: asyncReference, generator: asyncGenerator },
  steps: [
    { name: "pending", run: ({ html }) => html() },
    {
      name: "resolve load#1",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("load#1", "ada");
        await settle();
        html();
      }
    },
    {
      name: "id 2 then 3 (load#2 superseded)",
      run: async ({ app, flush, settle, html }) => {
        app.setId(2);
        flush();
        app.setId(3);
        flush();
        await settle();
        html();
      }
    },
    {
      name: "resolve load#3",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("load#3", "grace");
        await settle();
        html();
      }
    },
    {
      name: "resolve stale load#2 (must not commit)",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("load#2", "stale");
        await settle();
        html();
      }
    },
    {
      name: "reject load#4",
      run: async ({ app, tasks, flush, settle, html }) => {
        app.setId(4);
        flush();
        tasks.reject("load#4", new NotFound("gone"));
        await settle();
        html();
      }
    }
  ],
  modes: forModes(
    {
      status: "differs",
      reason: CANCELLED_CONTINUATION,
      remove: ["owner after wait(2) = none"]
    },
    { environments: ["client"] }
  )
};

export const asyncDisposal: Scenario = {
  name: "async-disposal",
  covers: ["disposal before settlement", "no commit after disposal"],
  entry: { component: "App" },
  sources: { reference: asyncReference, generator: asyncGenerator },
  steps: [
    {
      name: "dispose while load#1 pending",
      run: ({ dispose }) => dispose()
    },
    {
      name: "settle after disposal",
      run: async ({ tasks, settle }) => {
        tasks.resolve("load#1", "late");
        await settle();
      }
    }
  ],
  modes: forModes(
    {
      status: "differs",
      reason: CANCELLED_CONTINUATION,
      remove: ["owner after wait(1) = none"]
    },
    { environments: ["client"] }
  )
};

export const boundaryScenarios: Scenario[] = [errorRouting, asyncFlights, asyncDisposal];
