// The one component that owns state: the same Toggle as ../../../hackernews,
// written as a generator block. The compiler makes it a tier-0 island (its
// cell, its handler, three live holes); inside a story's frame its anchor is
// keyed by the comment it collapses, so its state survives a refetch.
import { $component, $event, $signal, type Element } from "solid-js";

const Toggle = $component(function* (props: { children: Element }) {
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
          {props.children}
        </ul>
      </>
    );
  };
});

export default Toggle;
