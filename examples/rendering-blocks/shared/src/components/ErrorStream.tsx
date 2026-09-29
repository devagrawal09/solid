// v2 twin note: kept plain (the original file). As `$component`s — the page,
// and/or its boundary items — the streamed SSR page hydrates with an uncaught
// "Item bad-item not found" page error and a DOM that differs from the
// original's (a whitespace text node between the outer items is missing); the
// CSR and string builds are fine. See the README.
import { createMemo, createSignal, Errored, Loading } from "solid-js";

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

function InnerBoundaryItem(props: { id: string }) {
  const [id, setId] = createSignal(props.id);
  const item = createMemo<Item>(async () => loadItem(id()));

  return (
    <Loading fallback={<div>Item Loading...</div>}>
      <Errored
        fallback={(error, reset) => (
          <div>
            <div>ItemError: {String(error())}</div>
            <button
              onClick={() => {
                setId("1");
                reset();
              }}
            >
              Reset to valid item
            </button>
          </div>
        )}
      >
        <div>{item().title}</div>
      </Errored>
    </Loading>
  );
}

function OuterBoundaryItem(props: { id: string }) {
  const [id, setId] = createSignal(props.id);
  const item = createMemo<Item>(async () => loadItem(id()));

  return (
    <Errored
      fallback={(error, reset) => (
        <div>
          <div>ItemError: {String(error())}</div>
          <button
            onClick={() => {
              setId("1");
              reset();
            }}
          >
            Reset to valid item
          </button>
        </div>
      )}
    >
      <Loading fallback={<div>Item Loading...</div>}>
        <div>{item().title}</div>
      </Loading>
    </Errored>
  );
}

const ErrorStream = () => {
  return (
    <>
      <h1>Loading + Errored Streaming</h1>
      <p>
        Reproduces both boundary shapes for streamed SSR + hydration, with reset buttons to confirm
        recovery after hydration.
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

export default ErrorStream;
