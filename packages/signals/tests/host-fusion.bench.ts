// Benchmark: host fusion erasure overhead.
//
// Compares three forms of the same reactive computation:
//   1. Handwritten Solid: createMemo(function() { return count(); })
//   2. $ block (unfused): createMemo($(function() { return perform(count); }))
//   3. Host-fused output: identical to handwritten (verifies zero overhead)
//
// The unfused form measures the runtime overhead of: block allocation ($()),
// readGuarded() wrapper around every perform() call, and the block guard
// set/restore on each invocation. The fused form should be identical to
// handwritten since it compiles away all of that.

import { bench, describe } from "vitest";
import {
  $,
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  flush,
  perform
} from "../src/index.js";

// --- creation benchmarks -----------------------------------------------

describe("createMemo creation (1000 memos)", () => {
  bench("handwritten: createMemo(function)", () => {
    createRoot(dispose => {
      const [count] = createSignal(1);
      for (let i = 0; i < 1000; i++) {
        createMemo(function () {
          return count() + i;
        });
      }
      flush();
      dispose();
    });
  });

  bench("$ block (unfused): createMemo($(function))", () => {
    createRoot(dispose => {
      const [count] = createSignal(1);
      for (let i = 0; i < 1000; i++) {
        createMemo(
          $(function () {
            return perform(count) + i;
          })
        );
      }
      flush();
      dispose();
    });
  });

  bench("fused output: createMemo(function) [same as handwritten]", () => {
    // This is what the compiler emits with hostFusion: the $() is erased
    // and perform(count) becomes count(). Identical code to handwritten.
    createRoot(dispose => {
      const [count] = createSignal(1);
      for (let i = 0; i < 1000; i++) {
        createMemo(function () {
          return count() + i;
        });
      }
      flush();
      dispose();
    });
  });
});

// --- update benchmarks -------------------------------------------------

describe("signal update propagation (1000 memos, 100 updates)", () => {
  bench("handwritten: createMemo(function)", () => {
    createRoot(dispose => {
      const [count, setCount] = createSignal(0);
      for (let i = 0; i < 1000; i++) {
        createMemo(function () {
          return count() + i;
        });
      }
      flush();
      for (let u = 1; u <= 100; u++) {
        setCount(u);
        flush();
      }
      dispose();
    });
  });

  bench("$ block (unfused): createMemo($(function))", () => {
    createRoot(dispose => {
      const [count, setCount] = createSignal(0);
      for (let i = 0; i < 1000; i++) {
        createMemo(
          $(function () {
            return perform(count) + i;
          })
        );
      }
      flush();
      for (let u = 1; u <= 100; u++) {
        setCount(u);
        flush();
      }
      dispose();
    });
  });

  bench("fused output: createMemo(function) [same as handwritten]", () => {
    createRoot(dispose => {
      const [count, setCount] = createSignal(0);
      for (let i = 0; i < 1000; i++) {
        createMemo(function () {
          return count() + i;
        });
      }
      flush();
      for (let u = 1; u <= 100; u++) {
        setCount(u);
        flush();
      }
      dispose();
    });
  });
});

// --- mixed creation + update with createEffect -------------------------

describe("createEffect creation+update (500 effects, 50 updates)", () => {
  bench("handwritten: createEffect(function)", () => {
    createRoot(dispose => {
      const [count, setCount] = createSignal(0);
      const results: number[] = [];
      for (let i = 0; i < 500; i++) {
        createEffect(
          function () {
            return count() + i;
          },
          (v: number) => {
            results.push(v);
          }
        );
      }
      flush();
      for (let u = 1; u <= 50; u++) {
        setCount(u);
        flush();
      }
      dispose();
    });
  });

  bench("$ block (unfused): createEffect($(function))", () => {
    createRoot(dispose => {
      const [count, setCount] = createSignal(0);
      const results: number[] = [];
      for (let i = 0; i < 500; i++) {
        createEffect(
          $(function () {
            return perform(count) + i;
          }),
          (v: number) => {
            results.push(v);
          }
        );
      }
      flush();
      for (let u = 1; u <= 50; u++) {
        setCount(u);
        flush();
      }
      dispose();
    });
  });

  bench("fused output: createEffect(function) [same as handwritten]", () => {
    createRoot(dispose => {
      const [count, setCount] = createSignal(0);
      const results: number[] = [];
      for (let i = 0; i < 500; i++) {
        createEffect(
          function () {
            return count() + i;
          },
          (v: number) => {
            results.push(v);
          }
        );
      }
      flush();
      for (let u = 1; u <= 50; u++) {
        setCount(u);
        flush();
      }
      dispose();
    });
  });
});
