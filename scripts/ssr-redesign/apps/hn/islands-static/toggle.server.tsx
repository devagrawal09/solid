// P1-static, server: Toggle as a compiler would render an island instance
// whose code is resumed rather than hydrated. The only addition to the
// markup is the island anchor `data-i` on the instance's first element; the
// rest of the instance is addressed statically from it (the template is
// known). Its state needs no serialization: `createSignal(true)` has a
// constant initializer, so the client can rebuild it.
//
// Toggle's body is copied from examples/hackernews-spa (this module replaces
// toggle.tsx in the build).
import { createSignal } from "solid-js";

export default function Toggle(props: { children: any }) {
  const [open, setOpen] = createSignal(true);

  return (
    <>
      <div data-i="t" class={["toggle", { open: open() }]}>
        <a onClick={() => setOpen(o => !o)}>{open() ? "[-]" : "[+] comments collapsed"}</a>
      </div>
      <ul class="comment-children" style={{ display: open() ? "block" : "none" }}>
        {props.children}
      </ul>
    </>
  );
}
