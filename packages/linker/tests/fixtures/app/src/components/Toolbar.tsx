import type { EventBlock } from "solid-js";
import { Button } from "./Button";

// Forwards its prop to a component that binds it to a DOM event.
export function Toolbar(props: { onSave: EventBlock<MouseEvent> }) {
  return <Button id="save" onPress={props.onSave} label="Save" />;
}
