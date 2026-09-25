import type { EventBlock } from "solid-js";

export function Button(props: { onPress: EventBlock<MouseEvent>; label: string; id?: string }) {
  return (
    <button id={props.id} onClick={props.onPress}>
      {props.label}
    </button>
  );
}
