/**
 * Scenario 3, file C — the screen. Identical in both modes: the component
 * consumes a `StoryView` and does not know whether the data layer behind it
 * is a chain or a composed page.
 *
 * Nothing loads until a story is picked. That is what makes the demo honest:
 * the chain the runtime reports is the one the *click* started, not one left
 * over from mounting the page. Memos are lazy, so while `selected()` is null
 * the effect below never reads them and no request leaves.
 *
 * v2 notes: built per mode (the data layer is chosen in the setup); the named
 * `page-complete` effect stays a plain `createEffect`; the story markup under
 * `<Loading>` is its own component (`Story`), because the `<Loading>` tag
 * does not take a pending child written inline.
 */
import {
  $component,
  $event,
  $signal,
  For,
  Loading,
  Show,
  createEffect,
  isPending,
  type TypedProps
} from "solid-js";
import { nodeName, scenarioWaterfalls, waterfallCursor } from "../../diagnostics/channel";
import { createPaintLog } from "../../diagnostics/paint-log";
import { EvidencePanel } from "../../diagnostics/Evidence";
import { perValue } from "../../per-value";
import { latency, requestCount, resetRequestCount } from "./api";
import { createStoryChain, type StoryView } from "./story-chain";
import { createStoryPage } from "./story-page";

const Story = $component(function* (props: TypedProps<{ view: StoryView }>) {
  return function* () {
    const view = yield* props.view;
    return (
      <article class="story">
        <span class="avatar">{yield* view.avatar}</span>
        <div>
          <h4>{(yield* view.story).title}</h4>
          <p class="quiet">
            {(yield* view.author).name} · {(yield* view.story).blurb}
          </p>
        </div>
      </article>
    );
  };
});

const cardFor = perValue((broken: boolean) =>
  $component(function* () {
    const [selected, setSelected] = yield* $signal<number | null>(null, {
      name: nodeName("waterfall", "storyId")
    });
    const view: StoryView = broken
      ? createStoryChain(() => selected() ?? 1)
      : createStoryPage(() => selected() ?? 1);
    const paint = createPaintLog(4);
    // Chains recorded before this card existed belong to the other mode's graph.
    const since = waterfallCursor();
    let startedAt = performance.now();

    resetRequestCount();

    const load = (next: number) =>
      $event(function* () {
        resetRequestCount();
        startedAt = performance.now();
        yield* setSelected(next);
      });

    // Runs when every piece of the page is ready — the honest "the screen is
    // complete" moment, which is what the user is actually waiting for.
    createEffect(
      () =>
        selected() === null
          ? null
          : `${view.avatar()} ${view.story().title} — ${view.author().name}`,
      complete => {
        if (complete === null) return;
        paint.record(
          `${Math.round(performance.now() - startedAt)}ms · ${requestCount()} requests · ${complete}`
        );
      },
      { name: nodeName("waterfall", "page-complete") }
    );

    return function* () {
      return (
        <div class="scenario-body">
          <div class="row">
            <For each={[1, 2, 3]}>
              {storyId => (
                <button
                  id={`waterfall-load-${storyId}`}
                  type="button"
                  // A plain render callback: `selected()` is a direct call
                  // here (a render-callback block would `yield*` it).
                  class={selected() === storyId ? "primary" : "ghost"}
                  onClick={load(storyId)}
                >
                  Story {storyId}
                </button>
              )}
            </For>
            <span class="quiet">{latency()}ms per request</span>
            {/* Acknowledges the wait: the id write is held behind the new
                page's async, and this reader is what tells the person a change
                is on the way. `isPending` has no block form. */}
            <Show when={(yield* selected) !== null && isPending(() => view.story().id)}>
              <span id="waterfall-pending" class="badge">
                updating…
              </span>
            </Show>
          </div>

          <Show
            when={(yield* selected) !== null}
            fallback={<p class="quiet">Pick a story — that click is the whole scenario.</p>}
          >
            <Loading fallback={<p class="loading">loading story…</p>}>
              <Story view={view} />
            </Loading>
          </Show>

          <EvidencePanel feed="waterfall">
            <div class="measure">
              <h4>Time to a complete page</h4>
              <ol class="frames">
                <For each={yield* paint.frames}>{frame => <li>{frame}</li>}</For>
              </ol>
              {/* `chains()`: the paint-log read refreshes it when a load lands. */}
              <Show
                when={(yield* paint.frames, scenarioWaterfalls("waterfall", since).length)}
                fallback={<p class="quiet">No sequential chains recorded.</p>}
              >
                <For each={(yield* paint.frames, scenarioWaterfalls("waterfall", since).slice(-2))}>
                  {chain => (
                    <p class="quiet">
                      chain: <code>{chain.chain.map(link => link.name).join(" → ")}</code> ·{" "}
                      {Math.round(chain.sequentialMs)}ms serialized
                    </p>
                  )}
                </For>
              </Show>
              <p class="quiet">
                The verdict is reported once per node; later loads keep adding timing and chain
                evidence here.
              </p>
            </div>
          </EvidencePanel>
        </div>
      );
    };
  })
);

export const StoryCard = $component(function* (props: TypedProps<{ broken: boolean }>) {
  return function* () {
    const Card = cardFor(yield* props.broken);
    return <Card />;
  };
});
