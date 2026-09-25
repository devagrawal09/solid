import type { EventBlock } from "solid-js";
import { Button } from "./Button";

export function Toolbar(props: { onSave: EventBlock<MouseEvent> }) {
  return <Button onPress={props.onSave} label="Save" />;
}
