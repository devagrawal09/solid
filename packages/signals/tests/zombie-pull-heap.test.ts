/**
 * A zombie (a child of an owner that is re-running, disposed when the pending
 * disposal commits) can be pulled by a reader outside its owner in the same
 * flush. `updateIfNecessary` then clears its REACTIVE_ZOMBIE flag. If the
 * node still held a heap entry (a height-adjust entry: the pull does not
 * consume one), it was physically linked in `zombieQueue` while its flags
 * named `dirtyQueue`, and the commit's `deleteFromHeap(el, queueFor(el))`
 * unlinked it from the wrong heap: the dirty bucket was cleared or
 * re-tailed, and the zombie bucket kept a dangling disposed node that later
 * inserts chained onto. Found by the tier-1 kernel differential
 * (tests/kernel/differential.test.ts, seed 5166 in one long-lived runtime:
 * `TypeError: Cannot set properties of undefined (setting '_prevHeap')`).
 */
import { expect, it } from "vitest";
import { createMemo, createRenderEffect, createRoot, createSignal, flush } from "../src/index.js";
import {
  REACTIVE_IN_HEAP,
  REACTIVE_IN_HEAP_HEIGHT,
  REACTIVE_ZOMBIE
} from "../src/core/constants.js";
import { dirtyQueue, zombieQueue } from "../src/core/scheduler.js";
import type { Computed } from "../src/core/types.js";

function entries(heap: typeof dirtyQueue): Computed<unknown>[] {
  const out: Computed<unknown>[] = [];
  for (let h = 0; h < heap._heap.length; h++)
    for (let el = heap._heap[h]; el !== undefined; el = el._nextHeap) out.push(el);
  return out;
}

/** Every linked node carries an in-heap flag, and its zombie flag names the heap it is in. */
function expectHeapsConsistent() {
  for (const el of entries(dirtyQueue)) {
    expect(el._flags & (REACTIVE_IN_HEAP | REACTIVE_IN_HEAP_HEIGHT)).not.toBe(0);
    expect(el._flags & REACTIVE_ZOMBIE).toBe(0);
  }
  for (const el of entries(zombieQueue)) {
    expect(el._flags & (REACTIVE_IN_HEAP | REACTIVE_IN_HEAP_HEIGHT)).not.toBe(0);
    expect(el._flags & REACTIVE_ZOMBIE).not.toBe(0);
  }
}

it("a pulled zombie with a height-adjust entry is unlinked from the heap it is in", () => {
  const [a, setA] = createSignal(0);
  const [b, setB] = createSignal(0);
  const seen: number[] = [];
  let dispose!: () => void;
  createRoot(d => {
    dispose = d;
    const y = createMemo(() => b());
    // Reads `y` only while `b` is set: turning `b` on raises x's height
    // while its value stays 0, so x's subscribers get height-adjust entries
    // (and no value notification).
    const x = createMemo(() => (b() ? y() * 0 : 0));
    let first: (() => number) | undefined;
    // The owner: every run of it dooms the previous `m`.
    createRenderEffect(
      () => {
        a();
        const m = createMemo(() => x());
        first ??= m;
        return m();
      },
      () => {}
    );
    // A reader outside the owner, pulling the first (now doomed) `m` in the
    // same flush.
    createRenderEffect(
      () => {
        a();
        return first!();
      },
      v => void seen.push(v)
    );
  });
  flush();

  // `b` first, so x (height 0) re-runs before the owner in the same bucket:
  // m gets its height-adjust entry in the dirty heap, then the owner's re-run
  // moves it to the zombie heap, then the reader pulls it.
  for (let i = 1; i <= 4; i++) {
    setB(i % 2);
    setA(i);
    flush();
    expectHeapsConsistent();
  }
  expect(seen).toEqual([0, 0, 0, 0, 0]);

  dispose();
  flush();
  expect(entries(zombieQueue)).toEqual([]);
  expect(entries(dirtyQueue)).toEqual([]);
});
