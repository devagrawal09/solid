// Server twins of @solidjs/signals' `loading` / `errored` block boundaries,
// built on the server's own memo and boundary primitives (the block driver
// itself is shared — see ./signals.ts).
import {
  $,
  type AnyBlock,
  type Block,
  type BlockAsync,
  type BlockErrors,
  type BlockValue,
  type ColoredAccessor,
  type ErrorClass,
  type ReactiveHostBlock
} from "@solidjs/signals";
import { createLoadingBoundary } from "./hydration.js";
import { createErrorBoundary, createMemo, type SourceAccessor } from "./signals.js";

export function loading<B extends AnyBlock & ReactiveHostBlock, F>(
  block: B,
  fallback: () => F
): Block<BlockValue<B> | F, ColoredAccessor<BlockValue<B> | F, false, BlockErrors<B>>> {
  const inner = createMemo(block);
  const view = createLoadingBoundary(() => inner(), fallback) as SourceAccessor<BlockValue<B> | F>;
  return $(function* () {
    return yield* view;
  }) as any;
}

export function errored<B extends AnyBlock & ReactiveHostBlock, C extends ErrorClass<any>[], H>(
  block: B,
  errors: [...C],
  handle: (error: InstanceType<C[number]>, reset: () => void) => H
): Block<
  BlockValue<B> | H,
  ColoredAccessor<
    BlockValue<B> | H,
    BlockAsync<B>,
    Exclude<BlockErrors<B>, InstanceType<C[number]>>
  >
> {
  const inner = createMemo(block);
  const view = createErrorBoundary(
    () => inner(),
    (error, reset) => {
      const caught = error();
      if (!errors.some(type => caught instanceof type)) throw caught;
      return handle(caught as InstanceType<C[number]>, reset);
    }
  ) as SourceAccessor<BlockValue<B> | H>;
  return $(function* () {
    return yield* view;
  }) as any;
}
