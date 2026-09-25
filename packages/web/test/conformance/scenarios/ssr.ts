/**
 * Scenarios centred on server rendering and hydration: async data resolved
 * on the server (no duplicate client work), error-boundary markers.
 */
import type { Scenario } from "../harness/types.js";

export const asyncHydration: Scenario = {
  name: "async-hydration",
  covers: [
    "SSR async resolve + Loading markers",
    "hydration reuses serialized async results (no duplicate authoritative work)",
    "post-hydration async update"
  ],
  entry: { component: "App" },
  // Flights are named by input (`user1#1`), so the same step script is valid
  // whether or not hydration re-runs the fetch — and the hydrate golden pins
  // that it does not.
  ssr: { resolve: { "user1#1": "ada" } },
  sources: {
    reference: `
import { createMemo, Loading } from "solid-js";
import { h } from "conformance";
export let setId;
export function App() {
  const [id, si] = h.signal("id", 1);
  setId = si;
  const user = createMemo(async () => {
    const i = id();
    h.run("user(" + i + ")");
    return await h.task("user" + i);
  });
  return (
    <section>
      <Loading fallback={<p class="loading">loading</p>}>
        <p class="user">{user()}</p>
      </Loading>
    </section>
  );
}
`,
    generator: `
import { $, createMemo, wait, Loading } from "solid-js";
import { h } from "conformance";
export let setId;
export function App() {
  const [id, si] = h.signal("id", 1);
  setId = si;
  const user = createMemo(
    $(function* () {
      const i = yield* id;
      h.run("user(" + i + ")");
      return yield* wait(h.task("user" + i));
    })
  );
  return (
    <section>
      <Loading fallback={<p class="loading">loading</p>}>
        <p class="user">{user()}</p>
      </Loading>
    </section>
  );
}
`
  },
  steps: [
    {
      name: "resolve initial flight (fresh render only)",
      environments: ["client"],
      run: async ({ tasks, settle }) => {
        tasks.resolve("user1#1", "ada");
        await settle();
      }
    },
    { name: "initial", run: ({ html }) => html() },
    {
      name: "id 2",
      run: async ({ app, flush, tasks, settle, html }) => {
        app.setId(2);
        flush();
        tasks.resolve("user2#1", "grace");
        await settle();
        html();
      }
    }
  ]
};

export const errorMarkers: Scenario = {
  name: "error-markers",
  covers: ["SSR error-boundary fallback", "hydrating an errored boundary", "reset after hydration"],
  entry: { component: "App" },
  ssr: {},
  sources: {
    reference: `
import { createMemo, Errored } from "solid-js";
import { h, NotFound } from "conformance";
export let setOk, reset;
export function App() {
  const [ok, so] = h.signal("ok", false);
  setOk = so;
  const value = createMemo(() => {
    h.run("value");
    if (!ok()) throw new NotFound("missing");
    return "fine";
  });
  return (
    <div>
      <Errored
        fallback={(err, r) => {
          reset = r;
          h.caught("boundary", err());
          return <p class="err">{err().name}</p>;
        }}
      >
        <p class="ok">{value()}</p>
      </Errored>
    </div>
  );
}
`,
    generator: `
import { $, createMemo, raise, Errored } from "solid-js";
import { h, NotFound } from "conformance";
export let setOk, reset;
export function App() {
  const [ok, so] = h.signal("ok", false);
  setOk = so;
  const value = createMemo(
    $(function* () {
      h.run("value");
      if (!(yield* ok)) yield* raise(new NotFound("missing"));
      return "fine";
    })
  );
  return (
    <div>
      <Errored
        fallback={(err, r) => {
          reset = r;
          h.caught("boundary", err());
          return <p class="err">{err().name}</p>;
        }}
      >
        <p class="ok">{value()}</p>
      </Errored>
    </div>
  );
}
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "fix and reset",
      run: ({ app, flush, html }) => {
        app.setOk(true);
        app.reset();
        flush();
        html();
      }
    }
  ]
};

export const ssrScenarios: Scenario[] = [asyncHydration, errorMarkers];
