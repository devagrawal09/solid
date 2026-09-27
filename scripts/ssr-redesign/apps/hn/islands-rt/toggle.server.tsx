// P1-rt, server: stand-in for what a compiler would emit at the Toggle call
// site once the block graph proves Story and Comment inert (see
// analyze.mjs): the page renders in a NoHydration zone (no hydration keys,
// nothing serialized), and each Toggle instance is an island — a
// `<solid-island>` wrapper (display: contents) that re-enters hydration with
// its own id namespace. Its children (the reply list) stay inert server HTML.
//
// Toggle's body is copied verbatim from examples/hackernews-spa (this module
// replaces toggle.tsx in the build, so it cannot import it).
import { createSignal, Hydration, NoHydration } from "solid-js";

function Toggle(props: { children: any }) {
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

let n = 0;
export default function ToggleIsland(props: { children: any }) {
  const id = `t${n++}-`;
  return (
    <solid-island data-rid={id} style="display:contents">
      <Hydration id={id}>
        <Toggle>
          <NoHydration>{props.children}</NoHydration>
        </Toggle>
      </Hydration>
    </solid-island>
  );
}
