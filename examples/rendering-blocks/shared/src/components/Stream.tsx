import { eager } from "../eager";
import { $component, $memo, createProjection, For, Loading, readStore, Repeat } from "solid-js";

interface StreamItem {
  id: number;
  text: string;
}

async function* getData(): AsyncIterable<StreamItem> {
  const items: StreamItem[] = [
    { id: 1, text: "First item" },
    { id: 2, text: "Second item" },
    { id: 3, text: "Third item" },
    { id: 4, text: "Fourth item" },
    { id: 5, text: "Fifth item" }
  ];

  for (const item of items) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    yield item;
  }
}

/** The original memo's body: an async generator of the growing list. */
async function* accumulate(): AsyncIterable<StreamItem[]> {
  let accum: StreamItem[] = [];

  for await (const val of getData()) {
    yield (accum = [...accum, val]);
  }
}

const Stream = $component(function* () {
  // The original is `createMemo(async function* () { … })`. A block is never
  // an `async function*` and `attempt` awaits one promise, so the memo block
  // returns the async iterable itself (the memo consumes it as the original
  // does); `$memo` types its value as the body's return, hence the cast.
  const memoItems = yield* $memo(function* () {
    return accumulate() as unknown as StreamItem[];
  });

  // A projection has no block constructor (`$store` is the plain form).
  const projItems = createProjection<StreamItem[]>(async function* (state) {
    for await (const val of getData()) {
      state.push(val);
      yield;
    }
  }, []);

  return function* () {
    return (
      <>
        <h1>Async Iterable Streaming</h1>
        <p>Both lists stream items from an async generator, one per second.</p>
        <div style={{ display: "flex", gap: "2em" }}>
          <div>
            <h2>createMemo</h2>
            <p>Accumulates an immutable array each yield.</p>
            <Loading fallback={<span class="loader">Loading memo...</span>}>
              <ul id="memo-list">
                <For each={yield* memoItems}>
                  {item => (
                    <li>
                      {item.id}: {item.text}
                    </li>
                  )}
                </For>
              </ul>
            </Loading>
          </div>
          <div>
            <h2>createProjection</h2>
            <p>Pushes into a reactive store each yield.</p>
            <Loading fallback={<span class="loader">Loading projection...</span>}>
              <ul id="proj-list">
                <Repeat count={yield* readStore(projItems, p => p.length)}>
                  {i => (
                    <li>
                      {projItems[i].id}: {projItems[i].text}
                    </li>
                  )}
                </Repeat>
              </ul>
            </Loading>
          </div>
        </div>
      </>
    );
  };
});

// Loaded with lazy(): see ../eager.ts.
export default eager(Stream);
