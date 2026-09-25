import { markAsyncCapability } from "./core/dev.js";
import { createErrorBoundary, createLoadingBoundary } from "./boundaries.js";
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
} from "./generator.js";
import { createMemo, type SourceAccessor } from "./signals.js";

/*
 * Function-style boundaries over blocks (experimental).
 *
 * Both are *creation-time* primitives: call them where you would call
 * `createMemo` (a component body, a root) — they create the inner memo and
 * the boundary under the current owner and return a new block that reads
 * the boundary. They are the function-form counterparts of `<Loading>` /
 * `<Errored>` for typed blocks: JSX syntax cannot carry a component's
 * generic return type, so composing boundaries as functions is what keeps
 * the block metadata. The returned block's only direct effect is the read
 * of the boundary accessor (colored with the derived totals), so it is
 * admissible as JSX; the inner block may be anything a reactive host admits.
 */

/**
 * Consume an async block: while its reads or tasks are pending the fallback
 * is the value, so the returned block is not pending. Errors pass through
 * as the returned block's inherited errors.
 */
export function loading<B extends AnyBlock & ReactiveHostBlock, F>(
  block: B,
  fallback: () => F
): Block<BlockValue<B> | F, ColoredAccessor<BlockValue<B> | F, false, BlockErrors<B>>> {
  if (__TEST__) markAsyncCapability();
  const inner = createMemo(block);
  const view = createLoadingBoundary(() => inner(), fallback) as SourceAccessor<BlockValue<B> | F>;
  return $(function* () {
    return yield* view;
  }) as any;
}

/**
 * Handle the listed error classes thrown by a block; the returned block's
 * error union excludes them. An error of any other type is rethrown from
 * the boundary and propagates to the next `errored` (or `<Errored>`).
 */
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
