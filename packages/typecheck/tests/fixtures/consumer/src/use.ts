// Separate compilation: this project only sees the lib's emitted `.d.ts`,
// which needs no projection — the block's reads are ordinary types there.
import { $, createMemo } from "solid-js";
import type { BlockReads, BlockValue, StoreRead } from "solid-js";
import { theme, settings } from "the-lib";

type Expect<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type _value = Expect<Equal<BlockValue<typeof theme>, string>>;
type _reads = Expect<
  Equal<
    BlockReads<typeof theme>,
    StoreRead<typeof settings, readonly ["theme"]> | StoreRead<typeof settings, readonly ["size"]>
  >
>;

export const banner = createMemo(
  $(function* () {
    // Delegation accumulates the lib block's reads; a local path adds one more.
    return `${yield* theme} ${yield* settings.size}`;
  })
);
