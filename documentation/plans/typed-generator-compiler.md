# `$()` Typed Reactive Blocks

## Exploration Status

Status as of 2026-09-25: the design remains an experimental, uncommitted branch, but the end-to-end prototype now covers typed blocks, host enforcement, direct typed store/prop paths, compiler lowering, projected TypeScript checking, block-derived signals/stores, DOM event dispatch, and a converted TodoMVC example.

The production proposal has two modes only:

- **Compat** transforms supported blocks and retains runtime generator fallbacks and ordinary JavaScript interoperability.
- **Strict** requires the complete application graph to use typed generator boundaries, rejects unknown or unsupported effects at build time, omits runtime fallback, and automatically selects the fastest and smallest safe runtime and application chunks for the proven capability graph.

Current exploration work:

- Direct path implementation is complete and verified: `yield* store.user.name`, indexed store paths, and `yield* props.count` carry root/path metadata.
- `solid-tsc` provides pre-typecheck source projection, mapped diagnostics, and declaration emit because stock TypeScript cannot type the authored direct-path syntax by itself.
- Runtime-size and app-code partitioning investigations are complete; their recommendations remain proposals, not implemented production optimizations.
- The read-only strict-mode SSR/hydration investigation is complete. It found that current serialization is primarily async-result data, current hydration re-executes the full component tree, and JSX blocks had a hydration-id parity defect. That defect is now fixed by compiler-emitted block id scopes (Track D prerequisite, `track-d-hydration.md`).
- Required performance measurements are documented below; optimized mode is not ready to become the default until reproducible baselines exist.

## Recent Changes

### 2026-09-25

- Added metadata-preserving block overloads for computed `createSignal`, `createStore`, `createProjection`, and `createOptimisticStore`.
- Added direct typed property reads for stores and props with `StoreRead<Root, Path>`, `PropRead<Root, Path>`, `PathValue`, and `PathResult`.
- Added runtime store path tokens, strict unread/direct-use diagnostics, and exact tracked re-walks through the existing store proxy.
- Added compiler lowering for supported member paths before JSX lowering.
- Added `@solidjs/typecheck` and its `solid-tsc` CLI for projected checking, mapped diagnostics, declaration emit, and separate consumer compilation.
- Kept `readStore(store, selector)` for structural reads such as `map`, `filter`, and `every`.
- Added `examples/todos-blocks`, converted applicable reactive, JSX, event, signal, store, and path reads to typed blocks.
- Fixed result-shape probing so blocks may return store proxies without triggering strict direct-read diagnostics.
- Replaced the earlier public `strict | warn | loose` proposal with production `compat | strict` modes; implementation switches remain experimental controls.
- Added required measurements for untransformed runtime overhead, compiler-transform overhead, projected typechecking, optimized runtime performance, and bundle size.
- Completed read-only studies of runtime slicing and app-dominated cold-code partitioning, including chunk clustering, prefetch policies, safety constraints, and benchmark gates.
- Completed a strict SSR/hydration study covering wire serialization, hydration-specific JavaScript, client execution, code/data segment alignment, and resumability limits; identified JSX-block hydration-id parity as a critical blocker.
- Selected cold event-domain extraction and resumable event blocks as the two app-bundle prototypes. Deferred JSX/feature-region splitting is not part of the proposal; existing explicit `lazy()` behavior remains available without strict-mode automation.

## Detailed Prototype Inventory

### Runtime And Types

- `@solidjs/signals` exports `$`, typed blocks, iterable signal accessors, task/failure/write/call operations, loading/error handlers, and direct path operations.
- Blocks carry separate `Reads`, `Tasks`, `Failures`, `Writes`, and `Input` categories, including transitive async/error metadata from readable values.
- Reactive hosts reject writes; JSX hosts admit direct reads only; event hosts admit reads, tasks, failures, and writes.
- `createMemo`, computed `createSignal`, effects, and block-derived stores/projections preserve block metadata.
- DOM event blocks preserve their creation owner through forwarding and route synchronous or asynchronous failures to the captured error boundary.
- Store writes remain explicit through `write(setStore, updater)`; setters do not become context-sensitive.

### Compiler And Typechecking

- The Rust compiler recognizes imported `$` blocks and lowers a conservative generator subset before JSX lowering.
- Supported signal and path reads lower through `perform`; unsupported blocks fall back in compat mode and are intended to fail the build in strict mode.
- Direct paths lower to `readPath(root, keys)` or `readProp(props, keys)` operations.
- `solid-tsc` projects direct path expressions into typecheck-only operations while preserving authored diagnostic positions.
- Emitted declarations contain ordinary public path-operation types, so downstream consumers can use stock TypeScript.
- No language-service plugin exists yet; editors may report errors on authored direct-path syntax even when `solid-tsc` succeeds.
- `solid-tsc --build` and watch mode are not implemented.

### Examples And Verification

- `examples/todos-blocks` exercises transformed blocks, JSX reads, events, stores, direct paths, structural selectors, loading, errors, and runtime fallback coverage.
- The direct-path pass reported green signals, compiler Rust/fixture, Solid, web client, SSR, hydration, `packages/typecheck`, TodoMVC typecheck/test/build, and formatting suites.
- Runtime/transform equivalence, host rejection, root/path inference, diagnostic remapping, declaration emit, and separate consumer compilation have focused coverage.

### Strict SSR And Hydration Findings

- Current SSR serializes async memo/signal results, async projections, iterable results, errors, loading/stream sentinels, and asset maps. Plain signals, synchronous memos, and plain stores are generally recreated by client execution rather than serialized as application state.
- Current hydration re-runs the component tree, creates owners and computations, reconnects dependencies, and executes binding computations; it primarily avoids redundant DOM creation and writes.
- Returned JSX `$` blocks consumed hydration IDs differently on server and client. Strict mode makes these blocks pervasive, so parity was a release blocker. It is fixed: every JSX-producing block reserves its id scope at creation on both sides (`blockScope`; see `track-d-hydration.md` and `hole-owner-id-matrix.md`).
- Root/path metadata can help project async/store payloads and align cold code chunks with cold data segments, but it does not prove object identity, alias safety, serializability, or closure resumability.
- Static components with no client-live behavior are candidates for omitted hydration code only after compiler reachability, refs/directives/context, boundary, and descendant-interactivity proofs are complete.
- Resumable event blocks require every capture to be addressable by a stable root/path, constant, or registered action. Arbitrary closures, DOM nodes, owners, setters, and non-serializable objects remain blockers.
- Streaming, `Loading`, `Errored`, transitions, portals, custom elements, directives, and client-only sources require explicit capability and identity handling; absence of `Writes` alone never proves hydration can be skipped.

### App Bundle Prototype Priorities

The two proposed app-code slicing experiments are:

1. **Cold event-domain extraction.** Move an event block and its cold-only import/call graph into a clustered interaction chunk. Prefetch on route load, idle, visibility, hover, or focus so normal events remain synchronous once interaction is possible.
2. **Resumable event blocks.** Avoid hydrating the creating component when every handler capture is addressable as a stable root/path, constant, serialized value, registered action, and boundary coordinate. Emit an event coordinate in server HTML and load the shared event chunk on demand or through prefetch. The manifest must include the nearest statically proven error-boundary coordinate so a rejected resumed handler routes directly without recreating its component owner chain.

Resumability must reject arbitrary closures, mutable locals, DOM-node captures, unregistered setters, owners, and non-serializable objects. Handlers requiring immediate `preventDefault` or propagation control need a small synchronous shell or must be loaded before interaction. Direct boundary coordinates apply only to resumed event failures; ordinary reactive pending/error status must still propagate through actual dependency consumers because one source can feed multiple boundaries. Error routing, ownership, cleanup, hydration IDs, and action identity must remain equivalent to ordinary hydration.

Compiler-created deferred JSX or feature regions are explicitly out of scope. Strict mode does not turn a synchronous branch into an asynchronous one. Applications may continue to opt into existing `lazy()` and `Loading` behavior directly.

### Strict Multi-Module Pipeline

Strict optimization includes both TypeScript and bundler/linker phases:

1. **Source compiler summaries** record behavioral facts visible in implementations: block effects, captures and escapes, component prop usage, event forwarding, boundary relationships, direct paths, and unknown operations.
2. **`solid-tsc` typed summaries** attach resolved symbol identity across imports/re-exports, instantiated generic and prop types, typed root/path metadata, and validated branded contracts for addressable captures, registered actions, serializable values, and compiled libraries. TypeScript narrows and diagnoses candidates but does not by itself prove runtime behavior.
3. **Bundler/linker analysis** joins summaries over the complete server and client module graphs, propagates `hot | cold | shared | unknown` reachability to a fixed point, computes capability absence, clusters cold event domains, emits resumable-event and hydration manifests, and selects runtime entries. Server and client graphs are analyzed independently.

Missing, incompatible, or escaped metadata becomes `unknown` and conservatively retains hot code, data, hydration, and general runtime capabilities. Published strict-compatible libraries must ship linkable summaries alongside declarations and JavaScript.

### Remaining Work

- Independently review the accumulated experimental diff and public API naming.
- Implement and validate the two production modes as whole-application build contracts, including `solid-tsc` typed-summary emission and bundler/linker fixed-point analysis.
- Add editor language-service support for projected direct-path syntax.
- Build the required compiler/runtime/size benchmark matrix and establish acceptance thresholds.
- Prototype and measure cold event-domain extraction and resumable event blocks; do not add compiler-created deferred feature regions.
- Decide which runtime slicing, SSR serialization, and hydration specializations earn implementation after measurement.
- Define compatibility and publication policy for libraries that cannot provide strict capability manifests.

## Core Goal

Build `$()` into Solid as a typed effect boundary for reactive code.

```tsx
function Component(props) {
  return $(function* () {
    return <div>{yield* props.user.name}</div>;
  });
}
```

The primary purpose is not generator ergonomics. It is to let TypeScript track:

- Every reactive dependency
- Direct asynchronous work
- Possible errors
- Signal writes
- Transitive effects from other signals and blocks

Signals remain usable as ordinary accessors outside strict `$` blocks:

```ts
count();
```

Inside an exact `$` block, signals are read through:

```ts
yield * count;
```

## Three Host Contexts

The same `$()` construct is used in three contexts. The consuming host determines which effects are legal.

| Context              | Reads | Direct async | Explicit errors | Writes |
| -------------------- | ----: | -----------: | --------------: | -----: |
| Reactive computation |   Yes |          Yes |             Yes |     No |
| JSX block            |   Yes |           No |              No |     No |
| Event block          |   Yes |          Yes |             Yes |    Yes |

### Reactive Computations

Reactive computations include memos and similar derived computations:

```ts
const userLabel = createMemo(
  $(function* () {
    const user = yield* userSignal;
    const permissions = yield* loadPermissions(user.id);
    return formatUser(user, permissions);
  })
);
```

They may:

- Read signals
- Perform typed async work
- Propagate typed errors
- Compose other blocks

They may not write signals.

### JSX Blocks

JSX blocks may directly yield signal reads only:

```tsx
function User(props) {
  return $(function* () {
    const user = yield* props.user;
    return (
      <article>
        <h1>{user.name}</h1>
        <span>{yield* props.status}</span>
      </article>
    );
  });
}
```

They may not directly:

- Start a task
- Yield a Promise
- Explicitly raise an error
- Write a signal

A signal read by JSX may itself carry async and error metadata. Therefore a read-only JSX block can still be pending or error-typed.

```ts
props.user: AsyncSignal<User, NetworkError>
```

Reading it contributes:

```text
Reads: props.user
Derived async: true
Derived errors: NetworkError
```

No Promise appears inside JSX. When the signal is ready, `yield* props.user` returns `User`.

When pending, rendering goes through `Loading`. When failed, the error goes through `Errored`.

### Event Blocks

Events allow the complete effect set:

```tsx
const save = $(function* (event: SubmitEvent) {
  const draft = yield* draftSignal;
  const result = yield* saveDraft(draft);
  yield* write(savedDraft, result);
});

<button onClick={save}>Save</button>;
```

Events may:

- Read signals
- Wait for pending signals
- Perform typed async work
- Propagate typed errors
- Write signals
- Compose other event blocks

An event read is one-shot. It does not make the event rerun reactively.

If a read signal is pending, the event waits for it while the current UI remains mounted.

## What `$()` Returns

`$()` returns a branded computation description, called a block.

Conceptually:

```ts
interface Block<
  Value,
  Reads = never,
  Tasks = never,
  Failures = never,
  Writes = never,
  Input = unknown
> {
  (input?: Input): [Tasks] extends [never] ? Value : Promise<Value>;
  readonly [BLOCK]: true;
  readonly [META]: {
    readonly reads: Reads;
    readonly tasks: Tasks;
    readonly failures: Failures;
    readonly writes: Writes;
  };
  [Symbol.iterator](): Generator<Effect, Value, unknown>;
}
```

Effect precision (`exact`, `dynamic`, or `unknown`) is a separate trust classification proposed for compiler/runtime interoperation. It is not yet part of the prototype's `Block` generic parameters.

Derived metadata includes:

```ts
Dependencies = Reads | TransitiveDependenciesOf<Reads>;

Async = HasTasks<Tasks> | AsyncOf<Reads>;

Errors = ExplicitErrors | ErrorsOf<Tasks> | ErrorsOf<Reads>;
```

This distinction is important for JSX. A JSX block can have `Tasks = never` while still having `Async = true` because it reads an async signal.

## Block Consumption

A block can be passed directly to a host:

```ts
const doubled = $(function* () {
  return (yield* count) * 2;
});

const value = createMemo(doubled);
```

Ordinary callbacks remain supported:

```ts
const value = createMemo(() => count() * 2);
```

A block should not be called from an ordinary reactive callback:

```ts
createMemo(() => doubled()); // invalid or returns a generator
```

Instead, pass it directly or compose it through `yield*`:

```ts
const description = $(function* () {
  const value = yield* doubled();
  const label = yield* labelSignal;
  return `${label}: ${value}`;
});
```

This composition carries all transitive effects into `description`.

## No Separate `$$()`

Events do not need a second sigil.

The block declares effects. The host interprets them.

```text
createMemo(block)       → reactive interpretation
JSX returns block       → render interpretation
onClick={block}         → event interpretation
yield* block()          → parent interpretation
```

Event-specific behavior can use named adapters:

```tsx
<button onClick={latest(save)}>Save</button>
<button onClick={queue(save)}>Save</button>
<button onClick={exhaust(save)}>Save</button>
```

## Event Prop Forwarding

A component forwards an event block like any other prop:

```tsx
const save = $(function* (event: MouseEvent) {
  const draft = yield* draftSignal;
  yield* saveDraft(draft);
});

<Child onPress={save} />;
```

```tsx
function Child(props: { onPress: EventBlock<MouseEvent> }) {
  return <button onClick={props.onPress}>Save</button>;
}
```

The same branded value travels through the component tree. Only the final DOM binding interprets it.

```text
Parent block
→ Child prop
→ Wrapper component
→ DOM event binding
→ Event interpreter
```

At the DOM sink, Solid captures:

- Owner
- Error boundary
- Loading or transition context
- Cancellation scope
- Event concurrency policy

### Wrapping Events

A child can create a new block and delegate to the parent block:

```tsx
function ConfirmButton<Handler extends EventBlock<MouseEvent>>(props: { onPress: Handler }) {
  const wrapped = $(function* (event: MouseEvent) {
    const confirmed = yield* confirmOperation("Continue?");

    if (confirmed) {
      yield* props.onPress(event);
    }
  });

  return <button onClick={wrapped}>Save</button>;
}
```

The wrapper accumulates the effects of `confirmOperation` and `props.onPress`.

Ordinary callbacks remain compatible for transparent forwarding. Invoking an arbitrary ordinary callback from a strict block is unsafe because it may hide reads, writes, async work, or errors.

## Pending JSX Reads

JSX does not suspend a generator across a Promise.

```tsx
const View = $(function* () {
  return <div>{(yield* user).name}</div>;
});
```

If `user` is ready:

```text
driver reads user
→ generator receives User
→ JSX completes
```

If `user` is pending:

```text
driver reads user
→ signal reports pending
→ block execution stops
→ Loading handles pending state
→ signal resolves
→ block reruns from the beginning
```

This matches Solid’s reactive execution model and avoids retaining generator stacks during rendering.

## Event Pending Reads

Events behave differently:

```ts
const submit = $(function* () {
  const session = yield* sessionSignal;
  const result = yield* submitForm(session);
  yield* write(lastResult, result);
});
```

If `sessionSignal` is pending, the event execution can pause until it becomes ready.

Async continuations must resume under the owner and boundary captured when the event reached the DOM.

## Loading And Error Boundaries

A block carries derived async and error information.

```ts
const view = $(function* () {
  return <UserCard user={yield* userSignal} />;
});
```

If `userSignal` is `AsyncSignal<User, NetworkError>`, then `view` is effectively:

```ts
Block<
  JSX.Element,
  {
    async: true;
    errors: NetworkError;
  }
>;
```

### Loading

`Loading` consumes the pending effect:

```ts
const loaded = Loading(view, () => <Spinner />);
```

The returned block has:

```text
Async: false
Errors: NetworkError
```

### Errored

`Errored` handles selected errors:

```ts
const safe = Errored(
  loaded,
  handle(NotFoundError, () => <NotFound />)
);
```

The result carries:

```ts
Exclude<OriginalErrors, NotFoundError>;
```

Unmatched errors must be rethrown to the next boundary.

Fallback blocks can introduce their own dependencies, async state, and errors.

### JSX Type Erasure

TypeScript often reduces JSX component expressions to the global `JSX.Element`, losing generic return metadata.

Function-style composition is therefore the safer initial API:

```ts
const safe = Errored(Loading(view, Spinner), handle(NotFoundError, NotFound));
```

Typed `<Loading>` and `<Errored>` syntax may require compiler support or changes to Solid’s JSX types.

## TypeScript Host Enforcement

TypeScript does not have to classify the block when `$()` is called. It records all effect categories.

Hosts constrain the block later:

```ts
type ReactiveBlock = Block<any, any, any, any, never, any>;
```

```ts
type JSXBlock = Block<JSX.Element, any, never, never, never, void>;
```

```ts
type EventBlock<Event> = Block<any, any, any, any, any, Event>;
```

A JSX block that directly starts a task is not assignable to `JSX.Element`.

A reactive block containing writes is not accepted by `createMemo`.

An event block accepts every effect category.

## Direct Store And Prop Paths

Strict blocks support direct typed property reads without a user-facing lens, property wrapper, `readProp`, or selector helper:

```tsx
const name = yield * store.user.name;
const first = yield * store.items[0].name;
const current = yield * store.items[index];
const count = yield * store.items.length;
const label = yield * props.label;
```

### Path Types

Each direct read records its root and path:

```ts
StoreRead<typeof store, readonly ["user", "name"]>;
StoreRead<typeof store, readonly ["items", number]>;
PropRead<typeof props, readonly ["label"]>;
```

`PathValue<Root, Path>` walks the path to infer the selected value. `PathResult<Root, Path>` additionally reads through a signal accessor or block stored at the selected path, matching the value behavior of `yield*`. Async and error coloring carried by that readable value propagates transitively.

The static path supports property names, numeric indices, tuple positions, array `length`, index signatures, and simple dynamic identifier keys. A path is compile-time capability metadata; the actual store nodes and mounted prop instance remain runtime identities.

### Store Runtime

During runtime generator execution, the store proxy returns a deferred path token while strict block scope is active:

```text
store.user      -> token(root, ["user"])
.user.name      -> token(root, ["user", "name"])
yield*          -> StoreRead(root, path)
driver           -> tracked walk through the real store proxy
```

The tracked re-walk uses the existing store machinery, which remains authoritative for exact property, structural, index, dynamic-key, alias, and shared-reference behavior. Outside a strict block, the same store proxy returns ordinary values.

A token used as an ordinary value throws `[DIRECT_READ_IN_BLOCK]`. A token created but never yielded throws `[UNREAD_PATH]`. Aliases can extend a token:

```ts
const user = store.user;
const name = yield * user.name;
```

Destructuring resolves ordinary values rather than retaining a path token and should not be used to express a typed path read.

### Compiler Lowering

The generator transform runs before JSX lowering and rewrites supported paths approximately as:

```js
_$perform(_$readPath(store, ["user", "name"]));
_$perform(_$readPath(store, ["items", index, "name"]));
_$perform(_$readProp(props, ["label"]));
```

Bare identifiers retain their existing signal-accessor or block-delegation meaning. Member paths read the value at the path; explicit block invocation remains `call(block, input)`.

Props are ordinary compiler-emitted getter objects rather than store proxies. Direct prop paths therefore require compiler lowering; the lowered `readProp` operation invokes the real getter under permitted read scope so Solid tracks its exact underlying signals or stores.

### Projected Typechecking

Stock TypeScript checks the authored operand before Solid's runtime transform, so it cannot infer that a plain string or number is a path operation. The prototype adds `@solidjs/typecheck` and the `solid-tsc` CLI.

For typechecking only, `projectBlocksForTypecheck` inserts an operation with the authored expression retained as a witness:

```ts
yield * __solid_readPath(store, ["items", index, "name"], store.items[index].name);
yield * __solid_readProp(props, ["count"], props.count);
```

This provides root/path metadata and selected-value inference while mapping diagnostics back to the authored source location. Declaration emit contains ordinary public `StoreRead` and `PropRead` types, so downstream consumers can compile separately with stock TypeScript.

Current tooling limitations:

- Editors still diagnose authored direct paths because no language-service plugin ships yet; `solid-tsc` is the source of truth.
- `solid-tsc --build` and watch mode are not implemented.
- Optional chains, method calls, complex computed expressions, and paths rooted in `splitProps` or `mergeProps` results are conservatively refused by projection/lowering.
- Unsupported forms remain errors or runtime fallbacks in compat experiments; strict production mode must reject them at build time.

### Structural Store Reads

Direct paths intentionally cover property paths, not arbitrary collection programs. `readStore(store, selector)` remains for structural operations:

```tsx
const names = yield * readStore(store, state => state.items.map(item => item.name));
const visible = yield * readStore(store, state => state.items.filter(matchesFilter));
```

The selector executes once under permitted read scope, and the existing proxy records the exact runtime properties and structure it touches. Its type metadata records the store root and inferred result rather than a fabricated static path for arbitrary JavaScript.

### Block-Derived Stores

Function-form stores and projections accept no-write blocks and preserve their metadata:

```ts
const projected = createProjection(
  $(function* (draft: State) {
    draft.name = yield* sourceStore.name;
  }),
  seed
);

const [writable, setWritable] = createStore(block, seed);
const [optimistic, setOptimistic] = createOptimisticStore(block, seed);
```

`BlockStore<B, T>` is an ordinary projection proxy intersected with phantom `BlockMetadata<B>`; no runtime metadata property is added. Reading it through a direct path or `readStore` carries its source block's async/error metadata transitively. Blocks containing `Writes` are rejected by these reactive hosts.

### Store Writes

Store writes remain explicit event operations:

```ts
const addItem = $(function* () {
  yield* write(setStore, draft => {
    draft.items.push(item);
  });
});
```

Reactive and JSX hosts reject this block because its `Writes` category is non-empty. Store setters do not become context-sensitive.

## Strictness And Interoperability

Completely forbidding ordinary JavaScript would make interoperation expensive. Blocks should carry an effect-precision level:

```ts
type Precision = "exact" | "dynamic" | "unknown";
```

### Exact

All effects use typed operations:

```ts
const value = yield * signal;
const result = yield * task;
yield * write(target, result);
```

TypeScript and the compiler know the complete declared effect set.

### Dynamic

The compiler or runtime recognizes direct operations:

```ts
signal();
setSignal(value);
await promise;
throw error;
```

The runtime can preserve behavior, but TypeScript may not infer the complete effect set.

### Unknown

Arbitrary upstream code may contain hidden effects:

```ts
legacyFunction();
```

The runtime remains correct by falling back to ordinary tracking, but exhaustive guarantees and static optimizations are unavailable.

### Compiler Modes

The implementation currently exposes several independent switches to explore the design space: runtime versus transformed execution, warning and guard levels, optimization flags, and individual feature experiments. These are development controls, not the proposed production API.

The production proposal has only two modes:

```ts
solid({
  mode: "compat" | "strict"
});
```

#### Compat

Compat mode supports incremental adoption and external JavaScript:

- Supported `$` blocks may still be transformed for performance.
- Generator blocks that cannot be transformed use the runtime driver and operation fallbacks.
- Ordinary Solid accessors, callbacks, components, and untyped libraries remain valid.
- Unknown modules and dynamic imports force conservative runtime feature inclusion.
- Development diagnostics may report lost effect precision without making the build fail.

Compat guarantees correct behavior, not complete effect knowledge or the smallest possible runtime.

#### Strict

Strict mode is a whole-application contract, not a per-file lint level:

- Every reactive or effectful application boundary must use typed generator blocks with strict host and read/write rules.
- All application modules, route chunks, workers, and participating libraries must be compiled in strict mode or provide a trusted strict capability manifest.
- Unsupported generator forms, hidden effects, ordinary reactive reads inside blocks, unknown effectful callbacks, and unclassified dynamic imports are build errors.
- Runtime generator fallback is not shipped. A block that cannot be lowered fails the build instead of deoptimizing.
- Client and server graphs are checked and specialized independently.
- Development builds verify compiler claims and fail loudly on metadata or capability mismatches.

With the complete application graph proven strict, Solid automatically selects specialized block hosts and runtime entry points, removes unused interpreters and feature modules, and applies safe application-code splitting. Strict mode produces the fastest and smallest build available for that application's proven capabilities without requiring users to configure individual optimization flags.

Libraries that cannot satisfy the strict contract require compat mode; strict mode does not silently place them behind a fallback boundary.

### Legacy Adapters

Existing upstream code should be adapted at its boundary rather than rewritten completely:

```ts
const loadUser = task(legacyLoadUser, {
  errors: [NetworkError]
});
```

Unknown calls can be explicit:

```ts
yield * unsafeCall(legacyFunction);
```

Unknown effects remain in the block’s type. `Errored` cannot claim that every error was handled while `unknown` remains.

## Runtime Mode

Runtime mode is an implementation path used by compat mode and by experiments; it is not a separate production mode. It requires no `$` transform.

Signals implement an iterator:

```ts
signal[Symbol.iterator]();
```

The iterator yields a typed read operation and returns the signal’s value.

The `$` driver:

- Executes the generator
- Resolves yielded signal reads
- Tracks dependencies
- Handles typed tasks
- Routes errors
- Processes writes in event blocks
- Preserves ownership
- Cancels stale async work
- Validates host capabilities in development

Ordinary accessor calls remain supported outside exact `$` blocks.

A development guard can detect direct reads inside strict blocks. Loose blocks permit them and fall back to normal runtime tracking.

## Transform Mode

Transform mode is an implementation path used by both production modes. It removes generator overhead while preserving behavior. Compat may fall back when lowering is unsafe; strict mode rejects the same block at build time.

```ts
$(function* () {
  const count = yield* countSignal;
  return count * 2;
});
```

becomes approximately:

```ts
$compiled(() => {
  const count = countSignal();
  return count * 2;
});
```

The block brand remains because hosts still need:

- Ownership
- Error routing
- Pending behavior
- Event policy
- Effect metadata

The transform must run before JSX lowering:

```tsx
$(function* () {
  return <div>{yield* count}</div>;
});
```

becomes ordinary fine-grained Solid JSX:

```tsx
$compiled(() => {
  return <div>{count()}</div>;
});
```

The JSX compiler can then generate normal insertion effects.

### Safe Transform Restrictions

A first transform should only lower operations it can identify safely.

Unsupported delegation, unknown calls, computed access, or unusual generator control flow should remain on the runtime path rather than being partially transformed.

Runtime and transformed behavior must be tested for equivalence.

## Optimize Mode

Optimize mode is currently an experimental switch. In the production proposal, its proven optimizations are selected automatically by strict mode rather than exposed as a third public mode. It may eventually use static effect and dependency information for deeper specialization.

The central correctness distinction is:

```text
Exact dependencies
Candidate dependencies
Conditional dependencies
Dynamic or unknown dependencies
```

A dependency appearing under a branch is not necessarily active on every execution.

Static metadata must not replace Solid’s dynamic tracking unless the dependency set is proven exact.

## Required Performance Measurements

Performance claims for `$` require three separate measurements. They must not be collapsed into one transformed-demo result.

### Runtime Fallback Overhead

Measure `$` with generator transformation completely disabled against equivalent idiomatic Solid code. This establishes the cost and viability of the runtime fallback rather than treating it only as a correctness path.

Required cases:

- Block creation and first execution.
- Steady-state updates with one read, multiple reads, conditional reads, and nested block delegation.
- Reactive computations, JSX blocks, and event blocks.
- Synchronous store/prop path reads and selector-based structural store reads.
- Allocation rate, retained memory, and owner/link counts in addition to wall time.
- Development guards measured separately from production runtime behavior.
- Minified and gzipped cost of retaining the generator driver and fallback operations.

Each case must compare hand-written accessors, untransformed `$`, and the same workload after transformation.

### Compiler Transform Overhead

Measure the incremental compile-time cost of enabling the `$` transform, independent of runtime results. Extend the compiler benchmark with identical inputs compiled with and without generator/path lowering.

Required workloads:

- Existing many-small-file fixture corpus.
- Existing approximately 128 KB and 1 MB single-module workloads.
- Synthetic modules with low, representative, and dense `$` block usage.
- Supported blocks, unsupported blocks that must bail out, JSX blocks, event blocks, and direct store/prop paths.
- Cold process startup and warmed in-process throughput.
- Wall time, throughput, peak memory, emitted byte count, and source-map size.
- Pre-typecheck projection and projected TypeScript checking measured separately from runtime-code transformation.

Results must report absolute time and the delta from the same compiler configuration with `$` processing disabled.

### Optimized Runtime Performance

Measure transformed and metadata-specialized `$` against both untransformed `$` and equivalent hand-written Solid output. The optimized path is successful only when it approaches or improves on the hand-written baseline without changing behavior.

Required coverage:

- Signals graph creation, one-to-one updates, fan-out, diamond propagation, and avoidable recomputation.
- DOM mount/clear, full replacement, partial row updates, keyed reverse/shuffle, and dynamic component paths.
- Event dispatch, forwarded/wrapped handlers, first interaction, and repeated interaction.
- Store projection, sparse path updates, structural selectors, and keyed reconciliation.
- Async task, loading, error, cancellation, and transition paths when their features are retained.
- SSR rendering and hydration startup.
- Production bundle size for read-only, event-only, synchronous-only, store-using, and full-feature applications.

The comparison matrix is:

| Variant         | Purpose                                                |
| --------------- | ------------------------------------------------------ |
| Idiomatic Solid | Hand-written performance floor                         |
| Runtime `$`     | Cost of no transformation                              |
| Transformed `$` | Cost after generator removal                           |
| Optimized `$`   | Benefit of metadata specialization and feature pruning |

### Measurement Discipline

- Run production artifacts for runtime and size measurements.
- Use repeated samples, medians, spread/RME, pinned Node/browser versions, machine details, and commit SHA.
- Use the in-repo Vitest/CodSpeed suites for fast regression detection and validate retained optimizations against the relevant Tier-2 suite.
- Run runtime/transform equivalence and correctness suites before accepting a performance result.
- Record regressions as well as wins; an optimization is not retained solely because a synthetic `$` microbenchmark improves.
- Do not enable optimized mode by default until all three measurement groups have reproducible baselines.

## Compiler-Emitted Metadata

Production metadata should be compact, likely a bitfield:

```js
$(compiledBody, flags);
```

Possible flags include:

- Body already lowered
- Has direct tasks
- Has explicit errors
- Has visible writes
- Reads are exact
- Reads are conditional
- Reads are dynamic
- Host is reactive, JSX, or event
- Creates owned nodes
- Metadata schema version

Development builds can emit removable diagnostics metadata:

```js
{
  id: "UserView#3",
  location: "UserView.tsx:12",
  host: "jsx",
  reads: [user, theme],
  tasks: 0,
  errors: [NetworkError],
  writes: []
}
```

Absent or untrusted metadata falls back to normal runtime behavior.

## Runtime Uses Of Metadata

Useful runtime optimizations include:

- Skip generator and iterator probing for lowered blocks.
- Skip generic direct-task handling when safely proven absent.
- Erase pending and error status channels from computations proven synchronous and non-throwing; retain development assertions for violated proofs.
- Select the correct host interpreter immediately.
- Configure event concurrency and ownership.
- Produce source-level diagnostics.
- Compare candidate dependencies against actual reads.
- Deoptimize only the affected block after HMR or mismatch.
- Improve devtools with reads, writes, async work, and errors.

Static dependency arrays are less promising because Solid’s existing stable dependency reconciliation already reuses links without allocation.

## Compile-Time-Only Optimizations

The compiler is best positioned to:

- Remove generators.
- Replace `yield* signal` with direct accessor reads.
- Hoist JSX reads into fine-grained DOM effects.
- Reject illegal host effects.
- Replace generic `perform(signal)` calls with direct access when identity is known.
- Lower event blocks into specialized event execution.
- Remove runtime guards that have been statically proven unnecessary.
- Eliminate unused feature modules from the application runtime.

Whole-program memo fusion and dead reactive-read elimination are dangerous because unused reads can still be semantically meaningful dependencies.

## Compiler And Runtime Cooperation

Promising joint protocols include:

### Hint And Verify

The compiler emits a fast-path flag. Development runtime verifies it.

This follows the same pattern as Solid’s existing synchronous-node checks.

### Candidate Versus Actual Reads

The compiler provides possible reads. Runtime tracks actual reads.

This supports diagnostics such as:

```text
Declared read was conditional and not active.
Read occurred inside an opaque callback.
Read occurred after an async boundary.
```

### Per-Block Deoptimization

A metadata mismatch disables optimization for one block rather than the whole application.

### HMR

Hot replacement clears trusted static flags and returns the block to dynamic tracking until revalidated.

### Event Specialization

Compiler identifies event blocks. Runtime supplies:

- Ownership
- Cancellation
- Concurrency
- Error routing, including direct boundary coordinates for resumable handlers
- Batched writes

## Bundle-Size Specialization

If the compiler proves an application contains no async behavior, the bundle should be able to exclude async runtime support.

Potential removable functionality includes:

- Promise and AsyncIterable handling
- Pending-source bookkeeping
- `NotReadyError` handling
- Async status propagation
- Loading boundaries
- Stale-flight cancellation
- Async helpers such as `isPending`, `latest`, and `resolve`
- Async transition scheduling

Per-block flags alone cannot tree-shake this code. Solid needs tree-shakeable runtime modules or build-time feature constants. Within a full runtime, proven synchronous/non-throwing nodes should also use a status-free recomputation path so normal creation and updates do not pay pending/error bookkeeping costs. This does not bypass dependency propagation for nodes that can actually suspend or fail.

Possible runtime modules:

```text
@solidjs/signals/core
@solidjs/signals/async
@solidjs/signals/events
@solidjs/signals/transitions
```

The compiler or bundler can produce an application capability manifest:

```js
{
  async: false,
  errors: true,
  events: true,
  writes: true,
  transitions: false
}
```

Server and client bundles should be analyzed independently.

Unknown blocks, third-party libraries, dynamic imports, or normal callbacks returning Promises force conservative inclusion of async support.

Development builds should throw when an application violates an asserted feature set.

## Optimizations Probably Not Worthwhile

The Fable investigation recommends against:

- Pre-linking graph edges
- Production dependency arrays
- Compile-time graph heights
- Static error-boundary masks
- Runtime registration manifests
- Alternate lightweight graph-node shapes
- Replacing linked dependencies with indexed arrays
- Compile-time memo fusion
- Dead reactive-read elimination
- Skipping pending checks solely because a block has no direct task

Most of these conflict with runtime instance state, dynamic dependencies, tree shaking, or Solid’s existing efficient graph.

## Broader Opportunities

The typed block model may enable:

- Exhaustive loading and error boundaries
- Structured concurrency and cancellation
- Parallel, queued, latest, and exhaust event policies
- Transactional writes
- Optimistic updates
- Typed recovery
- SSR streaming manifests
- Better hydration and preloading
- Server/client capability enforcement
- Worker execution for pure blocks
- Deterministic tests with injected effects
- Time-travel and replay
- Dependency and error graph visualization
- Precise performance attribution
- Scheduling priorities
- Typed library contracts
- Route-level effect manifests
- Automatic runtime feature selection

The larger model is similar to algebraic effects: `$` blocks declare operations, and Solid hosts interpret them differently.

## Major Risks And Open Questions

- TypeScript does not track thrown exceptions natively.
- Arbitrary functions may hide reads, writes, Promises, and errors.
- JSX may erase generic block return types.
- Direct prop/store paths require projected typechecking; editor language-service support is still missing.
- Static root/path metadata cannot prove runtime aliases, shared-reference identity, or serializability.
- JSX-block hydration-id parity is fixed for hydratable native-compiler builds. Babel-JSX mode and `generators: false` still carry the original drift.
- Direct reads after native `await` cannot safely use global tracking.
- Event errors occur after render and require captured boundary routing.
- Event concurrency needs explicit defaults.
- Async signal creation needs a precise typed source API.
- Separate compilation limits whole-program guarantees.
- Dynamic imports complicate runtime feature removal.
- Compiler metadata and TypeScript metadata can disagree.
- HMR must invalidate trusted optimization flags.
- Strict mode needs good diagnostics and escape hatches.
- Runtime mode and transform mode must remain behaviorally identical.
- Replacing actions entirely requires matching their transaction and cancellation semantics.

## Prototype 1: Compiler Host Fusion and Block Erasure

### Design

When a typed `$()` block is consumed by a statically known host
(`createMemo`, `createEffect`, `createRenderEffect`), the compiler erases the
`$()` wrapper and replaces every `_$perform(accessor)` call with a direct
`accessor()` invocation. Path reads (`_$readPath`, `_$readProp`) are erased to
member expressions (e.g. `store.user.name`, `props.count`).

**Safety invariant:** without the `$` block wrapper the block guard is never
raised, so `readGuarded` is a no-op and `_$perform(x)` === `x()`. Path tokens
are never created because store proxies return normal values when no guard is
active. The fusion pass only fires when every `_$perform` argument in the
function body is "fully erasable" — identifiers, non-optional member
expressions, or `_$readPath`/`_$readProp` calls with an identifier root and
string/number/identifier literal keys. It bails when the body contains
`readStore`, `raise`, `attempt`, `write`, `call`, or any other non-trivial
perform argument.

The pass runs **after** the generator transform and **before** JSX lowering.

### Implementation

Behind the `hostFusion: true` compiler option (default `false`). Requires
`generators: true`.

**Changed files:**
- `packages/compiler/src/generators.rs` — `fuse_host_blocks()` pass (~250 lines), 6 unit tests (3 positive, 3 negative)
- `packages/compiler/src/compiler.rs` — `host_fusion` option in `CompileOptions`, fusion pass call site
- `packages/compiler/src/config.rs` — `host_fusion: Option<bool>` in NAPI `TransformOptions`
- `packages/compiler/src/node_adapter.rs` — `host_fusion` plumbed in `core_options()`
- `packages/compiler/src/shared/ast.rs` — `argument_to_expression()` helper
- `packages/compiler/types.d.ts` — `hostFusion?: boolean` in TypeScript types
- `packages/compiler/index.js` — `hostFusion` added to `nativeOptionKeys`
- `packages/compiler/__tests__/generators-fixtures.test.js` — 5 fusion contract tests
- `packages/compiler/__tests__/generators/fixtures/fusion-memo-effect/` — fusion fixture
- `packages/compiler/__tests__/generators/fixtures/fusion-paths/` — path-read fusion fixture
- `packages/compiler/__tests__/generators/fixtures/fusion-bail-standalone/` — negative fixture

### Test Results

**Rust unit tests:** 72 passed, 0 failed (15 generator tests including 6 new fusion tests)
```
cargo +1.97.1 test -- --test-threads=1
```

**JS fixture tests:** 5823 passed, 0 failed, 28 skipped (40 test files)
```
npx vitest run
```

**Fusion-specific contract tests (5):**
- erases `$()` wrapper and perform calls when consumed by createMemo/createEffect
- erases path reads to member expressions
- does NOT fuse standalone blocks (no known host)
- is off by default even when generators are on
- produces strictly smaller output than non-fused for the same input

### Measurements

**Environment:** macOS Darwin 25.5.0, Rust 1.97.1, Node.js v24.18.0

#### Emitted output size (unminified)

| Fixture | Without fusion | With fusion | Savings |
|---------|---------------|-------------|---------|
| memo-effect (3 blocks: createMemo×2 + createEffect×1) | 742 bytes | 688 bytes | 54 bytes (7.3%) |
| paths (2 blocks: createMemo with readPath + readProp) | 363 bytes | 298 bytes | 65 bytes (17.9%) |

#### Code-body parity with handwritten Solid

Function bodies are **identical** to handwritten Solid (verified line-by-line).
The only remaining overhead is unused import specifiers (`$`, `perform as
_$perform`, `readPath as _$readPath`, `readProp as _$readProp`) left behind
because the fusion pass does not yet clean up the import declaration. These are
eliminated by bundler tree-shaking/dead-code elimination.

#### Runtime overhead erasure

Per fused block, the following runtime operations are eliminated at compile time:
- 1× `$(fn)` call → `fn` (no block allocation, no `createComputation` overhead in `$`)
- N× `_$perform(accessor)` → `accessor()` (no `readGuarded` call, no guard check)
- M× `_$readPath(root, keys)` → `root.key1.key2...` (no path-token allocation)
- M× `_$readProp(props, keys)` → `props.key` (no prop-token allocation)
- 0× `renderBlock`/`isBlock` check at host insertion (the value is a plain function, not a block)

### Known Limitations

1. **Unused import specifiers remain.** The fusion pass does not strip `$`,
   `perform`, `readPath`, `readProp` from the import declaration when all their
   call-site usages are erased. A follow-up could add an import-cleanup
   sub-pass; in practice bundlers handle this.

2. **JSX host fusion not attempted.** JSX children that are `$()` blocks go
   through `renderBlock` detection at insert time. Fusing those requires
   coordinating with the JSX transform's template-creation logic and is scoped
   for a later prototype.

3. **JSX `$` hydration-ID parity is already known broken.** This prototype does
   not conceal or paper over that issue.

### Decision

**KEEP** — prototype 1 demonstrates the core value proposition:

- The fused output is **identical** to handwritten Solid (ignoring import
  specifiers that tree-shaking removes).
- The pass is safe: it only fires when the entire block body is provably
  erasable, and bails conservatively on any non-trivial construct.
- The implementation is ~250 lines of Rust, gated behind an off-by-default
  flag, with zero impact on existing behavior.
- Output size reduction is 7–18% per fused block depending on path-read density.
- Runtime overhead (block allocation, guard checks, path-token allocation) is
  fully eliminated for fused blocks.
