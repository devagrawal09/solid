// v2 twin note: kept a plain component. It fills the server components' `toggle`
// slot; as a `$component` (as in ../../../hackernews-spa-blocks) it works, but
// the fills of a document-rendered thread are rendered anew on the client
// instead of adopting the server markup (their `style` attributes come back
// re-serialized, `display: block;` for `display:block`). See the README.
import { createSignal } from "solid-js";

export default function Toggle(props: { children: any }) {
  const [open, setOpen] = createSignal(true);

  return (
    <>
      <div class={["toggle", { open: open() }]}>
        <a onClick={() => setOpen(o => !o)}>{open() ? "[-]" : "[+] comments collapsed"}</a>
      </div>
      <ul class="comment-children" style={{ display: open() ? "block" : "none" }}>
        {props.children}
      </ul>
    </>
  );
}
