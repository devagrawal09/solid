import { createProjection } from "../../packages/solid/dist/server.js";
import { renderServerComponent } from "../../packages/solid-web/frames/dist/server.js";

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const ServerComponent = props => {
  const state = createProjection(
    async function* (draft) {
      await wait(10);
      draft.items.push("First");
      yield;

      await wait(10);
      draft.items.push("Second");
      yield;

      draft.done = true;
      yield;
    },
    { items: [], done: false }
  );

  return props.content({ state });
};

const chunks = await renderServerComponent(ServerComponent, {
  frame: { id: "projection-slot-repro", version: 1 }
});

console.dir(chunks, { depth: null });

const frameError = chunks.find(chunk => chunk.type === "error");
if (frameError) {
  console.log(`\nCurrent result: frame error: ${frameError.error}`);
} else {
  console.log("\nNo frame error. Check whether later projection patches reached the slot state.");
}
