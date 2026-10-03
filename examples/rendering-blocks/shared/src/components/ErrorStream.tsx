import {
  $component,
  $event,
  $memo,
  $signal,
  $snapshot,
  attempt,
  Errored,
  Loading,
  type BlockSetter,
  type Source,
  type TypedProps
} from "@solidjs/blocks";

interface Item {
  title: string;
}

function loadItem(id: string): Promise<Item> {
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      if (id !== "1") {
        reject(new Error(`Item ${id} not found`));
        return;
      }

      resolve({ title: "Test Item" });
    }, 1500);
  });
}

/**
 * One item: its id is its own state, seeded from the prop (`$snapshot`), and
 * the load is an `attempt` that declares its failure (`Error`), so the
 * boundaries' types know what they handle.
 */
function* item(props: TypedProps<{ id: string }>) {
  const [id, setId] = yield* $signal(yield* $snapshot(props.id));
  const item = yield* $memo(function* () {
    const current = yield* id;
    return yield* attempt(
      () => loadItem(current),
      cause => (cause instanceof Error ? cause : new Error(String(cause)))
    );
  });
  return { item, setId };
}

const Title = $component(function* Title(
  props: TypedProps<{ item: Source<Item, true, Error> }, "Title">
) {
  return function* () {
    return <div>{yield* props.item.title}</div>;
  };
});

function fallback(setId: BlockSetter<string>) {
  return (error: () => Error, reset: () => void) => {
    const retry = $event(function* () {
      yield* setId("1");
      reset();
    });
    return (
      <div>
        <div>ItemError: {String(error())}</div>
        <button onClick={retry}>Reset to valid item</button>
      </div>
    );
  };
}

// A boundary tag hands on nothing it does not handle: the inner boundary of
// each pair is a call whose content is built inside it.
const InnerBoundaryItem = $component(function* InnerBoundaryItem(
  props: TypedProps<{ id: string }, "InnerBoundaryItem">
) {
  const { item: loaded, setId } = yield* item(props);
  return function* () {
    return (
      <Loading fallback={<div>Item Loading...</div>}>
        {Errored({ fallback: fallback(setId), children: () => Title({ item: loaded }) })}
      </Loading>
    );
  };
});

const OuterBoundaryItem = $component(function* OuterBoundaryItem(
  props: TypedProps<{ id: string }, "OuterBoundaryItem">
) {
  const { item: loaded, setId } = yield* item(props);
  return function* () {
    return (
      <Errored fallback={fallback(setId)}>
        {Loading({
          fallback: <div>Item Loading...</div>,
          children: () => Title({ item: loaded })
        })}
      </Errored>
    );
  };
});

const ErrorStream = $component(function* ErrorStream() {
  return function* () {
    return (
      <>
        <h1>Loading + Errored Streaming</h1>
        <p>
          Reproduces both boundary shapes for streamed SSR + hydration, with reset buttons to
          confirm recovery after hydration.
        </p>
        <h2>Errored inside Loading</h2>
        <div>
          <InnerBoundaryItem id="1" />
          <InnerBoundaryItem id="bad-item" />
        </div>
        <h2>Errored outside Loading</h2>
        <div>
          <OuterBoundaryItem id="1" />
          <OuterBoundaryItem id="bad-item" />
        </div>
      </>
    );
  };
});

export default ErrorStream;
