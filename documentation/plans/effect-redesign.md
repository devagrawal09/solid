# One-Function Effects and Tracked Writes in the Generator Frontend

Status: design note, 2026-09-26. Nothing here is implemented. Authored examples use the generator frontend `$(function* () {})`.

## Question

Solid 2 split effects into `createEffect(compute, effect)` because dependencies must be read and settled before a side effect runs:

- a pending read must not produce a partial frame;
- a transition may run the compute speculatively, possibly more than once, while the side effect waits for the commit;
- pending retries re-run the compute.

If the compiler can see every reactive read and write in an effect, can authors go back to one function? And can writes return, both in effects and in reactive scopes?

## 1. One-function effects, compiled into the split form

Knowing the dependency set statically does not remove the reasons for the split: the values still have to be read and settled before the side effect runs. Instead, the compiler **slices** one block into the two phases. In a generator block the slice is exact: every `yield*` of a signal or path is a read and goes to the compute half, together with the control flow it depends on. Everything else is the effect half.

```ts
// authored
createEffect(
  $(function* () {
    el.title = yield* title;
    if (yield* open) log(yield* count);
  })
);

// emitted
createEffect(
  () => {
    const t = title(),
      o = open();
    return [t, o, o ? count() : undefined];
  },
  ([t, o, c]) => {
    el.title = t;
    if (o) log(c);
  }
);
```

Conditional reads stay conditional in the compute half, so runtime tracking remains authoritative. The semantics are those of the hand-written split.

### Read-after-write

Writes are typed operations (`yield* write(setter, value)`), so they land in the effect half. That is 2.0's effect-phase rule: the phase never observes its own unsettled writes. A read placed after a write was hoisted into the compute half and sees the pre-write value. The block's `Writes` metadata names the setter, so the compiler can diagnose this case:

```ts
createEffect(
  $(function* () {
    yield* write(setA, 1);
    log(yield* b); // diagnostic: b derives from a; this read sees the pre-write value
  })
);
```

Today, reactive hosts reject blocks with a non-empty `Writes` category. The redesign needs an effect host type that admits `Writes` and requires every write to slice into the effect half.

## 2. Barrier reads

A read, or the branch around it, that depends on the effect's own side effect cannot be hoisted without more machinery. Write-then-measure is the common case:

```ts
createEffect(
  $(function* () {
    el.textContent = yield* label;
    if (el.scrollHeight > el.clientHeight) yield* write(setTruncated, yield* fullText);
  })
);
```

### Preferred: speculative prefetch with muted links

Read the tail's static may-read set in the compute half, whatever branch the effect later takes. After the effect phase, links whose values were not consumed are **muted**: the link stays, but a change on it no longer schedules the effect. The next consuming run re-activates it.

```ts
// emitted, roughly
createEffect(
  () => [label(), speculative(fullText)],
  ([t, ft]) => {
    el.textContent = t;
    if (el.scrollHeight > el.clientHeight) setTruncated(ft.use());
  }
);
```

- **Behaviour.** The effect re-runs for `fullText` only while the branch that reads it is taken. That is 1.x dynamic tracking, but every read still gets 2.0's settle semantics.
- **Runtime.** A per-link "speculative" label, next to the existing `_pendingObserver` label, plus a mute step after the effect phase. Muting instead of unlinking avoids allocation churn.
- **Pending.** A speculative read of a pending source holds the effect even when the branch will not consume it. This is conservative: a longer wait, never a torn frame. The alternative, holding only if consumed, is impossible because side effects have already run by then.
- **Errors.** An errored speculative read is captured in the compute half and rethrown at `use()` through the effect's error handler. It fails the effect only if consumed.
- **Cost.** Speculative reads force dirty memos to recompute and keep auto-dispose memos observed. The compiler knows which reads are memos and can weigh this.
- **Still rejected:**
  - a source chosen by a side effect, e.g. `const sig = pick(el.dataset.kind); yield* sig`;
  - an unbounded may-read set, e.g. `yield* store.items[i]` in a data-dependent loop.

### Alternatives considered

1. **Whole-block fallback to `createTrackedEffect` semantics.** Reads see committed values, the effect cannot hold a transition or suspend, and it can tear or double-run. Acceptable in compat mode with a dev warning at the barrier line; in strict mode it is a silent semantic switch.
2. **Tracked tail.** Slice up to the barrier and run the rest with dynamic tracking inside the effect phase. It needs a new runtime construct, cannot suspend a pending tail read, and a tail dependency change re-runs the whole effect. Superseded by prefetch.
3. **No fallback.** Reject in strict mode with a quick fix that splits the block into an effect plus `onSettled`. Barrier effects are often two effects in disguise: write the DOM, then react to the layout. This remains the answer for the two rejected cases above.

## 3. Writes in reactive scopes, lowered into derivations

Writes stay illegal as side effects in reactive scopes, because computes are re-executable (transition forks, retries, mid-pass invalidation). Knowing statically which signal is written does not make a write idempotent. What it does allow is **lowering the write into a derivation**, which the runtime then owns per world.

```ts
// single writer: setB is written nowhere else
createEffect($(function* () {
  yield* write(setB, (yield* a) * 2);
}));
// lowered
const b = createMemo($(function* () {
  return (yield* a) * 2;
}));

// reset with other writers: an event also calls setB
createEffect($(function* () {
  yield* a;
  yield* write(setB, init);
}));
// lowered
const [b, setB] = createSignal($(function* () {
  yield* a;
  return init;
}));
```

- **Partial store writes** lower to a `createProjection` block.
- **Cycles:** a scope that writes a signal it transitively reads is rejected, with the cycle path taken from the `Reads`/`Writes` graph.
- **Still rejected:**
  - several writers with different write shapes;
  - a setter passed to unknown code;
  - a write after a `yield*` of a task.
- In an app the linker has proven async-free, there are no transitions or retries, so the re-execution objection mostly disappears. That is a possible later relaxation, not a starting point.

## Work plan

1. **Census.** Over the corpus in `scripts/heuristics/census.mjs` (mostly 1.x-era code), count:
   - effects whose reads slice cleanly;
   - barrier effects, split into prefetchable and rejected;
   - single-writer "effect writes a signal" patterns that lower to memos or writable derived signals.
2. **Slicing prototype** for generator effect blocks. It must pass an equivalence gate against hand-written split effects, plus refusal fixtures and conformance traces with transitions and async sources.
3. **Prefetch runtime prototype:** the speculative link label, `use()`, mute after the effect phase, and lazy error capture. Semantics tests against `createTrackedEffect` traces: runs only while the branch is taken; pending and errored sources that are not consumed.
4. **Performance:** effect-writes-signal (two flushes) against the lowered memo (one flush), and the cost of speculative reads, on the heuristic-oracles harness.
