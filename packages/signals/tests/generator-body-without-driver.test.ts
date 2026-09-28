import { createEffect, createMemo, createRoot, onSettled } from "../src/index.js";

// This file never builds a block, so the driver's hook is never installed: a
// generator body reaching a primitive must fail loudly instead of running as a
// plain compute (which would make an iterator object the memo's value).
describe("generator body without the block driver", () => {
  it("createMemo, createEffect and onSettled throw [GENERATOR_BODY]", () => {
    createRoot(() => {
      expect(() => createMemo(function* () {} as any)).toThrow("[GENERATOR_BODY]");
      expect(() => (createEffect as any)(function* () {})).toThrow("[GENERATOR_BODY]");
      expect(() => onSettled(function* () {} as any)).toThrow("[GENERATOR_BODY]");
    });
  });
  it("plain bodies are untouched", () => {
    createRoot(() => {
      expect(createMemo(() => 1)()).toBe(1);
    });
  });
});
