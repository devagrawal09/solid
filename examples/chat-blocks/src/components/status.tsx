// The client half of the slot showcase (examples/chat's Status, as blocks):
// three tiers, one border.
//
// - `progress` and `stats` crossed as reactive expressions: the server
//   re-evaluates them on every commit and re-ships this occurrence's record.
//   `stats` is not ready until generation completes, so its read suspends
//   into the outer boundary; the ticker shows meanwhile.
// - `usage` crossed as a CONTAINER: the server passed a projection itself
//   and this is its live read-only twin, read through paths
//   (`yield* props.usage.parts`), each field granularly.
//
// What the library's rules change: the props say what they are — every one
// is pending until its first value lands (`Source<T, true>`) — and a view
// that reads a pending prop is pending, so what each `<Loading>` covers is
// its own small component, handed to the boundary as a view.
import { $component, Loading, type Source, type TypedProps } from "@solidjs/blocks";
import type { Stats, Usage } from "~/lib/model";

type Pending<T> = Source<T, true, never>;

const Meter = $component(function* Meter(props: TypedProps<{ usage: Pending<Usage> }, "Meter">) {
  return function* () {
    return <span class="meter">¶ {yield* props.usage.parts}</span>;
  };
});

const Ticker = $component(function* Ticker(
  props: TypedProps<{ progress: Pending<string> }, "Ticker">
) {
  return function* () {
    return <span class="ticker">{yield* props.progress}</span>;
  };
});

const Done = $component(function* Done(props: TypedProps<{ stats: Pending<Stats> }, "Done">) {
  return function* () {
    return (
      <span class="done">
        {yield* props.stats.tokens} tokens · {yield* props.stats.rate} tok/s ·{" "}
        {yield* props.stats.seconds}s
      </span>
    );
  };
});

const Status = $component(function* Status(
  props: TypedProps<
    { progress: Pending<string>; stats: Pending<Stats>; usage: Pending<Usage> },
    "Status"
  >
) {
  return function* () {
    return (
      <div class="status">
        <Loading fallback={<span class="meter">…</span>}>{Meter({ usage: props.usage })}</Loading>
        <Loading
          fallback={
            <Loading fallback={<span class="ticker">…</span>}>
              {Ticker({ progress: props.progress })}
            </Loading>
          }
        >
          {Done({ stats: props.stats })}
        </Loading>
      </div>
    );
  };
});
export default Status;
