/**
 * Scenario 3, file C — the screen. Identical in both modes: the component
 * consumes a `StoryView` and does not know whether the data layer behind it
 * is a chain or a composed page.
 *
 * Nothing loads until a story is picked. That is what makes the demo honest:
 * the chain the runtime reports is the one the *click* started, not one left
 * over from mounting the page. Memos are lazy, so while `selected()` is null
 * the effect below never reads them and no request leaves.
 */
import { For, Loading, Show, createEffect, createSignal, isPending } from "solid-js";
import type { JSX } from "@solidjs/web";
import { nodeName, scenarioWaterfalls, waterfallCursor } from "../../diagnostics/channel";
import { createPaintLog } from "../../diagnostics/paint-log";
import { EvidencePanel } from "../../diagnostics/Evidence";
import { latency, requestCount, resetRequestCount } from "./api";
import { createStoryChain, type StoryView } from "./story-chain";
import { createStoryPage } from "./story-page";

export function StoryCard(props: { broken: boolean }): JSX.Element {
  const [selected, setSelected] = createSignal<number | null>(null, {
    name: nodeName("waterfall", "storyId")
  });
  const view: StoryView = props.broken
    ? createStoryChain(() => selected() ?? 1)
    : createStoryPage(() => selected() ?? 1);
  const paint = createPaintLog(4);
  // Chains recorded before this card existed belong to the other mode's graph.
  const since = waterfallCursor();
  let startedAt = performance.now();

  resetRequestCount();

  const load = (next: number) => {
    resetRequestCount();
    startedAt = performance.now();
    setSelected(next);
  };

  // Runs when every piece of the page is ready — the honest "the screen is
  // complete" moment, which is what the user is actually waiting for.
  createEffect(
    () =>
      selected() === null ? null : `${view.avatar()} ${view.story().title} — ${view.author().name}`,
    complete => {
      if (complete === null) return;
      paint.record(
        `${Math.round(performance.now() - startedAt)}ms · ${requestCount()} requests · ${complete}`
      );
    },
    { name: nodeName("waterfall", "page-complete") }
  );

  // Acknowledges the wait: the id write is held behind the new page's async,
  // and this reader is what tells the person a change is on the way. It is a
  // property of the screen, not of the data layer, so both modes have it.
  const loading = () => selected() !== null && isPending(() => view.story().id);

  const chains = () => {
    paint.frames();
    return scenarioWaterfalls("waterfall", since);
  };

  return (
    <div class="scenario-body">
      <div class="row">
        <For each={[1, 2, 3]}>
          {storyId => (
            <button
              id={`waterfall-load-${storyId}`}
              type="button"
              class={selected() === storyId ? "primary" : "ghost"}
              onClick={() => load(storyId)}
            >
              Story {storyId}
            </button>
          )}
        </For>
        <span class="quiet">{latency()}ms per request</span>
        <Show when={loading()}>
          <span id="waterfall-pending" class="badge">
            updating…
          </span>
        </Show>
      </div>

      <Show
        when={selected() !== null}
        fallback={<p class="quiet">Pick a story — that click is the whole scenario.</p>}
      >
        <Loading fallback={<p class="loading">loading story…</p>}>
          <article class="story">
            <span class="avatar">{view.avatar()}</span>
            <div>
              <h4>{view.story().title}</h4>
              <p class="quiet">
                {view.author().name} · {view.story().blurb}
              </p>
            </div>
          </article>
        </Loading>
      </Show>

      <EvidencePanel feed="waterfall">
        <div class="measure">
          <h4>Time to a complete page</h4>
          <ol class="frames">
            <For each={paint.frames()}>{frame => <li>{frame}</li>}</For>
          </ol>
          <Show
            when={chains().length}
            fallback={<p class="quiet">No sequential chains recorded.</p>}
          >
            <For each={chains().slice(-2)}>
              {chain => (
                <p class="quiet">
                  chain: <code>{chain.chain.map(link => link.name).join(" → ")}</code> ·{" "}
                  {Math.round(chain.sequentialMs)}ms serialized
                </p>
              )}
            </For>
          </Show>
          <p class="quiet">
            The verdict is reported once per node; later loads keep adding timing and chain evidence
            here.
          </p>
        </div>
      </EvidencePanel>
    </div>
  );
}
