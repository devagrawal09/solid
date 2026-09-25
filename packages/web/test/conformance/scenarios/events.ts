/**
 * Event-host scenarios: reads are one-shot (no subscription), writes happen
 * exactly once per dispatch, async handlers settle under explicit control,
 * and failures reach the error boundary above the handler's creation owner.
 */
import { Forbidden } from "../harness/trace.js";
import type { Scenario } from "../harness/types.js";

export const eventReadsWrites: Scenario = {
  name: "event-reads-writes",
  covers: ["event reads are one-shot", "event writes occur once", "event handler owner"],
  entry: { component: "App" },
  ssr: {},
  sources: {
    reference: `
import { h } from "conformance";
export let setCount;
export function App() {
  const [count, sc] = h.signal("count", 0);
  setCount = sc;
  const inc = () => {
    h.run("inc");
    h.where("inc handler");
    const c = count();
    sc(c + 1);
  };
  return (
    <div>
      <button class="inc" onClick={inc}>
        +
      </button>
      <p class="count">{count()}</p>
    </div>
  );
}
`,
    generator: `
import { $, write } from "solid-js";
import { h } from "conformance";
export let setCount;
export function App() {
  const [count, sc] = h.signal("count", 0);
  setCount = sc;
  const inc = $(function* () {
    h.run("inc");
    h.where("inc handler");
    const c = yield* count;
    yield* write(sc, c + 1);
  });
  return (
    <div>
      <button class="inc" onClick={inc}>
        +
      </button>
      <p class="count">{count()}</p>
    </div>
  );
}
`
  },
  steps: [
    { name: "initial", run: ({ html }) => html() },
    {
      name: "click",
      run: ({ click, flush, html }) => {
        click(".inc");
        flush();
        html();
      }
    },
    {
      name: "external write (handler must not rerun)",
      run: ({ app, flush, html }) => {
        app.setCount(10);
        flush();
        html();
      }
    },
    {
      name: "click twice",
      run: ({ click, flush, html }) => {
        click(".inc");
        click(".inc");
        flush();
        html();
      }
    }
  ]
};

export const asyncEvent: Scenario = {
  name: "async-event",
  covers: [
    "async event pending/resolve",
    "async event reject → boundary of the creating owner",
    "writes before and after an event wait"
  ],
  entry: { component: "App" },
  sources: {
    // Handwritten Solid has no event-failure channel: the reference routes
    // the rejection by hand, through an untraced signal a computation under
    // the boundary rethrows. Only the observable result is compared.
    reference: `
import { createSignal, createMemo, Errored } from "solid-js";
import { h } from "conformance";
function Saver() {
  const [status, ss] = h.signal("status", "idle");
  const [failure, setFailure] = createSignal(undefined);
  const guard = createMemo(() => {
    const f = failure();
    if (f) throw f;
  });
  const save = async () => {
    h.run("save");
    ss("saving");
    try {
      const answer = await h.task("save");
      ss(answer);
    } catch (e) {
      setFailure(() => e);
    }
  };
  return (
    <button class="save" onClick={save}>
      {(guard(), status())}
    </button>
  );
}
export function App() {
  return (
    <Errored
      fallback={err => {
        h.caught("boundary", err());
        return <p class="err">{err().name}</p>;
      }}
    >
      <Saver />
    </Errored>
  );
}
`,
    generator: `
import { $, wait, write, Errored } from "solid-js";
import { h, Forbidden } from "conformance";
function Saver() {
  const [status, ss] = h.signal("status", "idle");
  const save = $(function* () {
    h.run("save");
    yield* write(ss, "saving");
    const answer = yield* wait(h.task("save"), Forbidden);
    yield* write(ss, answer);
  });
  return (
    <button class="save" onClick={save}>
      {status()}
    </button>
  );
}
export function App() {
  return (
    <Errored
      fallback={err => {
        h.caught("boundary", err());
        return <p class="err">{err().name}</p>;
      }}
    >
      <Saver />
    </Errored>
  );
}
`
  },
  steps: [
    {
      name: "click (pending)",
      run: ({ click, flush, html }) => {
        click(".save");
        flush();
        html();
      }
    },
    {
      name: "resolve save#1",
      run: async ({ tasks, settle, html }) => {
        tasks.resolve("save#1", "saved");
        await settle();
        html();
      }
    },
    {
      name: "click, reject save#2",
      run: async ({ click, flush, tasks, settle, html }) => {
        click(".save");
        flush();
        tasks.reject("save#2", new Forbidden("denied"));
        await settle();
        html();
      }
    }
  ]
};

export const eventScenarios: Scenario[] = [eventReadsWrites, asyncEvent];
