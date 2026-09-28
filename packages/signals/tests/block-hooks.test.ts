// Renderer entry points (block-hooks.ts) are installed by the first block.
// A call that reads the entry point before its own argument builds that
// first block — `renderBlock($(…))` — must still reach the implementation.
// Its own file: the module registry is fresh, so no block exists yet.
import { $, createRoot, dispatchBlock, flush, lazyView, renderBlock } from "../src/index.js";

afterEach(() => flush());

describe("block renderer entry points (install-on-use)", () => {
  it("renderBlock read before the first block is built still renders it", () => {
    const value = createRoot(() =>
      renderBlock(
        $(function* () {
          return "first";
        })
      )
    );
    expect(value).toBe("first");
  });

  it("dispatchBlock and lazyView reach the installed runtime", () => {
    let seen: unknown;
    dispatchBlock(
      $(function* (event: unknown) {
        seen = event;
      }),
      "click"
    );
    expect(seen).toBe("click");
    const view = createRoot(() => lazyView(() => "view"));
    expect(createRoot(() => view())).toBe("view");
  });
});
