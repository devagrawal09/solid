import { $component, $event, $signal, type Element, type TypedProps } from "@solidjs/blocks";

// A comment's collapse toggle: its own state (a `$signal`), its handler an
// `$event`.
const Toggle = $component(function* Toggle(props: TypedProps<{ children: Element }, "Toggle">) {
  const [open, setOpen] = yield* $signal(true);
  const toggle = $event(function* () {
    setOpen(o => !o);
  });
  return function* () {
    return (
      <>
        <div class={["toggle", { open: yield* open }]}>
          <a onClick={toggle}>{(yield* open) ? "[-]" : "[+] comments collapsed"}</a>
        </div>
        <ul class="comment-children" style={{ display: (yield* open) ? "block" : "none" }}>
          {yield* props.children}
        </ul>
      </>
    );
  };
});

export default Toggle;
