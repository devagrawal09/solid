import { $component, $event, $signal, type TypedProps } from "solid-js";
import type { JSX } from "@solidjs/web";

const Toggle = $component(function* (props: TypedProps<{ children: JSX.Element }>) {
  const [open, setOpen] = yield* $signal(true);
  const toggle = $event(function* () {
    yield* setOpen(o => !o);
  });

  return function* () {
    return (
      <>
        <div class={["toggle", { open: yield* open }]}>
          <a onClick={toggle}>{(yield* open) ? "[-]" : "[+] comments collapsed"}</a>
        </div>
        <ul class="comment-children" style={{ display: (yield* open) ? "block" : "none" }}>
          {props.children}
        </ul>
      </>
    );
  };
});

export default Toggle;
