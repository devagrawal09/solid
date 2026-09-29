import { $component, $event, $signal, createUniqueId } from "solid-js";
import { eager } from "../eager";
import { Portal } from "@solidjs/web";

const Settings = $component(function* () {
  const [text, setText] = yield* $signal("Hi");
  const [modalOpen, setModalOpen] = yield* $signal(true);
  const [modalClicks, setModalClicks] = yield* $signal(0);
  const id = createUniqueId();

  const count = $event(function* () {
    if (yield* modalOpen) yield* setModalClicks(c => c + 1);
  });
  const write = $event(function* (e: InputEvent & { currentTarget: HTMLInputElement }) {
    yield* setText(e.currentTarget.value);
  });
  const open = $event(function* () {
    yield* setModalOpen(true);
  });
  const close = $event(function* () {
    yield* setModalOpen(false);
  });

  return function* () {
    return (
      <section onClick={count}>
        <h1>Settings</h1>
        <p>All that configuration you never really ever want to look at.</p>
        <label for={id}>Write:</label>
        <input type="text" id={id} value={yield* text} onInput={write} />
        <p>{yield* text}</p>
        <button type="button" onClick={open}>
          Open body portal
        </button>
        <p>Portal logical clicks: {yield* modalClicks}</p>
        {(yield* modalOpen) && (
          <Portal>
            <div class="modal-backdrop">
              <div class="modal-card" role="dialog" aria-modal="true" aria-label="Settings portal">
                <h2>Body Portal</h2>
                <p>This modal is portaled to document.body.</p>
                <button type="button" onClick={close}>
                  Close portal
                </button>
              </div>
            </div>
          </Portal>
        )}
      </section>
    );
  };
});

// Loaded with lazy(): see ../eager.ts.
export default eager(Settings);
