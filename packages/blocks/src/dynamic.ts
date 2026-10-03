/*
 * `$dynamic`: Solid's `dynamic()` with a block body, created in a setup.
 */
import { dynamic, type DynamicOptions } from "@solidjs/web";
import type { ComponentProps, ValidComponent } from "solid-js";
import type { Component as SolidComponent } from "solid-js";
import { CreateOp, memoCompute, type SyncReturn } from "./runtime.js";
import type { Create, MemoOp, Yieldable } from "./types.js";

type Settled<R> = R extends PromiseLike<infer U> ? Iterated<U> : Iterated<R>;
type Iterated<R> = R extends AsyncIterable<infer U> ? U : R;

/**
 * `const View = yield* $dynamic(function* () { return yield* attempt(() => getUser(yield* props.id), onError) })`
 * in a setup: a component rendering what the body returns (Solid's
 * `dynamic`). The body reads with `yield*` and re-runs when they change; a
 * server component call goes through `attempt`, which types its failure. The
 * component itself is a plain Solid one: its pending and its failures are not
 * in its type.
 */
export function $dynamic<Y extends MemoOp = never, R = unknown>(
  body: () => Generator<Y, SyncReturn<R>, any>,
  options?: DynamicOptions
): Yieldable<
  Create<"dynamic">,
  SolidComponent<ComponentProps<Extract<Settled<R>, ValidComponent>>>
> {
  return new CreateOp("dynamic", () => dynamic(memoCompute(body) as any, options)) as any;
}
