# RFC: Strict Reactive Blocks For Solid

**Status:** Draft  
**Target:** Solid 2 experimental API  
**Reference implementation:** `experiment/iterable-signals` at `65a94870`

## Decision

Continue the non-generator `$(fn)` form as an experimental, compile-or-error marker for a small set of known hosts. Keep the existing generator block form. Do not accept whole-program strict mode, a public summary ABI, runtime specialization, or server resumability in this decision.

## Terms

- A **strict callback** is a normal arrow or function expression passed to `$`, such as `$(() => count())`. It must be compiled.
- A **generator block** is the existing `$(function* () { ... })` form. Yielded operations describe reads, waits, failures, and writes in its TypeScript type.
- A **host** is the API or JSX position that runs the callback. The host decides whether reads are tracked and whether writes are allowed.
- A **summary** is compiler data about one strict callback. It is not a static dependency list and does not replace Solid's runtime tracking.

## Proposed Public API

`$` keeps two overload families:

```ts
// New strict callback marker. The brand is compile-time only.
$(fn: (input: Input) => Result): StrictCallback<Input, Result>;

// Existing typed generator block.
$(fn: (input: Input) => Generator<Operation, Result>): Block<...>;
```

For a strict callback, the compiler must:

1. resolve one supported host;
2. analyze reads, writes, calls, captures, escapes, owned creation, and `await`;
3. report an error if the callback violates that host's rules; and
4. erase the `$` call so the host receives the normal callback.

```tsx
// Authored
const doubled = createMemo($(() => count() * 2));

// Output of the strict pass, before unrelated import cleanup
const doubled = createMemo(() => count() * 2);
```

The normal Solid host still owns tracking, scheduling, equality, cleanup, errors, transitions, and suspense.

### What `$` Does Not Do

- It does not create a memo, effect, owner, or subscription.
- It does not replace dynamic tracking with subscriptions to every possible read.
- It does not make arbitrary JavaScript analyzable.
- It does not restore an owner after `await`.
- It does not make `createAsync` a host. Solid 2 uses an async `createMemo` in this experiment.
- It does not make a non-generator callback valid as a JSX child.
- It does not select a smaller runtime or remove fallback code by itself.
- It is not a reliable runtime identity function. Stock TypeScript only sees a callable `StrictCallback` phantom brand. If compilation is skipped, development builds reject arrow and async callbacks with `[STRICT_NOT_COMPILED]`. Production has no equivalent guard, and ordinary function expressions cannot be identified reliably at runtime.

## Implemented Experiment

The compiler recognizes strict callbacks when `generators` is enabled. That compiler option defaults to `true`. These are the implemented hosts:

| Authored position                       | Host                  | Reads                            | Writes   | `await` |
| --------------------------------------- | --------------------- | -------------------------------- | -------- | ------- |
| `createMemo($(fn))`                     | memo                  | tracked before the first `await` | rejected | allowed |
| `createSignal($(fn))`                   | computed signal       | tracked before the first `await` | rejected | allowed |
| `createEffect($(fn), effectFn)`         | effect compute        | tracked before the first `await` | rejected | allowed |
| `createRenderEffect($(fn), effectFn)`   | render-effect compute | tracked before the first `await` | rejected | allowed |
| `<button onClick={$(fn)}>` or `on:name` | intrinsic DOM event   | untracked and one-shot           | allowed  | allowed |

The factories must be named imports from `solid-js` or `@solidjs/signals`. A `const` marker may be reused only by hosts of one kind. Component props, exports, unknown forwarding helpers, non-first factory arguments, and JSX children are not hosts.

The second callback passed to `createEffect` or `createRenderEffect` is the ordinary effect phase. It may write, but it is not an implemented strict-callback host.

### Memo And Conditional Reads

```tsx
const label = createMemo($(() => (enabled() ? name() : "hidden")));
```

The summary lists `enabled` and `name`. At runtime, Solid subscribes to `name` only while that branch runs. The compiler does not subscribe to both sources.

### Async Memo

```tsx
const user = createMemo(
  $(async () => {
    const id = userId(); // tracked by the memo
    const value = await fetchUser(id);
    return formatUser(value); // only plain values after await
  })
);
```

Direct reactive reads after the first `await` fail with `STRICT_READ_AFTER_AWAIT`. Owned creation after `await` fails with `STRICT_CREATION_AFTER_AWAIT` in every host. The current callback and generator drivers do not restore the captured owner on continuation. An event may read after `await`, but that read remains untracked.

### Event

```tsx
<button
  onClick={$((event: MouseEvent) => {
    const step = event.shiftKey ? 10 : 1;
    setCount(value => value + step);
  })}
/>
```

Event parameters need an annotation on the marked callback. The compiler erases the marker, then the normal JSX transform installs the handler.

### JSX And Generator Compatibility

Non-generator JSX insertion is not implemented:

```tsx
<div>{$(() => count())}</div> // STRICT_HOST_UNKNOWN
```

The existing generator form remains the typed JSX form:

```tsx
function View(props: { theme: string }) {
  const [count] = createSignal(1);

  return $(function* () {
    return <div class={yield* props.theme}>Count: {yield* count}</div>;
  });
}
```

For a JSX generator block, direct tasks, failures, and writes are refused. Reads may still surface pending or error state from the source being read. JSX `yield*` is compiler-only syntax: disabling generator lowering does not provide equivalent JSX behavior.

Generator blocks otherwise keep their existing behavior. The default compiler pass lowers supported `yield*` operations to calls and keeps the runtime block wrapper. The off-by-default `hostFusion` option can erase the wrapper for a locally proven host. With `generators: false`, the runtime driver can execute ordinary generator operations, but it is not a universal fallback for compiler-only JSX or direct prop-path forms.

## Summary Meanings

The implemented summary uses `exact`, `bounded`, and `unknown`:

| Result    | Meaning                                                                                                                                                                                             | Small example                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `exact`   | All recorded operations run on every normal path. There are no unsummarized calls or opaque accesses.                                                                                               | `$(() => count() * 2)`                     |
| `bounded` | Known capability reads are listed, but a branch, loop, closure, early return, opaque value, or unsummarized call makes execution conditional or incomplete. Runtime tracking remains authoritative. | `$(() => enabled() ? format(name()) : "")` |
| `unknown` | The callback has a diagnostic, such as an unknown host or an escaped capability. Analysis returns a partial graph, but transform fails.                                                             | Passing `count` itself to unknown code     |

An unsummarized helper is allowed only when its arguments are plain values. This is bounded:

```tsx
const title = createMemo($(() => formatTitle(name())));
```

Passing the accessor is an escape and is rejected:

```tsx
const title = createMemo(
  $(() => {
    registerSource(count); // STRICT_CAPABILITY_ESCAPE
    return count();
  })
);
```

There is no helper annotation that turns this unknown edge into a trusted one. Library summaries and any local escape mechanism are later work.

## Tooling Today

| Tool                              | Implemented now                                                                                                                                                                                                    | Not implemented                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `@solidjs/compiler`               | Erases valid strict markers; returns `strictBlocks`; exposes `analyzeStrictBlocks`; lowers generator blocks                                                                                                        | Stable cross-package summary ABI                              |
| `solid-tsc`                       | Projects generator direct store/prop paths for TypeScript; maps diagnostics; runs TypeScript emit; emits declarations with projected path types; returns strict summaries from `check()` and `analyzeStrictFile()` | Per-module strict sidecar files and a language-service plugin |
| `solid-tsc --capabilities <file>` | Optionally writes the separate Track A typed capability summary after a successful check                                                                                                                           | General strict library summaries                              |
| Bundler prototype                 | Can link capability summaries for the async-free experiment                                                                                                                                                        | A production compat/strict build contract                     |

Detailed strict summaries currently live in transform results or process memory. Published declarations contain generator path types, not the proposed versioned strict sidecars.

## Compat And Strict Builds

These are proposed whole-application contracts. They are not compiler modes today.

| Proposed mode | Required behavior                                                                                                                                                                                                                                                                                            |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compat        | Keep ordinary Solid and JavaScript boundaries on the general runtime. Lower supported generator blocks. Keep the generator driver where used. Deoptimize unmarked unknown code rather than changing behavior. A marked strict callback still compiles or errors; it never silently becomes a plain callback. |
| Strict        | Require a complete linked application graph. Reject unknown edges needed by an optimization. Omit a runtime capability only after the linker proves it unused across application and library code. A local `$` marker alone is not that proof.                                                               |

`"use solid strict"` is neither implemented nor reserved by the compiler. The spelling exists only in design notes, and another note uses `"use solid-strict"`. A lexical directive needs a separate decision.

## Experiment Status

| Area                                          | Status at the reference head                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Generator blocks and direct paths             | Implemented experiment; default compiler lowering, with documented runtime-driver limits                                                 |
| Non-generator strict callbacks                | Implemented for the five host positions listed above                                                                                     |
| Host fusion                                   | Implemented, experimental, default `false`                                                                                               |
| Store handles, Track B                        | Integrated as `storeHandles`, default `false`; proven paths can stay handle-backed, while unknown uses materialize a compatibility proxy |
| Async-free runtime, Track A                   | `@solidjs/signals/sync`, summaries, linker, and selection plugin exist as a proof-gated experiment; no default build selects it          |
| Local status-free path, Track A               | Measured negative and left unselected                                                                                                    |
| Cold event extraction, Track C                | Excluded because of evaluation-order, code-generation, and event-queue correctness failures                                              |
| Replay elimination and inert regions, Track D | Excluded; only the JSX-block hydration-ID scope prerequisite is integrated                                                               |
| Capability-selected hydration, Track E        | Excluded pending safer selection, validation, and a shared manifest contract                                                             |

Store handles and the async-free runtime are not part of the initial public API. Their committed measurements are prototype results, not release claims. In particular, the local status-free hook matched none of the 14 measured real blocks and regressed size and update cost, so the integrated branch does not select it.

## Initial Acceptance Scope

Accept only:

1. the non-generator `$(fn)` marker as an experimental compile-or-error API;
2. the implemented memo, computed-signal, effect-compute, render-effect-compute, and intrinsic-event hosts;
3. source-located diagnostics and the current in-process summary for tooling experiments; and
4. continued compatibility with the existing generator overload.

Do not promise a stable summary file format, editor integration, whole-program mode, smaller runtime, server optimization, or new JSX callback host in this stage.

## Validation Evidence

- Compiler fixtures lock strict output, summaries, diagnostics, source maps, and coexistence with generator blocks.
- `solid-tsc` fixtures cover projected direct paths, mapped strict diagnostics, declaration consumption, and capability output.
- The web conformance harness contains 15 scenarios across client, SSR, and hydration matrices. It compares handwritten, runtime-generator, compiled, and host-fused traces where each mode applies. Its generated coverage file also records declared differences and `n/a` cells; it does not claim every mode is identical.
- Track A and B measurements remain in the exploration plan with their benchmark inputs and gates. Correctness failures, not benchmark wins, determine why Tracks C, D, and E remain excluded.

Before widening the accepted host set, add a fixture for the new syntax and a semantic trace against handwritten Solid. Before selecting a runtime or store representation, rerun its proof gate, conformance matrix, bundle-size measurement, and runtime benchmark on the integrated graph.

## Staged Server End State

Solid 2 server components already ship as an experimental preview. They use server functions and frame streams; `$` summaries do not currently participate. A request works as follows:

1. The client calls a server function by ID and arguments. `dynamic` consumes the returned component.
2. The server runs that component and streams frame records containing HTML, data, and coordinates for client slots.
3. The client applies the frames to a stable per-call boundary, fills the slots, and morphs later results for the same call without remounting preserved client state.

A later RFC may add cross-environment summary edges. Only then could a build separately prove that a result need not replay, a region needs no hydration, or an event can resume from serialized captures. That work needs an environment-correct server owner interface, serialization rules, stable frame and slot coordinates, and error routing. It is not part of this RFC.

## Later Possibilities

- Versioned library summaries with resolved symbol identity and stale-summary checks.
- A language-service plugin for strict diagnostics and graph inspection.
- A separately specified lexical strict directive.
- More hosts, including non-generator JSX, after their ownership and error rules are defined.
- Post-`await` owned creation after the runtime restores and validates the captured owner and excludes stale continuations.
- Proof-gated store and runtime selection through separate RFCs.

## Non-Goals

- Static analysis of arbitrary JavaScript.
- Automatic dependency arrays or replacement of Solid's dynamic subscriptions.
- Automatic JSX feature splitting.
- Cold event extraction, replay elimination, inert regions, or resumable events in the initial API.
- Wasm lowering.

## Decision Requested

Approve the initial acceptance scope as an experimental direction. Keep the summary ABI, whole-application modes, runtime selection, server replay, hydration removal, and resumability behind later decisions with their own correctness evidence.

The full exploration history, measurements, rejected prototypes, and implementation inventory remain in [`plans/typed-generator-compiler.md`](./plans/typed-generator-compiler.md).
