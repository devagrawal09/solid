import { $, Errored, Loading, type EventBlock } from "solid-js";
import { Button } from "./Button";
import { save } from "./actions";

export function Toolbar(props: { onSave: EventBlock<MouseEvent>; label: string }) {
  return (
    <Errored fallback={err => <button onClick={props.onSave}>retry</button>}>
      <Loading>
        <Button onPress={props.onSave} label={props.label} />
        <button onClick={save}>save</button>
      </Loading>
    </Errored>
  );
}

export function Spread(props: { onPress: EventBlock<MouseEvent> }) {
  return <button {...props} />;
}

export function Destructured({ onPress }: { onPress: EventBlock<MouseEvent> }) {
  return <button onClick={onPress} />;
}

export const exported = $(function* (_e: MouseEvent) {});
