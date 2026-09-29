import { eager } from "../eager";
import {
  $component,
  $event,
  $memo,
  $signal,
  createMemo,
  Loading,
  Reveal,
  Show,
  type RevealOrder,
  type TypedProps
} from "solid-js";

function delayedValue<T>(ms: number, value: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), ms));
}

/**
 * Kept plain. As a `$component` (setup: the delayed-value memo; view:
 * `<Loading>` over the card), the streamed SSR page hydrates into DUPLICATED
 * cards — `A, A, B, B loading…, C, …` — the server's resolved cards stay and
 * the client renders its own next to them. The CSR and string builds are fine.
 * See the README.
 */
function AsyncCard(props: { delay: number; title: string }) {
  const value = createMemo(() =>
    delayedValue(props.delay, `${props.title} resolved in ${props.delay}ms`)
  );

  return (
    <Loading fallback={<div class="loader">{props.title} loading...</div>}>
      <div class="reveal-card">
        <strong>{props.title}</strong>
        <div>{value()}</div>
      </div>
    </Loading>
  );
}

const RevealPage = $component(function* () {
  const [order, setOrder] = yield* $signal<RevealOrder>("sequential");
  const [collapsed, setCollapsed] = yield* $signal(true);
  const [seed, setSeed] = yield* $signal(1);

  const pick = (next: RevealOrder) =>
    $event(function* () {
      yield* setOrder(next);
    });
  const collapse = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    yield* setCollapsed(e.currentTarget.checked);
  });
  const restart = $event(function* () {
    yield* setSeed(s => s + 1);
  });

  return function* () {
    return (
      <>
        <h1>Reveal</h1>
        <p>
          Compare reveal ordering with different <code>order</code> modes and watch the nested group
          behave as a single composite slot inside its parent. Restart the run to replay SSR and
          hydration timings.
        </p>
        <p>
          <strong>Run:</strong> {yield* seed}
        </p>
        <div
          style={{
            display: "flex",
            gap: "1rem",
            "align-items": "center",
            "margin-bottom": "1rem",
            "flex-wrap": "wrap"
          }}
        >
          <fieldset style={{ display: "flex", gap: "0.75rem", "align-items": "center" }}>
            <legend>order</legend>
            <label>
              <input
                type="radio"
                name="order"
                value="sequential"
                checked={(yield* order) === "sequential"}
                onInput={pick("sequential")}
              />{" "}
              sequential
            </label>
            <label>
              <input
                type="radio"
                name="order"
                value="together"
                checked={(yield* order) === "together"}
                onInput={pick("together")}
              />{" "}
              together
            </label>
            <label>
              <input
                type="radio"
                name="order"
                value="natural"
                checked={(yield* order) === "natural"}
                onInput={pick("natural")}
              />{" "}
              natural
            </label>
          </fieldset>
          <label title="Only applies when order is sequential">
            <input
              type="checkbox"
              checked={yield* collapsed}
              disabled={(yield* order) !== "sequential"}
              onInput={collapse}
            />{" "}
            collapsed <em>(sequential only)</em>
          </label>
          <button onClick={restart}>Restart run</button>
        </div>

        <Show when={yield* seed} keyed>
          <h2>Primary Group</h2>
          <p>
            Three siblings under a single <code>{`<Reveal order="${yield* order}">`}</code>. Compare
            how they swap in as each resolves.
          </p>
          <Reveal order={yield* order} collapsed={yield* collapsed}>
            <div class="reveal-grid">
              <AsyncCard title="A" delay={500} />
              <AsyncCard title="B" delay={1100} />
              <AsyncCard title="C" delay={1700} />
            </div>
          </Reveal>

          <h2>Nested Group</h2>
          <p>
            The outer group uses <code>order="{yield* order}"</code>. The inner group is always{" "}
            <code>order="natural"</code> — it registers as a single composite slot to the outer
            group and, once the outer releases it, each inner card reveals on its own.
          </p>
          <Reveal order={yield* order} collapsed={yield* collapsed}>
            <div class="reveal-grid">
              <AsyncCard title="Outer-1" delay={700} />
              <Reveal order="natural">
                <div class="reveal-grid">
                  <AsyncCard title="Inner-1" delay={900} />
                  <AsyncCard title="Inner-2" delay={1300} />
                </div>
              </Reveal>
              <AsyncCard title="Outer-2" delay={1500} />
            </div>
          </Reveal>
        </Show>
      </>
    );
  };
});

// Loaded with lazy(): see ../eager.ts.
export default eager(RevealPage);
