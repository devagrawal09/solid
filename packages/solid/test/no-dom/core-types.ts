import type { Component, Element, ParentProps, ResolvedChildren } from "solid-js";
import { children, createSignal, Show } from "solid-js";

const [value] = createSignal(1);

const Primitive: Component = () => "ready";
const Parent: Component<ParentProps> = props => props.children;

children((): Element => ["a", 1, false, null]);

const resolved: ResolvedChildren = "child";

Show({
  get when() {
    return value();
  },
  children: current => current(),
  fallback: resolved
});

Show({
  get when() {
    return value();
  },
  keyed: true,
  children: current => current.toFixed(),
  fallback: resolved
});

void Primitive;
void Parent;

// Block-derived stores keep their metadata through the published declarations.
import { $, createProjection, readStore, wait } from "solid-js";
import type { BlockAsync, BlockErrors, BlockStore } from "solid-js";

const total = createProjection(
  $(function* (draft: { total: number }) {
    draft.total = yield* value;
  }),
  {}
);
const remote = createProjection(
  $(function* () {
    return { total: yield* wait(Promise.resolve(1), RangeError) };
  }),
  {}
);
const reads = $(function* () {
  return (yield* readStore(total, s => s.total)) + (yield* readStore(remote, s => s.total));
});
const asyncThroughRemote: BlockAsync<typeof reads> = true;
const errorsThroughRemote: RangeError = null! as BlockErrors<typeof reads>;
const typedStore: BlockStore<
  typeof remote extends BlockStore<infer B, any> ? B : never,
  { total: number }
> = remote;

void asyncThroughRemote;
void errorsThroughRemote;
void typedStore;
