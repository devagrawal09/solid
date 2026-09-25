import type { EventBlock } from "solid-js";

export function Button(props: { onPress: EventBlock<MouseEvent>; label: string }) {
  return <button onClick={props.onPress}>{props.label}</button>;
}
