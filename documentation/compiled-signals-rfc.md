# RFC: Strict Reactive Blocks For Solid

**Status:** Draft  
**Target:** Solid 2 experimental API  
**Reference implementation:** `experiment/iterable-signals`

## Summary

Add `$()` as a compiler-recognized boundary for reactive code. A strict block lets Solid analyze reads, writes, async work, errors, ownership, captures, and escapes while preserving normal fine-grained runtime semantics.

```tsx
const doubled = createMemo($(() => count() * 2));
const user = createAsync($(async () => loadUser(userId())));

<button onClick={$(() => setCount(value => value + 1))}>{doubled()}</button>;
```

The immediate proposal is a strict frontend, shared analyzer, diagnostics, summaries, and handwritten-equivalent lowering. Whole-program runtime removal, server replay elimination, inert hydration, and resumable events are follow-up consumers of the same graph, not requirements for the initial API.

## Motivation

Solid discovers dependencies efficiently at runtime, but the build cannot generally prove what a callback reads, writes, owns, imports, or leaks. That prevents safe removal of reactive machinery and makes server/client replay and resumability depend on conventions rather than checked contracts.

`$()` provides an incremental boundary where unresolved behavior is a diagnostic instead of an optimizer guess. It should enable stronger tooling and smaller output without changing Solid's branch-sensitive tracking, scheduling, ownership, cleanup, errors, suspense, transitions, or equality semantics.

## Goals

- Compile qualifying callbacks to ordinary handwritten-equivalent Solid code.
- Report reactive capabilities and escapes at authored source locations.
- Preserve runtime dependency tracking whenever the active read set is conditional.
- Support application and package summaries without exposing the full graph through TypeScript generics.
- Permit conservative, separately measured optimizations over proven graphs.
- Keep ordinary Solid and third-party JavaScript usable through explicit compatibility boundaries.

## Non-Goals

- Statically analyze arbitrary JavaScript.
- Replace signals, owners, or runtime tracking with a static dependency array.
- Make server components, resumability, or Wasm part of the first release.
- Automatically split arbitrary JSX feature regions.
- Change event, async, hydration, or error behavior to make an optimization easier.

## API

### Strict callbacks

For a non-generator callback, `$` is a strict marker. Its statically resolved consumer determines the host.

| Consumer                     | Host           | Semantics                                    |
| ---------------------------- | -------------- | -------------------------------------------- |
| `createMemo`, `createEffect` | Reactive       | Tracked for the computation                  |
| `createAsync`                | Async reactive | Parent reads tracked before first suspension |
| JSX insertion                | JSX            | Tracked by the insertion owner               |
| JSX event attribute          | Event          | One-shot reads; writes permitted             |

The marker has identity-like TypeScript behavior through a small branded callback type. It does not create a memo or effect by itself. A callback with no unique host, an unknown forwarding helper, or incompatible multiple uses is rejected in strict mode.

### Generator compatibility

The existing typed generator form remains supported:

```tsx
const label = createMemo(
  $(function* () {
    const user = yield* userSignal;
    return yield* user.name;
  })
);
```

Generator blocks remain useful for explicit typed operations and direct store/prop paths. Compat builds may retain their runtime driver where lowering is unavailable. Strict builds must lower or reject them and must not ship the fallback driver for an unsupported block.

### Wider opt-in

`"use solid strict"` is reserved for a later lexical component/module opt-in after the single-callback contract and editor tooling stabilize.

## Semantics

- Reactive reads before suspension belong to the parent computation. Parent reads after `await` are invalid.
- Owned creation after suspension is allowed only when the environment restores the captured owner and stale or disposed flights cannot resume.
- Event reads are untracked and one-shot; reading a pending source may wait without rerunning the event reactively.
- Writes are rejected in memo, effect, and JSX hosts and permitted in event hosts.
- Conditional reads retain normal runtime tracking. A bounded may-read set does not subscribe to every possible source.
- Context is resolved with ordinary `useContext` during setup and captured by events. Event-time context lookup and `yield* Context` are outside the initial proposal.
- Unknown calls, escapes, dynamic components, mutable captures, and unsummarized libraries either preserve compat behavior or fail the strict build.

## Analysis Contract

The compiler, `solid-tsc`, linker, and future language server share one analyzer. Each block records:

- host and source sites;
- reads, writes, paths, async work, and possible failures;
- owned creations and owner edges;
- captures, escapes, calls, imports, and render edges;
- environment and server/client boundary facts where known; and
- completeness: `exact`, `bounded`, or `unknown`.

Detailed facts live in versioned sidecar summaries keyed by resolved symbols and source hashes. Public declarations expose only small brands that generic APIs genuinely constrain. Missing, stale, incompatible, or contradictory summaries become `unknown`.

`solid-tsc` remains the TypeScript-facing command for projected direct-path checking, mapped diagnostics, declaration emit, and typed summary refinement. The bundler owns final module resolution and whole-graph reachability.

## Build Modes

### Compat

- Lowers supported blocks.
- Preserves ordinary JavaScript boundaries.
- May retain generator/runtime fallback support.
- Deoptimizes unknown edges rather than changing behavior.

### Strict

- Requires every relevant application edge to be exact or conservatively bounded.
- Rejects unknown hosts, effects, escapes, imports, and incompatible summaries.
- Erases `$` markers and unsupported fallback machinery.
- Enables an optimization only when its separate semantic proof succeeds.

Strict is a build contract, not a faster runtime selected by a local annotation alone.

## Initial Scope

The first experimental release should include:

1. Non-generator strict markers for memo, effect, async, JSX, and event hosts.
2. Existing generator blocks and direct typed store/prop paths.
3. Shared compiler/`solid-tsc` analysis, diagnostics, and per-module summaries.
4. Host fusion and block erasure for locally proven callbacks.
5. The semantic conformance harness as a required regression gate.
6. Off-by-default store handles and async-free runtime selection only for graphs that satisfy their published proof gates.

The initial release does not include cold event extraction, replay elimination, inert-region removal, capability-selected hydration, or resumable events. Existing prototypes for those features exposed correctness and contract gaps and remain excluded until redesigned.

## Server Components And Resumability

The end state is a coordinated graph with environment-specific nodes, not unrelated server and client graphs. Boundary edges include server-function IDs, client slots and frame scopes, SSR claims, serialized values and store traces, live holes, and error/suspense coordinates.

That graph may eventually allow Solid to:

1. execute server-only computations and stream authoritative HTML and values;
2. adopt proven server results without replay;
3. omit client code and hydration for inert regions;
4. load an addressable event block with serialized/path-based captures; and
5. hydrate the smallest owner region when direct resumption is not provable.

Before this work starts, the server `$` driver needs an environment-correct owner interface, server directives must be pinned through code motion, and the summary ABI must represent serialization and frame/slot edges.

## Validation

Every accepted lowering must pass the shared conformance oracle against handwritten Solid. Coverage includes values, rerun order, conditional subscriptions, equality, events, cleanup, ownership, async supersession, errors, stores, SSR, hydration, and deliberately planted semantic mutations.

Optimization acceptance also requires reproducible measurements of minified/gzip size, runtime instructions or time, allocations, compiler cost, hydration work, and incremental build impact. A local microbenchmark win is insufficient when the complete application bundle regresses.

## Rollout

1. Ship experimental compiler and `solid-tsc` flags with no default runtime change.
2. Stabilize diagnostics, summary versioning, package publication, source maps, and editor integration.
3. Enable proven local erasure and opt-in store/runtime specialization.
4. Define the coordinated server/client boundary schema and server ownership contract.
5. Prototype replay, inert regions, capability selection, and resumable events independently, each behind conformance and measurement gates.

## Open Questions

- Final package/export location and public name for `$`.
- Whether lexical `"use solid strict"` is valuable after callback-level adoption.
- Summary ABI ownership and compatibility policy for precompiled libraries.
- How editor services expose dependency, ownership, and deoptimization traces.
- Which server/client coordinates remain stable across builds and deployments.
- Whether resumable event captures use only serialized values and root/paths or also a registered action model.

## Decision Requested

Accept `$()` strict reactive blocks and the shared analysis contract as an experimental Solid 2 direction. Accept only the initial scope above. Treat server replay, hydration elimination, runtime selection, event extraction, and resumability as separate RFCs or amendments after their proofs and protocols are complete.

The full exploration history, measurements, rejected prototypes, and implementation inventory remain in [`plans/typed-generator-compiler.md`](./plans/typed-generator-compiler.md).
