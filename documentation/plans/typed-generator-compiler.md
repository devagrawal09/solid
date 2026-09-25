# `$()` Typed Reactive Blocks

## Core Goal

Build `$()` into Solid as a typed effect boundary for reactive code.

```tsx
function Component(props) {
  return $(function* () {
    return <div>{(yield* props.user).name}</div>;
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
    return (
      <article>
        <h1>{(yield* props.user).name}</h1>
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

## Stores

Stores use property access rather than callable accessors. A property such as `store.user.name` evaluates to a plain value before `yield*` can observe it, so the initial integration uses one explicit read operation and the existing store proxy:

```tsx
function UserView(props) {
  return $(function* () {
    return <div>{yield* readStore(props.store, state => state.user.name)}</div>;
  });
}
```

`readStore(store, selector)`:

- Is a normal read operation and is therefore valid in reactive, JSX, and event blocks.
- Runs `selector` in the block's permitted read scope.
- Uses the existing store proxy and per-property nodes for exact runtime tracking.
- Infers the selector result type.
- Records the store root in the block's `Reads` category.
- Does not change normal store behavior outside `$`.

Arrays use the same operation:

```tsx
return $(function* () {
  return <ul>{yield* readStore(store, state => state.items.map(item => <li>{item.name}</li>))}</ul>;
});
```

The selector may perform nested, indexed, structural, or dynamic reads. The runtime proxy remains authoritative for the actual property nodes read on each execution.

Store writes use the existing event-only write operation and ordinary store setter:

```ts
const addItem = $(function* () {
  yield* write(setStore, draft => {
    draft.items.push(item);
  });
});
```

Reactive and JSX hosts reject this block because its `Writes` category is non-empty. Store setters do not become context-sensitive.

### Store Transform

For a supported selector, transform mode lowers:

```ts
yield * readStore(store, state => state.user.name);
```

to an ordinary selector invocation or equivalent direct property access:

```ts
store.user.name;
```

Unsupported selector forms remain on the runtime path rather than being partially lowered.

### Store TypeScript Limits

The initial type model tracks the store root and selected value type, not the complete property path. Runtime tracking remains exact.

TypeScript can represent a static path tuple such as `["users", number, "name"]`, but it cannot safely make ordinary store properties contextually yieldable only inside `$`. Permanently branding every property as yieldable would allow plain values to escape and later be incorrectly accepted by `yield*`.

TypeScript also cannot automatically assign a fresh nominal identity to every `createStore()` call or prove that two paths currently reference the same raw object. Shared references, aliases, dynamic indices, and actual store-node identity remain runtime concerns.

Potential later work includes compiler-emitted path metadata, a TypeScript language-service plugin, or an opt-in path view. The first version intentionally does not add lenses or context-sensitive store proxy values.

### Wrapper-Free Store Alternative

A future strict mode could support direct store syntax without `readStore`:

```tsx
return $(function* () {
  return <div>{yield* store.user.name}</div>;
});
```

While the runtime driver advances a `$` generator, it can mark the block as active. The existing store proxy can observe that state and return a deferred path reference instead of immediately returning the property value:

```text
store.user      -> path ["user"]
.user.name      -> path ["user", "name"]
yield*          -> StoreRead operation
driver           -> reads the real value through the normal store proxy
```

Outside `$`, the same proxy continues returning ordinary values. Transform mode lowers the expression directly to `store.user.name`.

Arrays can use the same path behavior for indices and `length`:

```tsx
yield * store.items[0].name;
yield * store.items.length;
yield * store.items[index];
```

For methods or iteration, the collection is yielded before normal array operations:

```tsx
(yield * store.items).map(item => <li>{item.name}</li>);
```

The path reference owns the effect iterator, so it does not replace the real array's `Symbol.iterator`. After resolution, the value is the ordinary store array proxy and normal `map`, spread, and `for...of` behavior remains available.

This design has important costs:

- A proxy can detect an active `$` execution but cannot know whether a property access is syntactically the operand of `yield*`.
- Ordinary store reads inside the generator would also produce deferred references and must be diagnosed if they are not consumed.
- TypeScript cannot contextually change a property's type only inside `$`. Recursive value-and-path intersection types allow values to escape with a yieldable type even though the escaped runtime primitive is not yieldable.
- Native `await` cannot keep a browser-global active scope set safely; the driver must restore scope around each controlled continuation.
- Array methods, getters, destructuring, optional chains, computed keys, and values passed through opaque functions require explicit semantics and conservative fallback.

The wrapper-free form is therefore plausible as compiler-checked strict syntax, but it is not the initial runtime contract. `readStore(store, selector)` remains the small, sound implementation that works without contextual TypeScript behavior.

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

```ts
solid({
  effects: "strict" | "warn" | "loose"
});
```

`strict` rejects effects that cannot be represented precisely.

`warn` allows them but reports lost precision.

`loose` preserves ordinary JavaScript behavior and uses runtime tracking.

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

Runtime mode requires no `$` transform.

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

Transform mode removes generator overhead while preserving behavior.

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

Optimize mode may eventually use static effect and dependency information for deeper specialization.

The central correctness distinction is:

```text
Exact dependencies
Candidate dependencies
Conditional dependencies
Dynamic or unknown dependencies
```

A dependency appearing under a branch is not necessarily active on every execution.

Static metadata must not replace Solid’s dynamic tracking unless the dependency set is proven exact.

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
- Error routing
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

Per-block flags alone cannot tree-shake this code. Solid needs tree-shakeable runtime modules or build-time feature constants.

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
- Solid props and stores use property reads rather than accessor calls.
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

## Current Prototype Status

The original `packages/solid-typed` experiment established iterable typed signals and transitive metadata. The active prototype now integrates the model into core packages.

### Implemented Runtime And Types

- `@solidjs/signals` exports `$`, typed blocks, signal iterators, read/task/failure/write operations, composition helpers, and function-style loading/error handlers.
- A block carries separate `Reads`, `Tasks`, `Failures`, `Writes`, and `Input` categories. Derived async and error totals include metadata inherited from read accessors.
- Block delegation preserves and accumulates transitive categories.
- `createMemo`, computed `createSignal`, and effect compute functions accept blocks but structurally reject writes.
- JSX accepts only zero-input blocks whose direct tasks, failures, and writes are `never`. Reads remain unrestricted, including reads of async/error-colored accessors.
- JSX insertion executes blocks through the render host and rejects disallowed operations at runtime.
- DOM event props accept event blocks. Direct and delegated event paths dispatch them at the final DOM sink.
- Event blocks preserve their creation owner through prop forwarding and route synchronous or asynchronous failures to the captured error boundary.
- `write(setter, value)` supplies the typed write operation. Raw setters remain ordinary functions and are not context-sensitive.
- Undeclared failures from arbitrary callbacks remain `unknown`; the prototype does not claim checked exceptions for unrestricted JavaScript.

### Implemented Compiler Work

- The Rust compiler recognizes imported `$` blocks and lowers a conservative generator subset before JSX lowering.
- Supported reads and operations lower through `perform` while preserving the block brand and runtime fallback.
- Host and syntax diagnostics cover plain yield, async generators, direct throw, invalid JSX operations, and JSX yields that cannot be lowered safely.
- Unsupported blocks remain on the runtime generator path rather than being partially transformed.
- Compiler fixtures cover signal reads, JSX reads, operations, aliases, shadowing, unsupported delegation, and disabled transformation.

### Verification

The completed host-context pass reported green focused suites across signals, Solid, web, compiler, server, and type tests. Coverage includes inline JSX reads, transitive async/error metadata, JSX host rejection, reactive write rejection, event forwarding, wrapped event composition, direct and delegated DOM dispatch, error routing, and runtime/transform equivalence.

### Store Work

The minimal `readStore(store, selector)` integration is currently being implemented and tested. Its scope is the store model documented above: root-level type metadata, selector result inference, existing-proxy runtime tracking, event writes through `write`, and conservative transform lowering. Full static path identities, lenses, and shared-reference analysis are explicitly deferred.

The current worktree remains experimental and uncommitted. Public naming, compatibility policy, runtime-size impact, and final guarantees still require review after the store pass and independent verification.
