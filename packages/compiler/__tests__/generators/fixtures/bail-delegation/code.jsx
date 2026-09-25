import { $, createMemo } from "solid-js";

function* pair(a, b) {
  return [yield* a, yield* b];
}

// `yield*` over an unknown call could be a block factory or a waiting
// generator: left to the runtime driver (the whole call stays as authored).
export const both = createMemo(
  $(function* () {
    const [x, y] = yield* pair(left, right);
    return x + y;
  })
);

// A sibling call in the lowerable subset is still lowered.
export const lowered = createMemo(
  $(function* () {
    return yield* left;
  })
);
