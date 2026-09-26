# One-Function Effects in the Generator Frontend

Status: design note, 2026-09-26. Nothing here is implemented. Authored examples use the generator frontend `$(function* () {})`.

## Question

Solid 2 split effects into `createEffect(compute, effect)` because dependencies must be read and settled before a side effect runs:

- a pending read must not produce a partial frame;
- a transition may run the compute speculatively, possibly more than once, while the side effect waits for the commit;
- pending retries re-run the compute.

If the compiler can see every reactive read and write in an effect, can authors go back to one function? And can writes return, both in effects and in reactive scopes? (Answers: yes, compiled into the split form; no writes in effects or reactive scopes, where the diagnostic suggests a derivation; writes belong to event hosts and actions.)

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

### No writes in effects (decided)

Effect blocks reject the `Writes` category, as reactive hosts already do: `yield* write(...)` inside a `createEffect` block is a compile error. Writes belong to event hosts and actions. Derived state is authored as a derivation (section 3).

This is stricter than 2.0 today, where the effect phase may write. It removes the class of effects that exist only to copy one signal into another, and with it any need for a read-after-write rule: an effect never observes its own writes because it has none. An effect's side effects are non-reactive (DOM, logging, third-party APIs, subscriptions).

## 2. Barrier reads

A read, or the branch around it, that depends on the effect's own side effect cannot be hoisted without more machinery. Write-then-measure is the common case:

```ts
createEffect(
  $(function* () {
    el.textContent = yield* label;
    if (el.scrollHeight > el.clientHeight) el.title = yield* fullText;
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
    if (el.scrollHeight > el.clientHeight) el.title = ft.use();
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

## 3. Writes in effects and reactive scopes: not lowered (decided)

Writes stay illegal in reactive scopes and, per section 1, in effects. Computes are re-executable (transition forks, retries, mid-pass invalidation), and knowing statically which signal is written does not make a write idempotent.

Automatically lowering such writes into derivations was considered and rejected: derivations are better authored directly. Lowering would have to define semantics that 2.0 never had, and it breaks in several ways:

- the writer and the target have different owners and lifetimes;
- conditional writes need an exact seed, and updater-form writes are reducers, not derivations;
- a meaningful initial value disappears;
- after a task `yield*`, the target becomes an async memo that suspends its readers;
- errors move from the writer's boundary to the readers';
- the one-flush lag disappears;
- exported targets turn "single writer" into a whole-program claim.

Instead, the compiler's diagnostic proposes the derivation as a **quick fix**, applied only when the author accepts it:

```ts
createEffect($(function* () {
  yield* write(setB, (yield* a) * 2);   // STRICT_WRITE_IN_REACTIVE_HOST
}));
// quick fix: make b a derivation
const b = createMemo($(function* () {
  return (yield* a) * 2;
}));
```

Suggested replacements:

- a single writer: a memo;
- a reset with other writers: `createSignal($(function* () { ... }))`;
- partial store writes: a `createProjection` block.

Cycles in the `Reads`/`Writes` graph are reported with their path. A write that is really a response to user input belongs in an event block or action.

## Work plan

1. **Census.** Over the corpus in `scripts/heuristics/census.mjs` (mostly 1.x-era code), count:
   - effects whose reads slice cleanly;
   - barrier effects, split into prefetchable and rejected.
2. **Slicing prototype** for generator effect blocks. It must pass an equivalence gate against hand-written split effects, plus refusal fixtures and conformance traces with transitions and async sources.
3. **Prefetch runtime prototype:** the speculative link label, `use()`, mute after the effect phase, and lazy error capture. Semantics tests against `createTrackedEffect` traces: runs only while the branch is taken; pending and errored sources that are not consumed.
4. **Performance:** the cost of speculative reads on the heuristic-oracles harness.
