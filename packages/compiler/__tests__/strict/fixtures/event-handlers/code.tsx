import { $, createSignal, createStore } from "solid-js";

export function Form(props: { onSaved: (id: string) => void }) {
  const [count, setCount] = createSignal(0);
  const [store, setStore] = createStore({ draft: "", saved: [] as string[] });

  // Event hosts are untracked: reads are recorded, never dependencies.
  // Writes and unknown helpers with plain arguments are fine.
  const increment = $(() => setCount(value => value + 1));

  // An async handler: writes after `await` are ordinary handler behavior.
  const save = $(async (event: SubmitEvent & { currentTarget: HTMLFormElement }) => {
    event.preventDefault();
    const draft = store.draft;
    const id = await persist(draft, count());
    setStore(state => {
      state.saved.push(id);
    });
    props.onSaved(id);
  });

  return (
    <form onSubmit={save}>
      <input
        value={store.draft}
        onInput={$((e: InputEvent & { currentTarget: HTMLInputElement }) =>
          setStore(state => {
            state.draft = e.currentTarget.value;
          })
        )}
      />
      <button type="button" onClick={increment} on:reset={$(() => setCount(0))}>
        {count()}
      </button>
      <button type="button" onClick={increment}>
        again
      </button>
    </form>
  );
}

declare function persist(draft: string, count: number): Promise<string>;
