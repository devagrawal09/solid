// examples/migrating-element's App, written with generator blocks v2
// (documentation/plans/generator-blocks-v2.md). The original keeps `App` and
// `render` in `main.tsx`; here `App` lives in this module so the tests can
// mount it, and `main.tsx` only renders it.
import {
  $component,
  $event,
  $signal,
  children,
  Show,
  type SourceAccessor,
  type TypedProps
} from "solid-js";
import { Canvas } from "./Canvas";

type Slot = "hero" | "pip" | "dock";

const SLOT_LABELS: Record<Slot, string> = {
  hero: "Hero",
  pip: "PIP (corner)",
  dock: "Dock"
};

function slotClass(s: Slot): string {
  return `slot-${s}`;
}

/**
 * One slot button. The original writes it inline in
 * `{slots.map(s => <button class={{ active: slot() === s }} onClick={() => setSlot(s)}>…)}`;
 * a `.map` callback is a plain arrow, where a view cannot `yield*` the
 * current slot, so the row becomes a component (a render-callback block
 * would keep it inline).
 */
const SlotButton = $component(function* (
  props: TypedProps<{ slot: Slot; current: SourceAccessor<Slot>; choose: (s: Slot) => void }>
) {
  const choose = $event(function* () {
    const pick = yield* props.choose;
    pick(yield* props.slot);
  });
  return function* () {
    const s = yield* props.slot;
    return (
      <button class={{ active: (yield* props.current) === s }} onClick={choose}>
        {SLOT_LABELS[s]}
      </button>
    );
  };
});

export const App = $component(function* () {
  const [slot, setSlot] = yield* $signal<Slot>("hero");
  const choose = (s: Slot) => {
    setSlot(s);
  };

  // Left panel — the `<Canvas />` JSX is evaluated once and stored in a
  // variable. Every `<Show>` slot references the same value, so the runtime
  // migrates a single DOM node between slots.
  //
  // Unlike a plain component, a `$component` call returns its *view*, which
  // renders anew at every insertion point: `const hoistedCanvas = <Canvas />`
  // would render three different canvases (and only the first would get the
  // settled effect's listener and reset). `children()` resolves the view to
  // its DOM once, and every slot reads that node. The slots call it
  // (`{hoistedCanvas()}`) rather than `yield*` it: `ChildrenReturn` is typed
  // as a plain `Accessor`, which is not iterable, so `yield* hoistedCanvas`
  // does not typecheck (at runtime it works).
  const hoistedCanvas = children(() => <Canvas />);

  return function* () {
    return (
      <main class="app">
        <header>
          <h1>Migrating element</h1>
          <p class="lede">
            Same <code>&lt;Canvas /&gt;</code> component on both panels — hoisted to a variable on
            the left, written inline inside each slot on the right. Pick a slot and watch what
            happens to the painted logo and the splats.
          </p>

          <div class="controls">
            <span class="label">Active slot:</span>
            {(["hero", "pip", "dock"] as Slot[]).map(s => (
              <SlotButton slot={s} current={slot} choose={choose} />
            ))}
            <span class="hint">click either canvas to add a splat</span>
          </div>
        </header>

        <section class="split">
          <article class="panel panel-good">
            <h2>✓ Hoisted — one JSX expression, three slots</h2>
            <pre class="code">{`const hoistedCanvas = <Canvas />;

<Show when={slot() === "hero"}>{hoistedCanvas}</Show>
<Show when={slot() === "pip"}>{hoistedCanvas}</Show>
<Show when={slot() === "dock"}>{hoistedCanvas}</Show>`}</pre>
            <div class="stage">
              <Show when={(yield* slot) === "hero"}>
                <div class={slotClass("hero")}>{hoistedCanvas()}</div>
              </Show>
              <Show when={(yield* slot) === "pip"}>
                <div class={slotClass("pip")}>{hoistedCanvas()}</div>
              </Show>
              <Show when={(yield* slot) === "dock"}>
                <div class={slotClass("dock")}>{hoistedCanvas()}</div>
              </Show>
            </div>
          </article>

          <article class="panel panel-bad">
            <h2>✗ Inline — fresh JSX per slot</h2>
            <pre class="code">{`<Show when={slot() === "hero"}><Canvas /></Show>
<Show when={slot() === "pip"}><Canvas /></Show>
<Show when={slot() === "dock"}><Canvas /></Show>`}</pre>
            <div class="stage">
              <Show when={(yield* slot) === "hero"}>
                <div class={slotClass("hero")}>
                  <Canvas />
                </div>
              </Show>
              <Show when={(yield* slot) === "pip"}>
                <div class={slotClass("pip")}>
                  <Canvas />
                </div>
              </Show>
              <Show when={(yield* slot) === "dock"}>
                <div class={slotClass("dock")}>
                  <Canvas />
                </div>
              </Show>
            </div>
          </article>
        </section>

        <footer class="note">
          Both panels render the same <code>&lt;Canvas /&gt;</code> component. The only difference
          is whether the JSX expression is stored in a variable and referenced (left) or written
          inline (right). On the left, every slot toggle migrates the same DOM node — the logo keeps
          drawing and splats survive. On the right, each slot evaluates a separate JSX expression,
          so every toggle produces a new element from scratch.
        </footer>
      </main>
    );
  };
});
